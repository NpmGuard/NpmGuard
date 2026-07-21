import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { Context } from "hono";
import type { Octokit } from "@octokit/rest";

import { assertProtectCap, CapExceededError } from "../caps.js";
import { GITHUB_APP_ENABLED } from "../config.js";
import { getDb, nowIso } from "../db.js";
import { appSlug, getUserAccessToken, userOctokit } from "../github/app.js";
import { findRootLockfile } from "../github/content.js";
import { UnsupportedLockfileError } from "../lockfile/index.js";
import {
  computeRollup,
  fullRepoScan,
  LockfileNotFoundError,
} from "../scan/repo-scan.js";
import { getSessionUser, SESSION_COOKIE, type SessionUser } from "../session.js";
import { syncWatchedPackages } from "../watch/poller.js";

// Panel API (spec §6). Everything here is session-gated and scoped to the
// GitHub App installations the user can access (org-shared view — spec
// decision 5). The user_installations cache is refreshed on /panel/orgs and
// /panel/repos; repo-level endpoints authorize against that cache.

export const panelRoutes = new Hono();

// ---------------------------------------------------------------------------
// Auth helpers — exported for reuse by scan/protect endpoints
// ---------------------------------------------------------------------------

export function requireUser(c: Context): SessionUser | null {
  return getSessionUser(getCookie(c, SESSION_COOKIE));
}

export function userHasInstallation(userId: number, installationId: number): boolean {
  return !!getDb()
    .prepare(
      "SELECT 1 FROM user_installations WHERE user_id = ? AND installation_id = ?",
    )
    .get(userId, installationId);
}

/** Returns the repo row iff the user can access its installation, else null. */
export function authorizedRepo(userId: number, repoId: number): RepoRow | null {
  const repo = getDb()
    .prepare("SELECT * FROM repos WHERE id = ?")
    .get(repoId) as RepoRow | undefined;
  if (!repo) return null;
  return userHasInstallation(userId, repo.installation_id) ? repo : null;
}

export interface RepoRow {
  id: number;
  installation_id: number;
  owner: string;
  name: string;
  full_name: string;
  private: number;
  default_branch: string;
  protected_at: string | null;
  lockfile_path: string | null;
  lockfile_sha: string | null;
  auditability_checked_at: string | null;
}

const AUDITABILITY_CACHE_MS = 24 * 60 * 60 * 1_000;
const AUDITABILITY_PROBE_CONCURRENCY = 8;

interface GitHubRepoSummary {
  id: number;
  owner: { login: string };
  name: string;
  full_name: string;
  private: boolean;
  default_branch?: string | null;
}

interface RepoAuditabilityRow {
  lockfile_path: string | null;
  auditability_checked_at: string | null;
}

function auditabilityIsFresh(checkedAt: string | null): boolean {
  if (!checkedAt) return false;
  const checkedTime = Date.parse(checkedAt);
  return Number.isFinite(checkedTime) && Date.now() - checkedTime < AUDITABILITY_CACHE_MS;
}

async function refreshRepoAuditability(
  octo: Octokit,
  ghRepos: readonly GitHubRepoSummary[],
): Promise<void> {
  const db = getDb();
  const selectState = db.prepare(
    "SELECT lockfile_path, auditability_checked_at FROM repos WHERE id = ?",
  );
  const updateState = db.prepare(
    `UPDATE repos
     SET lockfile_path = ?, lockfile_sha = ?, auditability_checked_at = ?, updated_at = ?
     WHERE id = ?`,
  );
  const pending = ghRepos.filter((repo) => {
    const row = selectState.get(repo.id) as RepoAuditabilityRow | undefined;
    return !auditabilityIsFresh(row?.auditability_checked_at ?? null);
  });

  for (let offset = 0; offset < pending.length; offset += AUDITABILITY_PROBE_CONCURRENCY) {
    const chunk = pending.slice(offset, offset + AUDITABILITY_PROBE_CONCURRENCY);
    await Promise.all(
      chunk.map(async (repo) => {
        try {
          const lockfile = await findRootLockfile(
            octo,
            repo.owner.login,
            repo.name,
            repo.default_branch ?? "main",
          );
          const checkedAt = nowIso();
          updateState.run(
            lockfile?.path ?? null,
            lockfile?.sha ?? null,
            checkedAt,
            checkedAt,
            repo.id,
          );
        } catch (err) {
          // Keep the previous cached state on transient GitHub failures.
          console.warn(
            `[panel] auditability probe failed for ${repo.full_name}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }),
    );
  }
}

// GitHub's installation "account" can be a user, org, or enterprise shape.
function accountInfo(account: unknown): { login: string; type: string } {
  const a = account as { login?: string; slug?: string; type?: string } | null;
  return { login: a?.login ?? a?.slug ?? "unknown", type: a?.type ?? "Organization" };
}

// ---------------------------------------------------------------------------
// GET /panel/orgs — the user's installations + the install-app link
// ---------------------------------------------------------------------------

panelRoutes.get("/panel/orgs", async (c) => {
  if (!GITHUB_APP_ENABLED) {
    return c.json({ error: "GitHub App is not configured on this server" }, 503);
  }
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const token = await getUserAccessToken(user.id);
  if (!token) {
    return c.json({ error: "GitHub authorization expired — sign in again", reauth: true }, 401);
  }

  try {
    const octo = userOctokit(token);
    const installations = await octo.paginate(
      octo.rest.apps.listInstallationsForAuthenticatedUser,
      { per_page: 100 },
    );

    const db = getDb();
    const upsertInst = db.prepare(
      `INSERT INTO installations (id, account_login, account_type, suspended, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_login = excluded.account_login,
         account_type = excluded.account_type,
         suspended = excluded.suspended,
         updated_at = excluded.updated_at`,
    );
    const insertUserInst = db.prepare(
      "INSERT INTO user_installations (user_id, installation_id, refreshed_at) VALUES (?, ?, ?)",
    );
    db.transaction(() => {
      db.prepare("DELETE FROM user_installations WHERE user_id = ?").run(user.id);
      for (const inst of installations) {
        const account = accountInfo(inst.account);
        upsertInst.run(inst.id, account.login, account.type, inst.suspended_at ? 1 : 0, nowIso());
        insertUserInst.run(user.id, inst.id, nowIso());
      }
    })();

    return c.json({
      installations: installations.map((inst) => {
        const account = accountInfo(inst.account);
        return {
          id: inst.id,
          accountLogin: account.login,
          accountType: account.type,
          suspended: !!inst.suspended_at,
        };
      }),
      installUrl: `https://github.com/apps/${await appSlug()}/installations/new`,
    });
  } catch (err) {
    console.error("[panel] orgs fetch failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Failed to list GitHub installations" }, 502);
  }
});

// ---------------------------------------------------------------------------
// GET /panel/repos — repos across the user's installations, live-fetched from
// GitHub and mirrored into the DB (protect/scan state joins from there)
// ---------------------------------------------------------------------------

interface LastScanRow {
  id: number;
  status: string;
  trigger_kind: string;
  total: number;
  cached: number;
  audited: number;
  failed: number;
  started_at: string;
  finished_at: string | null;
}

panelRoutes.get("/panel/repos", async (c) => {
  if (!GITHUB_APP_ENABLED) {
    return c.json({ error: "GitHub App is not configured on this server" }, 503);
  }
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const token = await getUserAccessToken(user.id);
  if (!token) {
    return c.json({ error: "GitHub authorization expired — sign in again", reauth: true }, 401);
  }

  const db = getDb();
  const installationIds = (
    db
      .prepare("SELECT installation_id FROM user_installations WHERE user_id = ?")
      .all(user.id) as Array<{ installation_id: number }>
  ).map((r) => r.installation_id);

  const octo = userOctokit(token);
  const upsertRepo = db.prepare(
    `INSERT INTO repos (id, installation_id, owner, name, full_name, private, default_branch, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       installation_id = excluded.installation_id,
       owner = excluded.owner,
       name = excluded.name,
       full_name = excluded.full_name,
       private = excluded.private,
       lockfile_path = CASE
         WHEN repos.default_branch <> excluded.default_branch THEN NULL
         ELSE repos.lockfile_path
       END,
       lockfile_sha = CASE
         WHEN repos.default_branch <> excluded.default_branch THEN NULL
         ELSE repos.lockfile_sha
       END,
       auditability_checked_at = CASE
         WHEN repos.default_branch <> excluded.default_branch THEN NULL
         ELSE repos.auditability_checked_at
       END,
       default_branch = excluded.default_branch,
       updated_at = excluded.updated_at`,
  );
  const lastScanStmt = db.prepare(
    `SELECT id, status, trigger_kind, total, cached, audited, failed, started_at, finished_at
     FROM scans WHERE repo_id = ? ORDER BY started_at DESC LIMIT 1`,
  );

  const repos: unknown[] = [];
  for (const installationId of installationIds) {
    let ghRepos;
    try {
      ghRepos = await octo.paginate(octo.rest.apps.listInstallationReposForAuthenticatedUser, {
        installation_id: installationId,
        per_page: 100,
      });
    } catch (err) {
      console.warn(
        `[panel] repo list failed for installation ${installationId}:`,
        err instanceof Error ? err.message : err,
      );
      continue; // skip prune on failure — never drop rows on a flaky fetch
    }

    db.transaction(() => {
      for (const r of ghRepos) {
        upsertRepo.run(
          r.id,
          installationId,
          r.owner.login,
          r.name,
          r.full_name,
          r.private ? 1 : 0,
          r.default_branch ?? "main",
          nowIso(),
        );
      }
      // Prune repos that left this installation (only after a full fetch)
      const keep = new Set(ghRepos.map((r) => r.id));
      const existing = db
        .prepare("SELECT id FROM repos WHERE installation_id = ?")
        .all(installationId) as Array<{ id: number }>;
      const del = db.prepare("DELETE FROM repos WHERE id = ?");
      for (const row of existing) {
        if (!keep.has(row.id)) del.run(row.id);
      }
    })();

    await refreshRepoAuditability(octo, ghRepos);

    for (const r of ghRepos) {
      const dbRepo = db
        .prepare(
          "SELECT protected_at, lockfile_path, auditability_checked_at FROM repos WHERE id = ?",
        )
        .get(r.id) as
        | {
            protected_at: string | null;
            lockfile_path: string | null;
            auditability_checked_at: string | null;
          }
        | undefined;
      if (dbRepo?.auditability_checked_at && !dbRepo.lockfile_path) continue;

      const lastScan = lastScanStmt.get(r.id) as LastScanRow | undefined;
      repos.push({
        id: r.id,
        installationId,
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch ?? "main",
        protected: !!dbRepo?.protected_at,
        lastScan: lastScan
          ? {
              id: lastScan.id,
              status: lastScan.status,
              trigger: lastScan.trigger_kind,
              total: lastScan.total,
              cached: lastScan.cached,
              audited: lastScan.audited,
              failed: lastScan.failed,
              startedAt: lastScan.started_at,
              finishedAt: lastScan.finished_at,
              verdict: lastScan.status === "done" ? computeRollup(r.id).verdict : null,
            }
          : null,
      });
    }
  }

  return c.json({ repos });
});

// ---------------------------------------------------------------------------
// Scan / Protect / Re-sync actions
// ---------------------------------------------------------------------------

function scanErrorResponse(c: Context, err: unknown) {
  if (err instanceof CapExceededError) {
    return c.json({
      error: err.message,
      cap: true,
      resource: err.resource,
      installationId: err.installationId,
      entitlements: err.entitlements,
    }, 402);
  }
  if (err instanceof LockfileNotFoundError || err instanceof UnsupportedLockfileError) {
    return c.json({ error: err.message }, 422);
  }
  console.error("[panel] scan failed:", err instanceof Error ? err.message : err);
  return c.json({ error: "Scan failed — see engine logs" }, 502);
}

panelRoutes.post("/panel/repo/:id/scan", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const repo = authorizedRepo(user.id, Number(c.req.param("id")));
  if (!repo) return c.json({ error: "Repo not found" }, 404);

  const running = getDb()
    .prepare("SELECT id FROM scans WHERE repo_id = ? AND status = 'running' LIMIT 1")
    .get(repo.id) as { id: number } | undefined;
  if (running) return c.json({ error: "A scan is already running", scanId: running.id }, 409);

  try {
    const scanId = await fullRepoScan(repo, "manual");
    return c.json({ scanId });
  } catch (err) {
    return scanErrorResponse(c, err);
  }
});

panelRoutes.post("/panel/repo/:id/protect", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const repo = authorizedRepo(user.id, Number(c.req.param("id")));
  if (!repo) return c.json({ error: "Repo not found" }, 404);

  const db = getDb();
  if (!repo.protected_at) {
    try {
      assertProtectCap(repo.installation_id);
    } catch (err) {
      if (err instanceof CapExceededError) {
        return c.json({
          error: err.message,
          cap: true,
          resource: err.resource,
          installationId: err.installationId,
          entitlements: err.entitlements,
        }, 402);
      }
      throw err;
    }
    db.prepare("UPDATE repos SET protected_at = ?, updated_at = ? WHERE id = ?").run(
      nowIso(),
      nowIso(),
      repo.id,
    );
    syncWatchedPackages();

    // Protection needs a dep index to watch — build it if this repo was
    // never scanned. Background: the toggle should respond instantly.
    const hasDeps = db
      .prepare("SELECT 1 FROM repo_deps WHERE repo_id = ? LIMIT 1")
      .get(repo.id);
    if (!hasDeps) {
      void fullRepoScan({ ...repo, protected_at: nowIso() }, "manual").catch((err) =>
        console.warn(
          `[panel] initial protect scan for ${repo.full_name} failed:`,
          err instanceof Error ? err.message : err,
        ),
      );
    }
  }
  return c.json({ ok: true });
});

panelRoutes.delete("/panel/repo/:id/protect", (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const repo = authorizedRepo(user.id, Number(c.req.param("id")));
  if (!repo) return c.json({ error: "Repo not found" }, 404);

  getDb()
    .prepare("UPDATE repos SET protected_at = NULL, updated_at = ? WHERE id = ?")
    .run(nowIso(), repo.id);
  syncWatchedPackages();
  return c.json({ ok: true });
});

panelRoutes.post("/panel/repo/:id/resync", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);
  const repo = authorizedRepo(user.id, Number(c.req.param("id")));
  if (!repo) return c.json({ error: "Repo not found" }, 404);

  try {
    const scanId = await fullRepoScan(repo, "reconcile");
    return c.json({ scanId });
  } catch (err) {
    return scanErrorResponse(c, err);
  }
});

// ---------------------------------------------------------------------------
// Repo detail — rollup + dep table + latest scan + alerts
// ---------------------------------------------------------------------------

interface DepDetailRow {
  name: string;
  version: string;
  direct: number;
  range: string | null;
  verdict: string | null;
  verdict_reason: string | null;
  evidence_count: number | null;
  audited_at: string | null;
  active_state: string | null;
  has_failed: number | null;
}

panelRoutes.get("/panel/repo/:owner/:name", (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const db = getDb();
  const fullName = `${c.req.param("owner")}/${c.req.param("name")}`;
  const repoRow = db.prepare("SELECT * FROM repos WHERE full_name = ?").get(fullName) as
    | RepoRow
    | undefined;
  if (!repoRow || !userHasInstallation(user.id, repoRow.installation_id)) {
    return c.json({ error: "Repo not found" }, 404);
  }

  const deps = db
    .prepare(
      `SELECT rd.name, rd.version, rd.direct, rd.range,
              pv.verdict, pv.reason AS verdict_reason,
              pv.evidence_count, pv.audited_at,
              (SELECT j.state FROM jobs j
               WHERE j.package_name = rd.name AND j.version = rd.version
                 AND j.state IN ('queued', 'running')
               LIMIT 1) AS active_state,
              (SELECT 1 FROM jobs j
               WHERE j.package_name = rd.name AND j.version = rd.version
                 AND j.state = 'failed'
               LIMIT 1) AS has_failed
       FROM repo_deps rd
       LEFT JOIN package_verdicts pv ON pv.name = rd.name AND pv.version = rd.version
       WHERE rd.repo_id = ?
       ORDER BY rd.direct DESC, rd.name, rd.version`,
    )
    .all(repoRow.id) as DepDetailRow[];

  const lastScan = db
    .prepare(
      `SELECT id, status, trigger_kind, total, cached, audited, failed, started_at, finished_at
       FROM scans WHERE repo_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(repoRow.id) as LastScanRow | undefined;

  const alerts = db
    .prepare("SELECT * FROM alerts WHERE repo_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(repoRow.id) as Array<Record<string, unknown>>;

  const rollup = computeRollup(repoRow.id);

  return c.json({
    repo: {
      id: repoRow.id,
      installationId: repoRow.installation_id,
      owner: repoRow.owner,
      name: repoRow.name,
      fullName: repoRow.full_name,
      private: !!repoRow.private,
      defaultBranch: repoRow.default_branch,
      protected: !!repoRow.protected_at,
      lastScan: null,
    },
    deps: deps.map((d) => ({
      name: d.name,
      version: d.version,
      direct: !!d.direct,
      range: d.range,
      verdict: d.verdict,
      verdictReason: d.verdict_reason,
      evidenceCount: d.evidence_count ?? 0,
      auditedAt: d.audited_at,
      jobState: d.active_state ?? (d.has_failed && !d.verdict ? "failed" : null),
    })),
    rollup,
    scan: lastScan
      ? {
          id: lastScan.id,
          status: lastScan.status,
          trigger: lastScan.trigger_kind,
          total: lastScan.total,
          cached: lastScan.cached,
          audited: lastScan.audited,
          failed: lastScan.failed,
          startedAt: lastScan.started_at,
          finishedAt: lastScan.finished_at,
          verdict: lastScan.status === "done" ? rollup.verdict : null,
        }
      : null,
    alerts: alerts.map((a) => ({
      id: a.id,
      org: a.org,
      repoId: a.repo_id,
      packageName: a.package_name,
      version: a.version,
      verdict: a.verdict,
      kind: a.kind,
      message: a.message,
      seen: !!a.seen,
      createdAt: a.created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// Scan progress SSE — 1.5s DB snapshots, dep-level diffs (spec §6 panel.ts)
// ---------------------------------------------------------------------------

const SSE_TICK_MS = 1500;

panelRoutes.get("/panel/scan/:scanId/events", (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const db = getDb();
  const scanId = Number(c.req.param("scanId"));
  const scanRepo = db
    .prepare("SELECT s.repo_id FROM scans s WHERE s.id = ?")
    .get(scanId) as { repo_id: number } | undefined;
  if (!scanRepo || !authorizedRepo(user.id, scanRepo.repo_id)) {
    return c.json({ error: "Scan not found" }, 404);
  }

  const itemsStmt = db.prepare(
    `SELECT si.name, si.version, pv.verdict,
            pv.reason AS verdict_reason, pv.evidence_count,
            (SELECT j.state FROM jobs j
             WHERE j.package_name = si.name AND j.version = si.version
               AND j.state IN ('queued', 'running')
             LIMIT 1) AS active_state,
            (SELECT 1 FROM jobs j
             WHERE j.package_name = si.name AND j.version = si.version AND j.state = 'failed'
             LIMIT 1) AS has_failed
     FROM scan_items si
     LEFT JOIN package_verdicts pv ON pv.name = si.name AND pv.version = si.version
     WHERE si.scan_id = ?`,
  );
  const scanStmt = db.prepare(
    "SELECT status, total, cached, audited, failed FROM scans WHERE id = ?",
  );

  return streamSSE(c, async (stream) => {
    const sent = new Map<string, string>(); // "name@version" → last verdict/jobState signature
    let id = 0;

    for (;;) {
      const scan = scanStmt.get(scanId) as
        | { status: string; total: number; cached: number; audited: number; failed: number }
        | undefined;
      if (!scan) break;

      const items = itemsStmt.all(scanId) as Array<{
        name: string;
        version: string;
        verdict: string | null;
        verdict_reason: string | null;
        evidence_count: number | null;
        active_state: string | null;
        has_failed: number | null;
      }>;

      for (const item of items) {
        const jobState =
          item.active_state ?? (item.has_failed && !item.verdict ? "failed" : null);
        const signature = `${item.verdict ?? ""}|${jobState ?? ""}`;
        const key = `${item.name}@${item.version}`;
        if (sent.get(key) === signature) continue;
        sent.set(key, signature);
        await stream.writeSSE({
          id: String(id++),
          data: JSON.stringify({
            type: "dep",
            name: item.name,
            version: item.version,
            verdict: item.verdict,
            verdictReason: item.verdict_reason,
            evidenceCount: item.evidence_count ?? 0,
            jobState,
          }),
        });
      }

      await stream.writeSSE({
        id: String(id++),
        data: JSON.stringify({
          type: "progress",
          status: scan.status,
          total: scan.total,
          cached: scan.cached,
          audited: scan.audited,
          failed: scan.failed,
        }),
      });

      if (scan.status !== "running") {
        await stream.writeSSE({ id: String(id++), data: JSON.stringify({ type: "done" }) });
        break;
      }
      await stream.sleep(SSE_TICK_MS);
    }
  });
});

// ---------------------------------------------------------------------------
// Alerts feed (dashboard) — across every org the user can access
// ---------------------------------------------------------------------------

panelRoutes.get("/panel/alerts", (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const alerts = getDb()
    .prepare(
      `SELECT a.* FROM alerts a
       WHERE a.org IN (
         SELECT i.account_login FROM installations i
         JOIN user_installations ui ON ui.installation_id = i.id
         WHERE ui.user_id = ?
       )
       ORDER BY a.created_at DESC LIMIT 50`,
    )
    .all(user.id) as Array<Record<string, unknown>>;

  return c.json({
    alerts: alerts.map((a) => ({
      id: a.id,
      org: a.org,
      repoId: a.repo_id,
      packageName: a.package_name,
      version: a.version,
      verdict: a.verdict,
      kind: a.kind,
      message: a.message,
      seen: !!a.seen,
      createdAt: a.created_at,
    })),
  });
});

panelRoutes.post("/panel/alerts/seen", (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  getDb()
    .prepare(
      `UPDATE alerts SET seen = 1
       WHERE seen = 0 AND org IN (
         SELECT i.account_login FROM installations i
         JOIN user_installations ui ON ui.installation_id = i.id
         WHERE ui.user_id = ?
       )`,
    )
    .run(user.id);
  return c.json({ ok: true });
});
