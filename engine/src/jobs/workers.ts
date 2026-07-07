import { handleDangerousVerdict } from "../alerts/notify.js";
import { config } from "../config.js";
import { runAudit } from "../pipeline.js";
import { saveReport } from "../report-store.js";
import { refreshScansTouching } from "../scan/repo-scan.js";
import { upsertVerdict } from "../verdict-index.js";
import { claimNextJob, completeJob, failJob, onWake, type JobRow } from "./queue.js";

// In-process worker pool over the jobs table (spec §5.4). The "cheap" lane
// runs the full audit pipeline at NPMGUARD_SCAN_CONCURRENCY — the pipeline
// itself triages per package, so most runs stay cheap (inventory + one LLM
// pass) and only risk-flagged packages go deep. A dedicated deep lane with
// its own concurrency cap is reserved in the schema but needs pipeline
// surgery to split mid-run; revisit if concurrent sandbox runs become a
// resource problem (each container is already capped at 512MB/1cpu).

let started = false;

export function startWorkers(count = config.scanConcurrency): void {
  if (started) return;
  started = true;
  for (let i = 0; i < count; i++) {
    void workerLoop(i).catch((err) =>
      console.error(`[jobs] worker ${i} died:`, err instanceof Error ? err.message : err),
    );
  }
  console.log(`[jobs] ${count} audit workers started`);
}

function waitForWork(): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, 5000);
    const off = onWake(done);
  });
}

async function workerLoop(id: number): Promise<void> {
  for (;;) {
    const job = claimNextJob();
    if (!job) {
      await waitForWork();
      continue;
    }
    try {
      await runJob(job);
    } catch (err) {
      // runJob handles its own failures; this guards the guard
      console.error(`[jobs] worker ${id} unexpected:`, err instanceof Error ? err.message : err);
    }
  }
}

async function runJob(job: JobRow): Promise<void> {
  console.log(
    `[jobs] auditing ${job.package_name}@${job.version} (attempt ${job.attempts}${job.org ? `, org ${job.org}` : ", watch"})`,
  );
  try {
    const { report, cleanup } = await runAudit(
      job.package_name,
      undefined,
      undefined,
      job.version,
    );
    saveReport(job.package_name, job.version, report); // saved-hook indexes the real version
    try {
      cleanup();
    } catch {
      // temp-dir cleanup is best-effort
    }
    // Index the requested version too — the tarball metadata version can
    // differ in odd cases, and scan_items reference the lockfile's version.
    upsertVerdict(job.package_name, job.version, report.verdict ?? "UNKNOWN");
    completeJob(job.id);

    if (report.verdict === "DANGEROUS") {
      try {
        handleDangerousVerdict(job.package_name, job.version, job.scan_id ? "scan" : "watch");
      } catch (err) {
        console.error("[jobs] alert fan-out failed:", err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outcome = failJob(job, message);
    console.warn(`[jobs] ${job.package_name}@${job.version} ${outcome}: ${message}`);
  } finally {
    // Even a terminal failure can complete a scan (last unresolved item)
    refreshScansTouching(job.package_name, job.version);
  }
}
