import { assertPublicRepoAuditCap } from "../caps.js";
import { anchorPendingCertificatesAfterScan } from "../certificate-anchor.js";
import { ensureAuditCertificate } from "../audit-persistence.js";
import { getDb, nowIso } from "../db.js";
import { enqueueAuditJobs } from "../jobs/queue.js";
import type { LockfileDep } from "../lockfile/index.js";
import { getVerdict } from "../verdict-index.js";

export interface PublicRepoReference {
  owner: string;
  repo: string;
  fullName: string;
}

export class InvalidPublicRepoReferenceError extends Error {
  constructor() {
    super("Enter a GitHub repository as owner/repo or https://github.com/owner/repo");
    this.name = "InvalidPublicRepoReferenceError";
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Accept only a GitHub repository identity, never an arbitrary fetch URL.
 * This is both the UX normalizer and the SSRF boundary for public audits.
 */
export function parsePublicRepoReference(input: string): PublicRepoReference {
  const value = input.trim();
  let path = value;

  if (/^github\.com\//i.test(path)) path = `https://${path}`;
  if (/^https?:\/\//i.test(path)) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      throw new InvalidPublicRepoReferenceError();
    }
    if (
      url.protocol !== "https:" ||
      url.hostname.toLowerCase() !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new InvalidPublicRepoReferenceError();
    }
    path = url.pathname.replace(/^\/+|\/+$/g, "");
  } else if (path.includes(":")) {
    throw new InvalidPublicRepoReferenceError();
  }

  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) throw new InvalidPublicRepoReferenceError();

  const owner = parts[0] ?? "";
  const repo = (parts[1] ?? "").replace(/\.git$/i, "");
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    throw new InvalidPublicRepoReferenceError();
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export interface CreatePublicRepoScanInput {
  installationId: number;
  requestedBy: number;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  commitSha: string | null;
  lockfilePath: string;
  lockfileSha: string;
  deps: LockfileDep[];
  accountLogin: string;
}

function uniqueDeps(deps: readonly LockfileDep[]): LockfileDep[] {
  return [...new Map(deps.map((dep) => [`${dep.name}\0${dep.version}`, dep])).values()];
}

export function findRunningPublicScan(
  installationId: number,
  fullName: string,
): { id: number } | null {
  return (
    (getDb()
      .prepare(
        `SELECT id FROM public_repo_scans
         WHERE installation_id = ? AND full_name = ? AND status = 'running'
         LIMIT 1`,
      )
      .get(installationId, fullName) as { id: number } | undefined) ?? null
  );
}

/** Create a read-only snapshot and enqueue only globally uncached work. */
export function createPublicRepoScan(input: CreatePublicRepoScanInput): number {
  const db = getDb();
  const deps = uniqueDeps(input.deps);
  const cachedKeys = new Set(
    deps.filter((dep) => getVerdict(dep.name, dep.version)).map((dep) => `${dep.name}\0${dep.version}`),
  );
  const misses = deps.filter((dep) => !cachedKeys.has(`${dep.name}\0${dep.version}`));

  let scanId = 0;
  db.transaction(() => {
    // A repository consumes one Free slot only once. The stable GitHub id
    // survives renames, and the transaction prevents concurrent new repos
    // from both claiming the final slot.
    assertPublicRepoAuditCap(input.installationId, input.githubRepoId);

    scanId = Number(
      db
        .prepare(
          `INSERT INTO public_repo_scans (
             installation_id, requested_by, github_repo_id, owner, name, full_name,
             html_url, default_branch, commit_sha, lockfile_path, lockfile_sha,
             status, total, cached
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          input.installationId,
          input.requestedBy,
          input.githubRepoId,
          input.owner,
          input.name,
          input.fullName,
          input.htmlUrl,
          input.defaultBranch,
          input.commitSha,
          input.lockfilePath,
          input.lockfileSha,
          deps.length,
          cachedKeys.size,
        ).lastInsertRowid,
    );

    const insertItem = db.prepare(
      `INSERT INTO public_repo_scan_items (scan_id, name, version, direct, range, cached)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const dep of deps) {
      insertItem.run(
        scanId,
        dep.name,
        dep.version,
        dep.direct ? 1 : 0,
        dep.range,
        cachedKeys.has(`${dep.name}\0${dep.version}`) ? 1 : 0,
      );
    }
  })();

  // Public snapshots do not own jobs: scan_id stays null so no installed repo,
  // check-run, or webhook relationship can be inferred for the target.
  enqueueAuditJobs(
    misses.map((dep) => ({
      packageName: dep.name,
      version: dep.version,
      org: input.accountLogin,
      scanId: null,
    })),
  );
  refreshPublicScanProgress(scanId);
  return scanId;
}

interface PublicScanItemState {
  name: string;
  version: string;
  cached: number;
  verdict: string | null;
  active: number;
}

function publicScanItemStates(scanId: number): PublicScanItemState[] {
  return getDb()
    .prepare(
      `SELECT psi.name, psi.version, psi.cached, pv.verdict,
              EXISTS(
                SELECT 1 FROM jobs j
                WHERE j.package_name = psi.name AND j.version = psi.version
                  AND j.state IN ('queued', 'running')
              ) AS active
       FROM public_repo_scan_items psi
       LEFT JOIN package_verdicts pv ON pv.name = psi.name AND pv.version = psi.version
       WHERE psi.scan_id = ?`,
    )
    .all(scanId) as PublicScanItemState[];
}

export function refreshPublicScanProgress(scanId: number): void {
  const db = getDb();
  const scan = db
    .prepare("SELECT status FROM public_repo_scans WHERE id = ?")
    .get(scanId) as { status: string } | undefined;
  if (!scan || scan.status !== "running") return;

  const items = publicScanItemStates(scanId);
  const cached = items.filter((item) => item.cached === 1).length;
  const audited = items.filter((item) => item.cached === 0 && item.verdict !== null).length;
  const active = items.filter((item) => item.active === 1).length;
  const failed = items.filter((item) => item.verdict === null && item.active === 0).length;

  if (active > 0) {
    db.prepare(
      `UPDATE public_repo_scans
       SET total = ?, cached = ?, audited = ?, failed = ? WHERE id = ?`,
    ).run(items.length, cached, audited, failed, scanId);
    return;
  }

  db.prepare(
    `UPDATE public_repo_scans
     SET status = 'done', total = ?, cached = ?, audited = ?, failed = ?, finished_at = ?
     WHERE id = ?`,
  ).run(items.length, cached, audited, failed, nowIso(), scanId);
  console.log(
    `[public-scan] #${scanId} done — ${items.length} items (${cached} cached, ${audited} audited, ${failed} unresolved)`,
  );

  let certificatesReady = 0;
  for (const item of items) {
    if (item.verdict === null) continue;
    if (ensureAuditCertificate(item.name, item.version)) {
      certificatesReady += 1;
    }
  }
  console.log(
    `[public-scan] #${scanId} prepared ${certificatesReady} certificate(s) for Merkle anchoring`,
  );
  anchorPendingCertificatesAfterScan();
}

export function refreshPublicScansTouching(packageName: string, version: string): void {
  const scans = getDb()
    .prepare(
      `SELECT DISTINCT prs.id FROM public_repo_scans prs
       JOIN public_repo_scan_items psi ON psi.scan_id = prs.id
       WHERE prs.status = 'running' AND psi.name = ? AND psi.version = ?`,
    )
    .all(packageName, version) as Array<{ id: number }>;
  for (const scan of scans) refreshPublicScanProgress(scan.id);
}

export interface PublicScanRollup {
  verdict: string | null;
  dangerous: number;
  suspect: number;
  unknown: number;
  safe: number;
}

export function computePublicScanRollup(scanId: number): PublicScanRollup {
  const rows = getDb()
    .prepare(
      `SELECT pv.verdict AS verdict, COUNT(*) AS c
       FROM public_repo_scan_items psi
       LEFT JOIN package_verdicts pv ON pv.name = psi.name AND pv.version = psi.version
       WHERE psi.scan_id = ?
       GROUP BY pv.verdict`,
    )
    .all(scanId) as Array<{ verdict: string | null; c: number }>;

  const rollup: PublicScanRollup = {
    verdict: null,
    dangerous: 0,
    suspect: 0,
    unknown: 0,
    safe: 0,
  };
  let total = 0;
  for (const row of rows) {
    total += row.c;
    if (row.verdict === "DANGEROUS") rollup.dangerous += row.c;
    else if (row.verdict === "SUSPECT") rollup.suspect += row.c;
    else if (row.verdict === "SAFE") rollup.safe += row.c;
    else rollup.unknown += row.c;
  }
  if (total === 0) return rollup;
  if (rollup.dangerous > 0) rollup.verdict = "DANGEROUS";
  else if (rollup.suspect > 0) rollup.verdict = "SUSPECT";
  else if (rollup.unknown > 0) rollup.verdict = "UNKNOWN";
  else rollup.verdict = "SAFE";
  return rollup;
}
