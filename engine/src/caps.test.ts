import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { openDb as OpenDb, setDbForTesting as SetDb, DB } from "./db.js";

process.env.NPMGUARD_FREE_MAX_REPOSITORIES = "2";
process.env.NPMGUARD_FREE_MAX_AUDITS_MONTH = "10";
process.env.NPMGUARD_PRO_MAX_REPOSITORIES = "5";
process.env.NPMGUARD_PRO_MAX_AUDITS_MONTH = "100";

let db: DB;
let openDb: typeof OpenDb;
let setDbForTesting: typeof SetDb;
let caps: typeof import("./caps.js");

beforeAll(async () => {
  ({ openDb, setDbForTesting } = await import("./db.js"));
  caps = await import("./caps.js");
});

beforeEach(() => {
  db = openDb(":memory:");
  setDbForTesting(db);
  db.prepare("INSERT INTO users (id, login) VALUES (10, 'alice')").run();
  db.prepare(
    "INSERT INTO installations (id, account_login, account_type) VALUES (1, 'acme', 'Organization')",
  ).run();
  db.prepare(
    "INSERT INTO installations (id, account_login, account_type) VALUES (2, 'other', 'Organization')",
  ).run();
});

function protectRepos(installationId: number, count: number): void {
  const start = (
    db.prepare("SELECT COUNT(*) AS c FROM repos WHERE installation_id = ?").get(installationId) as {
      c: number;
    }
  ).c;
  for (let i = 0; i < count; i++) {
    const index = start + i;
    const id = installationId * 1000 + index;
    db.prepare(
      `INSERT INTO repos
       (id, installation_id, owner, name, full_name, protected_at)
       VALUES (?, ?, ?, ?, ?, '2026-01-01')`,
    ).run(
      id,
      installationId,
      `o${installationId}`,
      `r${index}`,
      `o${installationId}/r${index}`,
    );
  }
}

function auditPublicRepo(installationId: number, githubRepoId: number): void {
  db.prepare(
    `INSERT INTO public_repo_scans (
       installation_id, requested_by, github_repo_id, owner, name, full_name,
       html_url, default_branch, lockfile_path, lockfile_sha, status
     ) VALUES (?, 10, ?, 'public-org', ?, ?, ?, 'main', 'package-lock.json', ?, 'done')`,
  ).run(
    installationId,
    githubRepoId,
    `repo-${githubRepoId}`,
    `public-org/repo-${githubRepoId}`,
    `https://github.com/public-org/repo-${githubRepoId}`,
    `sha-${githubRepoId}`,
  );
}

describe("Free entitlements", () => {
  it("allows a new repository below the Free cap and rejects at it", () => {
    protectRepos(1, 1);
    expect(() => caps.assertRepositoryCap(1, 1001)).not.toThrow();
    protectRepos(1, 1);
    expect(() => caps.assertRepositoryCap(1, 1002)).toThrow(caps.CapExceededError);
  });

  it("returns structured usage for the paywall", () => {
    protectRepos(1, 2);
    auditPublicRepo(1, 101);
    caps.consumeAuditBudget(1, 7);
    expect(caps.getAccountEntitlements(1)).toMatchObject({
      installationId: 1,
      accountLogin: "acme",
      plan: "free",
      subscriptionStatus: "inactive",
      repositories: { used: 3, limit: 2, remaining: 0 },
      monthlyAudits: { used: 7, limit: 10, remaining: 3 },
    });
  });
});

describe("shared repository allowance", () => {
  it("deduplicates protected and public use by stable GitHub repository id", () => {
    auditPublicRepo(1, 101);
    expect(caps.repositoryCount(1)).toBe(1);
    expect(() => caps.assertRepositoryCap(1, 101)).not.toThrow();

    db.prepare(
      `INSERT INTO repos
       (id, installation_id, owner, name, full_name, protected_at)
       VALUES (101, 1, 'public-org', 'repo-101', 'public-org/repo-101', '2026-01-01')`,
    ).run();
    expect(caps.repositoryCount(1)).toBe(1);

    auditPublicRepo(1, 102);
    expect(caps.repositoryCount(1)).toBe(2);
    expect(() => caps.assertRepositoryCap(1, 103)).toThrow(caps.CapExceededError);
    try {
      caps.assertRepositoryCap(1, 103);
    } catch (err) {
      expect(err).toMatchObject({
        cap: true,
        installationId: 1,
        resource: "repositories",
      });
    }
  });

  it("tracks distinct repositories per installation", () => {
    auditPublicRepo(1, 101);
    auditPublicRepo(1, 102);
    expect(() => caps.assertRepositoryCap(2, 201)).not.toThrow();
    expect(caps.repositoryCount(1)).toBe(2);
    expect(caps.repositoryCount(2)).toBe(0);
  });
});

describe("monthly audit budget", () => {
  it("rejects a scan that would exceed the budget", () => {
    caps.consumeAuditBudget(1, 8);
    expect(() => caps.assertAuditBudget(1, 2)).not.toThrow();
    expect(() => caps.assertAuditBudget(1, 3)).toThrow(caps.CapExceededError);
    try {
      caps.assertAuditBudget(1, 3);
    } catch (err) {
      expect(err).toMatchObject({
        cap: true,
        installationId: 1,
        resource: "monthly_audits",
      });
    }
  });

  it("tracks usage per installation", () => {
    caps.consumeAuditBudget(1, 10);
    expect(() => caps.assertAuditBudget(2, 10)).not.toThrow();
    expect(caps.auditsUsedThisMonth(1)).toBe(10);
    expect(caps.auditsUsedThisMonth(2)).toBe(0);
  });
});

describe("Pro entitlements", () => {
  it("uses the larger limits only for active subscriptions", () => {
    protectRepos(1, 2);
    auditPublicRepo(1, 101);
    auditPublicRepo(1, 102);
    expect(() => caps.assertRepositoryCap(1, 1002)).toThrow(caps.CapExceededError);
    expect(() => caps.assertRepositoryCap(1, 103)).toThrow(caps.CapExceededError);

    db.prepare(
      `INSERT INTO billing_accounts
       (installation_id, stripe_subscription_id, subscription_status)
       VALUES (1, 'sub_123', 'active')`,
    ).run();

    expect(caps.getAccountEntitlements(1).plan).toBe("pro");
    expect(() => caps.assertRepositoryCap(1, 1002)).not.toThrow();
    expect(() => caps.assertRepositoryCap(1, 103)).not.toThrow();
    caps.consumeAuditBudget(1, 50);
    expect(() => caps.assertAuditBudget(1, 50)).not.toThrow();
  });

  it("falls back to Free when Stripe marks the subscription canceled", () => {
    db.prepare(
      `INSERT INTO billing_accounts
       (installation_id, stripe_subscription_id, subscription_status)
       VALUES (1, 'sub_123', 'canceled')`,
    ).run();
    expect(caps.getAccountEntitlements(1).plan).toBe("free");
  });
});
