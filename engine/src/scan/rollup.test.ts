import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTesting, type DB } from "../db.js";
import { computeRollup, refreshScanProgress, refreshScansTouching } from "./repo-scan.js";

// Spec §9 tests 5 (rollup) and the scan-progress half of 11: a job failing
// terminally surfaces as unresolved/UNKNOWN — never silently SAFE.

let db: DB;

function seedRepo(id = 1): void {
  db.prepare(
    "INSERT INTO installations (id, account_login, account_type) VALUES (?, ?, 'Organization')",
  ).run(id, `org${id}`);
  db.prepare(
    "INSERT INTO repos (id, installation_id, owner, name, full_name) VALUES (?, ?, 'o', 'r', ?)",
  ).run(id, id, `o/r${id}`);
}

function addDep(repoId: number, name: string, version: string, verdict?: string): void {
  db.prepare(
    "INSERT INTO repo_deps (repo_id, name, version, direct) VALUES (?, ?, ?, 0)",
  ).run(repoId, name, version);
  if (verdict) {
    db.prepare(
      "INSERT OR REPLACE INTO package_verdicts (name, version, verdict, audited_at) VALUES (?, ?, ?, '2026-01-01')",
    ).run(name, version, verdict);
  }
}

beforeEach(() => {
  db = openDb(":memory:");
  setDbForTesting(db);
  seedRepo();
});

describe("computeRollup", () => {
  it("is DANGEROUS when a single dep among many is dangerous", () => {
    for (let i = 0; i < 20; i++) addDep(1, `safe-${i}`, "1.0.0", "SAFE");
    addDep(1, "evil", "6.6.6", "DANGEROUS");
    const rollup = computeRollup(1);
    expect(rollup.verdict).toBe("DANGEROUS");
    expect(rollup.dangerous).toBe(1);
    expect(rollup.safe).toBe(20);
  });

  it("is never SAFE while deps are unaudited (pending → UNKNOWN)", () => {
    addDep(1, "a", "1.0.0", "SAFE");
    addDep(1, "b", "1.0.0"); // no verdict
    const rollup = computeRollup(1);
    expect(rollup.verdict).toBe("UNKNOWN");
    expect(rollup.unknown).toBe(1);
  });

  it("is SAFE only when everything resolved SAFE", () => {
    addDep(1, "a", "1.0.0", "SAFE");
    addDep(1, "b", "2.0.0", "SAFE");
    expect(computeRollup(1).verdict).toBe("SAFE");
  });

  it("SUSPECT outranks UNKNOWN-free SAFE sets", () => {
    addDep(1, "a", "1.0.0", "SAFE");
    addDep(1, "b", "2.0.0", "SUSPECT");
    expect(computeRollup(1).verdict).toBe("SUSPECT");
  });

  it("returns null verdict for repos with no dep index", () => {
    expect(computeRollup(1).verdict).toBeNull();
  });
});

function seedScan(items: Array<{ name: string; version: string; cached?: boolean }>): number {
  const scanId = Number(
    db
      .prepare(
        "INSERT INTO scans (repo_id, trigger_kind, status, total, cached) VALUES (1, 'manual', 'running', ?, ?)",
      )
      .run(items.length, items.filter((i) => i.cached).length).lastInsertRowid,
  );
  for (const item of items) {
    db.prepare(
      "INSERT INTO scan_items (scan_id, name, version, cached) VALUES (?, ?, ?, ?)",
    ).run(scanId, item.name, item.version, item.cached ? 1 : 0);
  }
  return scanId;
}

function scanRow(id: number): { status: string; cached: number; audited: number; failed: number } {
  return db.prepare("SELECT status, cached, audited, failed FROM scans WHERE id = ?").get(id) as never;
}

describe("refreshScanProgress", () => {
  it("stays running while items have active jobs", () => {
    const scanId = seedScan([{ name: "a", version: "1.0.0" }]);
    db.prepare(
      "INSERT INTO jobs (kind, lane, package_name, version, state) VALUES ('audit_package', 'cheap', 'a', '1.0.0', 'queued')",
    ).run();
    refreshScanProgress(scanId);
    expect(scanRow(scanId).status).toBe("running");
  });

  it("finalizes when every item resolved; audited excludes cache hits", () => {
    const scanId = seedScan([
      { name: "a", version: "1.0.0", cached: true },
      { name: "b", version: "2.0.0" },
    ]);
    db.prepare(
      "INSERT INTO package_verdicts (name, version, verdict, audited_at) VALUES ('a', '1.0.0', 'SAFE', 'x'), ('b', '2.0.0', 'SAFE', 'x')",
    ).run();
    refreshScanProgress(scanId);
    expect(scanRow(scanId)).toMatchObject({ status: "done", cached: 1, audited: 1, failed: 0 });
  });

  it("counts terminally-failed items as failed, not SAFE (test 11)", () => {
    const scanId = seedScan([{ name: "bad", version: "1.0.0" }]);
    db.prepare(
      "INSERT INTO jobs (kind, lane, package_name, version, state, attempts) VALUES ('audit_package', 'cheap', 'bad', '1.0.0', 'failed', 3)",
    ).run();
    refreshScanProgress(scanId);
    expect(scanRow(scanId)).toMatchObject({ status: "done", failed: 1, audited: 0 });
    // and the repo rollup stays non-SAFE
    addDep(1, "bad", "1.0.0");
    expect(computeRollup(1).verdict).toBe("UNKNOWN");
  });
});

describe("refreshScansTouching", () => {
  it("finalizes every running scan sharing the settled package", () => {
    const scanA = seedScan([{ name: "shared", version: "1.0.0" }]);
    const scanB = seedScan([{ name: "shared", version: "1.0.0" }]);
    db.prepare(
      "INSERT INTO package_verdicts (name, version, verdict, audited_at) VALUES ('shared', '1.0.0', 'SAFE', 'x')",
    ).run();
    refreshScansTouching("shared", "1.0.0");
    expect(scanRow(scanA).status).toBe("done");
    expect(scanRow(scanB).status).toBe("done");
  });
});
