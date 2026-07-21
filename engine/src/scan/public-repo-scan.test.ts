import { beforeEach, describe, expect, it } from "vitest";
import { auditsUsedThisMonth, consumeAuditBudget, getAccountEntitlements } from "../caps.js";
import { openDb, setDbForTesting, type DB } from "../db.js";
import type { LockfileDep } from "../lockfile/index.js";
import {
  computePublicScanRollup,
  createPublicRepoScan,
  findRunningPublicScan,
  InvalidPublicRepoReferenceError,
  parsePublicRepoReference,
  refreshPublicScansTouching,
} from "./public-repo-scan.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
  setDbForTesting(db);
  db.prepare("INSERT INTO users (id, login) VALUES (7, 'alice')").run();
  db.prepare(
    "INSERT INTO installations (id, account_login, account_type) VALUES (42, 'acme', 'Organization')",
  ).run();
  db.prepare(
    "INSERT INTO user_installations (user_id, installation_id) VALUES (7, 42)",
  ).run();
});

function dep(name: string, version: string): LockfileDep {
  return { name, version, direct: true, range: `^${version}` };
}

function scanInput(deps: LockfileDep[]) {
  return {
    installationId: 42,
    requestedBy: 7,
    githubRepoId: 123,
    owner: "public-org",
    name: "public-repo",
    fullName: "public-org/public-repo",
    htmlUrl: "https://github.com/public-org/public-repo",
    defaultBranch: "main",
    commitSha: null,
    lockfilePath: "package-lock.json",
    lockfileSha: "abc123",
    deps,
    accountLogin: "acme",
  };
}

function scanRow(id: number) {
  return db
    .prepare(
      "SELECT status, total, cached, audited, failed FROM public_repo_scans WHERE id = ?",
    )
    .get(id) as {
    status: string;
    total: number;
    cached: number;
    audited: number;
    failed: number;
  };
}

describe("parsePublicRepoReference", () => {
  it.each([
    ["openai/openai-node", "openai/openai-node"],
    ["https://github.com/openai/openai-node", "openai/openai-node"],
    ["github.com/openai/openai-node.git", "openai/openai-node"],
  ])("normalizes %s", (input, fullName) => {
    expect(parsePublicRepoReference(input).fullName).toBe(fullName);
  });

  it.each([
    "https://gitlab.com/openai/openai-node",
    "https://github.com/openai/openai-node/tree/main",
    "git@github.com:openai/openai-node.git",
    "https://github.com/openai/openai-node?tab=readme",
    "one-segment",
  ])("rejects non-repository input %s", (input) => {
    expect(() => parsePublicRepoReference(input)).toThrow(InvalidPublicRepoReferenceError);
  });
});

describe("public repository scan lifecycle", () => {
  it("finishes immediately from cache without consuming allowance", () => {
    db.prepare(
      `INSERT INTO package_verdicts (name, version, verdict, audited_at)
       VALUES ('safe-pkg', '1.0.0', 'SAFE', '2026-01-01')`,
    ).run();

    const id = createPublicRepoScan(scanInput([dep("safe-pkg", "1.0.0")]));
    expect(scanRow(id)).toMatchObject({
      status: "done",
      total: 1,
      cached: 1,
      audited: 0,
      failed: 0,
    });
    expect(computePublicScanRollup(id)).toMatchObject({ verdict: "SAFE", safe: 1 });
    expect(auditsUsedThisMonth(42)).toBe(0);
  });

  it("queues uncached work, charges once, and completes when the shared job settles", () => {
    const id = createPublicRepoScan(scanInput([dep("fresh-pkg", "2.0.0")]));
    expect(scanRow(id).status).toBe("running");
    expect(findRunningPublicScan(42, "PUBLIC-ORG/PUBLIC-REPO")).toEqual({ id });
    expect(auditsUsedThisMonth(42)).toBe(1);
    expect(db.prepare("SELECT scan_id, state FROM jobs").get()).toMatchObject({
      scan_id: null,
      state: "queued",
    });

    db.prepare(
      `INSERT INTO package_verdicts (name, version, verdict, reason, evidence_count, audited_at)
       VALUES ('fresh-pkg', '2.0.0', 'SUSPECT', 'needs review', 1, '2026-01-01')`,
    ).run();
    db.prepare("UPDATE jobs SET state = 'done'").run();
    refreshPublicScansTouching("fresh-pkg", "2.0.0");

    expect(scanRow(id)).toMatchObject({ status: "done", audited: 1, failed: 0 });
    expect(computePublicScanRollup(id)).toMatchObject({ verdict: "SUSPECT", suspect: 1 });
  });

  it("shares an already-active global job without charging the account", () => {
    db.prepare(
      `INSERT INTO jobs (kind, lane, org, package_name, version, state)
       VALUES ('audit_package', 'cheap', 'another-account', 'shared-pkg', '3.0.0', 'queued')`,
    ).run();
    const id = createPublicRepoScan(scanInput([dep("shared-pkg", "3.0.0")]));
    expect(scanRow(id).status).toBe("running");
    expect(auditsUsedThisMonth(42)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS c FROM jobs").get()).toMatchObject({ c: 1 });
  });

  it("rejects over-budget work before creating a scan", () => {
    const limit = getAccountEntitlements(42).monthlyAudits.limit;
    consumeAuditBudget(42, limit);
    expect(() => createPublicRepoScan(scanInput([dep("over-cap", "1.0.0")]))).toThrow(
      /left this month/,
    );
    expect(db.prepare("SELECT COUNT(*) AS c FROM public_repo_scans").get()).toMatchObject({ c: 0 });
  });
});
