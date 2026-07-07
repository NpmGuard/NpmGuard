import { getDb, nowIso } from "../db.js";

// Durable audit-job queue (spec §5.4). The `jobs` table survives restarts;
// a partial unique index (idx_jobs_active_pkg) guarantees at most one active
// job per (package, version) — concurrent scans needing the same package
// share the one job, and scan progress is computed from scan_items joined
// against the verdict index, never from job ownership.

export const MAX_ATTEMPTS = 3;

export interface AuditJobSpec {
  packageName: string;
  version: string;
  org: string | null;
  scanId: number | null;
}

export interface JobRow {
  id: number;
  kind: string;
  lane: string;
  org: string | null;
  scan_id: number | null;
  package_name: string;
  version: string;
  state: string;
  attempts: number;
}

const wakers = new Set<() => void>();

/** Workers park here when the queue is empty; enqueue pokes them awake. */
export function onWake(fn: () => void): () => void {
  wakers.add(fn);
  return () => wakers.delete(fn);
}

export function pokeWorkers(): void {
  for (const wake of [...wakers]) wake();
}

/** Insert jobs, skipping (pkg, version) pairs that already have an active
 *  job. Returns how many were actually inserted (= budget to charge). */
export function enqueueAuditJobs(specs: AuditJobSpec[]): number {
  if (specs.length === 0) return 0;
  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO jobs (kind, lane, org, scan_id, package_name, version)
     VALUES ('audit_package', 'cheap', ?, ?, ?, ?)`,
  );
  let inserted = 0;
  db.transaction(() => {
    for (const spec of specs) {
      inserted += insert.run(spec.org, spec.scanId, spec.packageName, spec.version).changes;
    }
  })();
  if (inserted > 0) pokeWorkers();
  return inserted;
}

/**
 * Claim the next queued job. Fairness: prefer the org with the fewest jobs
 * currently running, oldest first — one big install can't starve the others.
 * better-sqlite3 is synchronous, so claim-then-update is race-free within
 * the process (and there is exactly one engine process).
 */
export function claimNextJob(): JobRow | null {
  const db = getDb();
  const job = db
    .prepare(
      `SELECT * FROM jobs j
       WHERE j.state = 'queued' AND j.lane = 'cheap'
       ORDER BY
         (SELECT COUNT(*) FROM jobs r WHERE r.state = 'running' AND r.org IS j.org),
         j.created_at
       LIMIT 1`,
    )
    .get() as JobRow | undefined;
  if (!job) return null;
  db.prepare(
    "UPDATE jobs SET state = 'running', attempts = attempts + 1, started_at = ? WHERE id = ?",
  ).run(nowIso(), job.id);
  return { ...job, state: "running", attempts: job.attempts + 1 };
}

export function completeJob(id: number): void {
  getDb()
    .prepare("UPDATE jobs SET state = 'done', finished_at = ?, error = NULL WHERE id = ?")
    .run(nowIso(), id);
}

/** Retry with backoff-to-back-of-queue, or mark failed after MAX_ATTEMPTS. */
export function failJob(job: JobRow, error: string): "retried" | "failed" {
  const db = getDb();
  if (job.attempts >= MAX_ATTEMPTS) {
    db.prepare("UPDATE jobs SET state = 'failed', finished_at = ?, error = ? WHERE id = ?").run(
      nowIso(),
      error,
      job.id,
    );
    return "failed";
  }
  // Bump created_at so retries go to the back of the queue
  db.prepare("UPDATE jobs SET state = 'queued', created_at = ?, error = ? WHERE id = ?").run(
    nowIso(),
    error,
    job.id,
  );
  return "retried";
}

/** Startup recovery: jobs stuck 'running' from a crashed process go back to
 *  queued. attempts already counted the crashed run, so a job whose payload
 *  kills the process can't crash-loop forever. */
export function resetStaleRunningJobs(): number {
  const result = getDb()
    .prepare("UPDATE jobs SET state = 'queued' WHERE state = 'running'")
    .run();
  if (result.changes > 0) {
    console.log(`[jobs] requeued ${result.changes} jobs interrupted by restart`);
  }
  return result.changes;
}
