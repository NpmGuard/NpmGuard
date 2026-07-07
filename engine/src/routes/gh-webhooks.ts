import { verify } from "@octokit/webhooks-methods";
import { Hono } from "hono";

import { config, GITHUB_APP_ENABLED } from "../config.js";
import { getDb, nowIso } from "../db.js";
import { createCheckRun } from "../github/checks.js";
import { LOCKFILE_CANDIDATES } from "../lockfile/index.js";
import type { RepoRow } from "./panel.js";
import { deltaRepoScan, LockfileNotFoundError } from "../scan/repo-scan.js";
import { syncWatchedPackages } from "../watch/poller.js";

// GitHub App webhooks (spec §6, P3). Signature-verified against the raw body;
// handlers respond 202 fast and do the work async (GitHub's 10s delivery
// timeout). The push handler is what keeps repo_deps fresh — the substrate
// registry-watch alerts from.

export const ghWebhookRoutes = new Hono();

interface WebhookRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch?: string;
}

function upsertInstallation(installation: {
  id: number;
  account?: { login?: string; type?: string } | null;
  suspended_at?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO installations (id, account_login, account_type, suspended, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_login = excluded.account_login,
         account_type = excluded.account_type,
         suspended = excluded.suspended,
         updated_at = excluded.updated_at`,
    )
    .run(
      installation.id,
      installation.account?.login ?? "unknown",
      installation.account?.type ?? "Organization",
      installation.suspended_at ? 1 : 0,
      nowIso(),
    );
}

function upsertWebhookRepos(installationId: number, repos: WebhookRepository[]): void {
  const db = getDb();
  const upsert = db.prepare(
    `INSERT INTO repos (id, installation_id, owner, name, full_name, private, default_branch, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       installation_id = excluded.installation_id,
       owner = excluded.owner,
       name = excluded.name,
       full_name = excluded.full_name,
       private = excluded.private,
       updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const r of repos) {
      const owner = r.full_name.split("/")[0] ?? "";
      upsert.run(
        r.id,
        installationId,
        owner,
        r.name,
        r.full_name,
        r.private ? 1 : 0,
        r.default_branch ?? "main",
        nowIso(),
      );
    }
  })();
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: WebhookRepository & { default_branch: string };
  commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }>;
  head_commit?: { added?: string[]; modified?: string[]; removed?: string[] } | null;
}

/** Did this push touch a root-level lockfile or package.json? Webhook file
 *  paths are repo-relative, so exact match = root-level only. */
function touchesDependencies(payload: PushPayload): boolean {
  const watched = new Set<string>([...LOCKFILE_CANDIDATES, "package.json"]);
  const commits = [...(payload.commits ?? []), ...(payload.head_commit ? [payload.head_commit] : [])];
  return commits.some((c) =>
    [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].some((f) => watched.has(f)),
  );
}

async function handlePush(payload: PushPayload): Promise<void> {
  const repoId = payload.repository?.id;
  const headSha = payload.after;
  const branch = payload.ref?.replace(/^refs\/heads\//, "");
  if (!repoId || !headSha || !branch || /^0+$/.test(headSha)) return; // branch deletion etc.

  const repo = getDb().prepare("SELECT * FROM repos WHERE id = ?").get(repoId) as
    | RepoRow
    | undefined;
  if (!repo || !repo.protected_at) return; // Protect off — ignore
  if (!touchesDependencies(payload)) return;

  console.log(`[webhook] push to ${repo.full_name}@${branch} touches deps — delta scan`);
  const checkRunId = await createCheckRun(repo.installation_id, repo.owner, repo.name, headSha);
  try {
    await deltaRepoScan(repo, branch, headSha, checkRunId);
  } catch (err) {
    if (err instanceof LockfileNotFoundError) {
      console.warn(`[webhook] ${repo.full_name}: lockfile gone at ${headSha.slice(0, 7)} — skipping`);
      return;
    }
    throw err;
  }
}

ghWebhookRoutes.post("/webhooks/github", async (c) => {
  if (!GITHUB_APP_ENABLED || !config.githubWebhookSecret) {
    return c.json({ error: "GitHub webhooks are not configured" }, 503);
  }

  const signature = c.req.header("x-hub-signature-256");
  const event = c.req.header("x-github-event");
  const body = await c.req.text();

  if (!signature || !(await verify(config.githubWebhookSecret, body, signature))) {
    return c.json({ error: "Invalid webhook signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid JSON payload" }, 400);
  }

  const db = getDb();
  switch (event) {
    case "installation": {
      const action = payload.action as string;
      const installation = payload.installation as Parameters<typeof upsertInstallation>[0];
      if (action === "deleted") {
        // Cascades: repos → repo_deps/scans; watch list re-syncs below
        db.prepare("DELETE FROM installations WHERE id = ?").run(installation.id);
        syncWatchedPackages();
      } else {
        upsertInstallation(installation);
        const repos = (payload.repositories as WebhookRepository[] | undefined) ?? [];
        if (action === "created" && repos.length > 0) {
          upsertWebhookRepos(installation.id, repos);
        }
      }
      break;
    }

    case "installation_repositories": {
      const installation = payload.installation as Parameters<typeof upsertInstallation>[0];
      upsertInstallation(installation);
      const added = (payload.repositories_added as WebhookRepository[] | undefined) ?? [];
      const removed = (payload.repositories_removed as WebhookRepository[] | undefined) ?? [];
      if (added.length > 0) upsertWebhookRepos(installation.id, added);
      if (removed.length > 0) {
        const del = db.prepare("DELETE FROM repos WHERE id = ?");
        db.transaction(() => {
          for (const r of removed) del.run(r.id);
        })();
        syncWatchedPackages();
      }
      break;
    }

    case "push":
      // Respond fast; scan in the background
      void handlePush(payload as PushPayload).catch((err) =>
        console.error("[webhook] push handling failed:", err instanceof Error ? err.message : err),
      );
      break;

    default:
      // ping and anything else we didn't subscribe to
      break;
  }

  return c.json({ ok: true }, 202);
});
