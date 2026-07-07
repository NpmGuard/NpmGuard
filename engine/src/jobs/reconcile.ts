import { getDb } from "../db.js";
import { installationOctokit } from "../github/app.js";
import { fetchLockfile } from "../github/content.js";
import type { RepoRow } from "../routes/panel.js";
import { fullRepoScan } from "../scan/repo-scan.js";

// Daily reconcile (spec decision 10, scenario 1): a webhook missed while the
// engine was down leaves the dep index stale — and registry-watch alerts FROM
// that index, so staleness means wrong alerts, not just a stale dashboard.
// One contents call per protected repo per day; a scan only on actual drift.

const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function reconcileOnce(): Promise<void> {
  const repos = getDb()
    .prepare("SELECT * FROM repos WHERE protected_at IS NOT NULL")
    .all() as RepoRow[];

  for (const repo of repos) {
    try {
      const octo = await installationOctokit(repo.installation_id);
      const lockfile = await fetchLockfile(octo, repo.owner, repo.name);
      if (!lockfile) continue; // lockfile-less repos can't be reconciled
      if (lockfile.sha === repo.lockfile_sha) continue; // no drift

      console.log(`[reconcile] ${repo.full_name}: lockfile drifted — rescanning`);
      await fullRepoScan(repo, "reconcile");
    } catch (err) {
      console.warn(
        `[reconcile] ${repo.full_name} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export function startReconcile(): void {
  setInterval(() => void reconcileOnce(), RECONCILE_INTERVAL_MS);
  // Startup pass (delayed so boot isn't blocked): heals anything missed while down
  setTimeout(() => void reconcileOnce(), 60_000);
  console.log("[reconcile] daily lockfile reconcile scheduled");
}
