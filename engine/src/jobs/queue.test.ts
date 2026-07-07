import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTesting, type DB } from "../db.js";
import {
  claimNextJob,
  enqueueAuditJobs,
  failJob,
  MAX_ATTEMPTS,
  resetStaleRunningJobs,
} from "./queue.js";

// Spec §9 test 11 (durability semantics) + queue fairness/dedup.

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
  setDbForTesting(db);
});

describe("enqueueAuditJobs", () => {
  it("dedupes against active jobs for the same (pkg, version)", () => {
    const first = enqueueAuditJobs([
      { packageName: "lodash", version: "4.17.21", org: "acme", scanId: null },
    ]);
    const second = enqueueAuditJobs([
      { packageName: "lodash", version: "4.17.21", org: "other", scanId: null },
      { packageName: "lodash", version: "4.17.22", org: "other", scanId: null },
    ]);
    expect(first).toBe(1);
    expect(second).toBe(1); // only the new version inserted
  });

  it("allows re-enqueue after a job is done (new publish of same pair is impossible, but failed→done cycles are)", () => {
    enqueueAuditJobs([{ packageName: "a", version: "1.0.0", org: null, scanId: null }]);
    db.prepare("UPDATE jobs SET state = 'done'").run();
    expect(
      enqueueAuditJobs([{ packageName: "a", version: "1.0.0", org: null, scanId: null }]),
    ).toBe(1);
  });
});

describe("claimNextJob fairness", () => {
  it("prefers the org with the fewest running jobs", () => {
    enqueueAuditJobs([
      { packageName: "a1", version: "1.0.0", org: "big-org", scanId: null },
      { packageName: "a2", version: "1.0.0", org: "big-org", scanId: null },
      { packageName: "b1", version: "1.0.0", org: "small-org", scanId: null },
    ]);
    // big-org already has a running job
    const first = claimNextJob();
    expect(first?.org).toBe("big-org"); // 0 running for both → oldest first
    const second = claimNextJob();
    expect(second?.org).toBe("small-org"); // big-org now has 1 running
  });

  it("returns null when the queue is empty", () => {
    expect(claimNextJob()).toBeNull();
  });
});

describe("failJob", () => {
  it("retries to the back of the queue below the attempt limit, fails at it", () => {
    enqueueAuditJobs([{ packageName: "bad", version: "1.0.0", org: null, scanId: null }]);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const job = claimNextJob();
      expect(job).not.toBeNull();
      expect(job!.attempts).toBe(attempt);
      const outcome = failJob(job!, "boom");
      expect(outcome).toBe(attempt < MAX_ATTEMPTS ? "retried" : "failed");
    }
    expect(claimNextJob()).toBeNull();
    const row = db.prepare("SELECT state, error FROM jobs").get() as { state: string; error: string };
    expect(row).toMatchObject({ state: "failed", error: "boom" });
  });
});

describe("resetStaleRunningJobs", () => {
  it("requeues jobs stuck running from a crashed process", () => {
    enqueueAuditJobs([{ packageName: "a", version: "1.0.0", org: null, scanId: null }]);
    claimNextJob();
    expect(resetStaleRunningJobs()).toBe(1);
    const job = claimNextJob();
    expect(job).not.toBeNull();
    // the crashed run already consumed attempt 1
    expect(job!.attempts).toBe(2);
  });
});
