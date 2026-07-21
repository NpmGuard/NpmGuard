import { assertAuditBudget, consumeAuditBudget } from "../caps.js";
import { getDb, nowIso } from "../db.js";
import { installationOctokit } from "../github/app.js";
import { concludeCheckRun } from "../github/checks.js";
import { fetchLockfile, fetchManifest } from "../github/content.js";
import { enqueueAuditJobs } from "../jobs/queue.js";
import {
  manifestRanges,
  parseLockfile,
  type LockfileDep,
} from "../lockfile/index.js";
import type { RepoRow } from "../routes/panel.js";
import { getVerdict, verdictSeverity } from "../verdict-index.js";
import { syncWatchedPackages } from "../watch/poller.js";

// Repo-scan orchestrator (spec §3 data flow): fetch lockfile → parse → diff →
// cache-first enqueue → rollup. Two shapes:
//   fullRepoScan  — manual / reconcile / default-branch push: replaces the
//                   repo_deps index and scans everything not yet audited
//   deltaRepoScan — push to any branch: scans only pairs NEW vs the index,
//                   posts a GitHub check, touches the index only on the
//                   default branch
// Progress computes from scan_items (never repo_deps — spec migration note).

export class LockfileNotFoundError extends Error {
  constructor() {
    super(
      "No supported lockfile found — commit package-lock.json, pnpm-lock.yaml, or yarn.lock at the repo root",
    );
    this.name = "LockfileNotFoundError";
  }
}

interface ParsedRepoDeps {
  deps: LockfileDep[];
  lockfilePath: string;
  lockfileSha: string;
}

async function fetchAndParse(repo: RepoRow, ref?: string): Promise<ParsedRepoDeps> {
  const octo = await installationOctokit(repo.installation_id);
  const lockfile = await fetchLockfile(octo, repo.owner, repo.name, ref);
  if (!lockfile) {
    const checkedAt = nowIso();
    getDb()
      .prepare(
        `UPDATE repos
         SET lockfile_path = NULL, lockfile_sha = NULL, auditability_checked_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(checkedAt, checkedAt, repo.id);
    throw new LockfileNotFoundError();
  }
  const manifest = await fetchManifest(octo, repo.owner, repo.name, ref);
  const deps = parseLockfile(lockfile.path, lockfile.content, manifestRanges(manifest));
  return { deps, lockfilePath: lockfile.path, lockfileSha: lockfile.sha };
}

function orgOf(repo: RepoRow): string {
  const row = getDb()
    .prepare("SELECT account_login FROM installations WHERE id = ?")
    .get(repo.installation_id) as { account_login: string } | undefined;
  return row?.account_login ?? repo.owner;
}

function replaceRepoDeps(repo: RepoRow, parsed: ParsedRepoDeps): void {
  const db = getDb();
  const insert = db.prepare(
    "INSERT OR REPLACE INTO repo_deps (repo_id, name, version, direct, range) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    db.prepare("DELETE FROM repo_deps WHERE repo_id = ?").run(repo.id);
    for (const dep of parsed.deps) {
      insert.run(repo.id, dep.name, dep.version, dep.direct ? 1 : 0, dep.range);
    }
    db.prepare(
      `UPDATE repos
       SET lockfile_path = ?, lockfile_sha = ?, auditability_checked_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(parsed.lockfilePath, parsed.lockfileSha, nowIso(), nowIso(), repo.id);
  })();
}

/**
 * Create the scan row + items, enqueue cache misses (budget-checked), kick
 * progress. Returns the scan id. `deps` is the item set this scan covers.
 */
function createScan(
  repo: RepoRow,
  trigger: "manual" | "push" | "reconcile",
  deps: LockfileDep[],
  opts: { commitSha?: string; checkRunId?: number | null } = {},
): number {
  const db = getDb();
  const org = orgOf(repo);

  const misses = deps.filter((d) => !getVerdict(d.name, d.version));
  assertAuditBudget(repo.installation_id, misses.length);

  let scanId = 0;
  db.transaction(() => {
    scanId = Number(
      db
        .prepare(
          `INSERT INTO scans (repo_id, trigger_kind, commit_sha, status, total, cached, check_run_id)
           VALUES (?, ?, ?, 'running', ?, ?, ?)`,
        )
        .run(
          repo.id,
          trigger,
          opts.commitSha ?? null,
          deps.length,
          deps.length - misses.length,
          opts.checkRunId ?? null,
        ).lastInsertRowid,
    );
    const insertItem = db.prepare(
      "INSERT OR IGNORE INTO scan_items (scan_id, name, version, cached) VALUES (?, ?, ?, ?)",
    );
    for (const dep of deps) {
      insertItem.run(scanId, dep.name, dep.version, getVerdict(dep.name, dep.version) ? 1 : 0);
    }
  })();

  const inserted = enqueueAuditJobs(
    misses.map((d) => ({ packageName: d.name, version: d.version, org, scanId })),
  );
  consumeAuditBudget(repo.installation_id, inserted);

  refreshScanProgress(scanId);
  return scanId;
}

/** Manual audit / reconcile / resync: full index replace + full-coverage scan. */
export async function fullRepoScan(
  repo: RepoRow,
  trigger: "manual" | "push" | "reconcile",
  opts: { ref?: string; commitSha?: string; checkRunId?: number | null } = {},
): Promise<number> {
  const parsed = await fetchAndParse(repo, opts.ref);
  const scanId = createScan(repo, trigger, parsed.deps, opts);
  replaceRepoDeps(repo, parsed);
  if (repo.protected_at) syncWatchedPackages();
  return scanId;
}

/**
 * Push-triggered delta: audit only (pkg, version) pairs not already in the
 * index. On the default branch the index is refreshed afterwards (the push
 * IS the new truth); on other branches the index is deliberately untouched —
 * a PR branch must not redefine what the repo runs in production.
 */
export async function deltaRepoScan(
  repo: RepoRow,
  ref: string,
  headSha: string,
  checkRunId: number | null,
): Promise<number> {
  const parsed = await fetchAndParse(repo, headSha);
  const db = getDb();
  const known = new Set(
    (
      db.prepare("SELECT name, version FROM repo_deps WHERE repo_id = ?").all(repo.id) as Array<{
        name: string;
        version: string;
      }>
    ).map((r) => `${r.name}@${r.version}`),
  );
  const delta = parsed.deps.filter((d) => !known.has(`${d.name}@${d.version}`));

  const scanId = createScan(repo, "push", delta, { commitSha: headSha, checkRunId });

  if (ref === repo.default_branch) {
    replaceRepoDeps(repo, parsed);
    if (repo.protected_at) syncWatchedPackages();
  }
  return scanId;
}

// ---------------------------------------------------------------------------
// Progress + rollup
// ---------------------------------------------------------------------------

interface ScanRow {
  id: number;
  repo_id: number;
  status: string;
  cached: number;
  check_run_id: number | null;
  commit_sha: string | null;
}

interface ItemState {
  name: string;
  version: string;
  cached: number;
  verdict: string | null;
  verdict_reason: string | null;
  evidence_count: number | null;
  active: number;
}

function scanItemStates(scanId: number): ItemState[] {
  return getDb()
    .prepare(
      `SELECT si.name, si.version, si.cached, pv.verdict,
              pv.reason AS verdict_reason, pv.evidence_count,
              EXISTS(
                SELECT 1 FROM jobs j
                WHERE j.package_name = si.name AND j.version = si.version
                  AND j.state IN ('queued', 'running')
              ) AS active
       FROM scan_items si
       LEFT JOIN package_verdicts pv ON pv.name = si.name AND pv.version = si.version
       WHERE si.scan_id = ?`,
    )
    .all(scanId) as ItemState[];
}

/** Recompute a running scan's counters; finalize + conclude its check when no
 *  item has an active job left. Safe to call at any time. */
export function refreshScanProgress(scanId: number): void {
  const db = getDb();
  const scan = db.prepare("SELECT * FROM scans WHERE id = ?").get(scanId) as ScanRow | undefined;
  if (!scan || scan.status !== "running") return;

  const items = scanItemStates(scanId);
  const cached = items.filter((i) => i.cached === 1).length;
  // audited = resolved during this scan (had no verdict at scan creation)
  const auditedCount = items.filter((i) => i.verdict !== null && i.cached === 0).length;
  const activeCount = items.filter((i) => i.active === 1).length;
  const failedCount = items.filter((i) => i.verdict === null && i.active === 0).length;

  if (activeCount > 0) {
    db.prepare("UPDATE scans SET total = ?, cached = ?, audited = ?, failed = ? WHERE id = ?").run(
      items.length,
      cached,
      auditedCount,
      failedCount,
      scanId,
    );
    return;
  }

  db.prepare(
    `UPDATE scans SET status = 'done', total = ?, cached = ?, audited = ?, failed = ?, finished_at = ?
     WHERE id = ?`,
  ).run(items.length, cached, auditedCount, failedCount, nowIso(), scanId);
  console.log(
    `[scan] #${scanId} done — ${items.length} items (${cached} cached, ${auditedCount} audited, ${failedCount} unresolved)`,
  );

  if (scan.check_run_id) {
    void concludeScanCheck(scan, items).catch((err) =>
      console.error("[scan] check conclusion failed:", err instanceof Error ? err.message : err),
    );
  }
}

/** Check policy (spec §5.10): fail ONLY on DANGEROUS; SUSPECT warns but
 *  passes; unresolved items are noted, never blocking. */
async function concludeScanCheck(scan: ScanRow, items: ItemState[]): Promise<void> {
  const repo = getDb().prepare("SELECT * FROM repos WHERE id = ?").get(scan.repo_id) as
    | RepoRow
    | undefined;
  if (!repo || !scan.check_run_id) return;

  const dangerous = items.filter((i) => i.verdict === "DANGEROUS");
  const suspect = items.filter((i) => i.verdict === "SUSPECT");
  const unresolved = items.filter((i) => i.verdict === null);
  const conclusion = dangerous.length > 0 ? "failure" : "success";

  const lines: string[] = [];
  if (items.length === 0) {
    lines.push("No new dependencies introduced by this push.");
  } else {
    lines.push(`${items.length} new dependencies checked.`);
    for (const i of dangerous) {
      lines.push(
        `- ❌ **${i.name}@${i.version}** — DANGEROUS: ${i.verdict_reason || "reproducible exploit evidence recorded"}`,
      );
    }
    for (const i of suspect) {
      lines.push(
        `- ⚠️ ${i.name}@${i.version} — SUSPECT (non-blocking): ${i.verdict_reason || "actionable signal requires sandbox reproduction"}`,
      );
    }
    if (unresolved.length > 0) {
      lines.push(`- ${unresolved.length} could not be audited (non-blocking)`);
    }
    if (dangerous.length === 0 && suspect.length === 0) {
      lines.push("All audited dependencies are SAFE.");
    }
  }

  await concludeCheckRun(repo.installation_id, repo.owner, repo.name, scan.check_run_id, {
    conclusion,
    title:
      conclusion === "failure"
        ? `${dangerous.length} DANGEROUS dependenc${dangerous.length === 1 ? "y" : "ies"}`
        : "No dangerous dependencies",
    summary: lines.join("\n"),
  });
}

/** Called by job workers after every job settles — nudges every running scan
 *  that covers this (pkg, version). Cross-scan job sharing makes this the
 *  only reliable completion signal. */
export function refreshScansTouching(packageName: string, version: string): void {
  const scans = getDb()
    .prepare(
      `SELECT DISTINCT s.id FROM scans s
       JOIN scan_items si ON si.scan_id = s.id
       WHERE s.status = 'running' AND si.name = ? AND si.version = ?`,
    )
    .all(packageName, version) as Array<{ id: number }>;
  for (const s of scans) refreshScanProgress(s.id);
}

export interface RepoRollup {
  verdict: string | null;
  dangerous: number;
  suspect: number;
  unknown: number;
  safe: number;
}

/** Worst-dep-wins rollup over the repo's dep index (spec decision 6).
 *  Unaudited deps count as unknown — a repo is never SAFE with pending deps. */
export function computeRollup(repoId: number): RepoRollup {
  const rows = getDb()
    .prepare(
      `SELECT pv.verdict AS verdict, COUNT(*) AS c
       FROM repo_deps rd
       LEFT JOIN package_verdicts pv ON pv.name = rd.name AND pv.version = rd.version
       WHERE rd.repo_id = ?
       GROUP BY pv.verdict`,
    )
    .all(repoId) as Array<{ verdict: string | null; c: number }>;

  const rollup: RepoRollup = { verdict: null, dangerous: 0, suspect: 0, unknown: 0, safe: 0 };
  let total = 0;
  for (const row of rows) {
    total += row.c;
    switch (row.verdict) {
      case "DANGEROUS":
        rollup.dangerous += row.c;
        break;
      case "SUSPECT":
        rollup.suspect += row.c;
        break;
      case "SAFE":
        rollup.safe += row.c;
        break;
      default:
        rollup.unknown += row.c; // includes NULL (unaudited) and UNKNOWN
    }
  }
  if (total === 0) return rollup;

  if (rollup.dangerous > 0) rollup.verdict = "DANGEROUS";
  else if (rollup.suspect > 0) rollup.verdict = "SUSPECT";
  else if (rollup.unknown > 0) rollup.verdict = "UNKNOWN";
  else rollup.verdict = "SAFE";
  return rollup;
}

// verdictSeverity is re-exported for the SSE handler's dep-event ordering
export { verdictSeverity };
