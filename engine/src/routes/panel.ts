import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Context } from "hono";

import { GITHUB_APP_ENABLED } from "../config.js";
import { getDb, nowIso } from "../db.js";
import { appSlug, getUserAccessToken, userOctokit } from "../github/app.js";
import { getSessionUser, SESSION_COOKIE, type SessionUser } from "../session.js";

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

    for (const r of ghRepos) {
      const dbRepo = db.prepare("SELECT protected_at FROM repos WHERE id = ?").get(r.id) as
        | { protected_at: string | null }
        | undefined;
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
            }
          : null,
      });
    }
  }

  return c.json({ repos });
});
