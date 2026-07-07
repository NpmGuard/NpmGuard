import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { openDb as OpenDb, setDbForTesting as SetDb, DB } from "./db.js";

// Spec §9 test 9: org at cap → rejected with the "talk to us" payload shape
// (CapExceededError.cap = true); counters are per-month. Caps config is read
// at import, so the module graph loads after the env is pinned.

process.env.NPMGUARD_BETA_MAX_PROTECTED_REPOS = "2";
process.env.NPMGUARD_BETA_MAX_AUDITS_MONTH = "10";

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
});

function protectRepos(org: string, count: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO installations (id, account_login, account_type) VALUES (1, ?, 'Organization')",
  ).run(org);
  for (let i = 0; i < count; i++) {
    db.prepare(
      "INSERT INTO repos (id, installation_id, owner, name, full_name, protected_at) VALUES (?, 1, 'o', ?, ?, '2026-01-01')",
    ).run(100 + i, `r${i}`, `o/r${i}`);
  }
}

describe("protect cap", () => {
  it("allows protecting below the cap and rejects at it", () => {
    protectRepos("acme", 1);
    expect(() => caps.assertProtectCap("acme")).not.toThrow();
    protectRepos("acme", 0); // already one; add one more repo protected
    db.prepare(
      "INSERT INTO repos (id, installation_id, owner, name, full_name, protected_at) VALUES (999, 1, 'o', 'z', 'o/z', '2026-01-01')",
    ).run();
    expect(() => caps.assertProtectCap("acme")).toThrow(caps.CapExceededError);
  });
});

describe("audit budget", () => {
  it("rejects a scan that would exceed the monthly budget, with cap flag", () => {
    caps.consumeAuditBudget("acme", 8);
    expect(() => caps.assertAuditBudget("acme", 2)).not.toThrow();
    expect(() => caps.assertAuditBudget("acme", 3)).toThrow(caps.CapExceededError);
    try {
      caps.assertAuditBudget("acme", 3);
    } catch (err) {
      expect((err as { cap?: boolean }).cap).toBe(true);
    }
  });

  it("tracks usage per org", () => {
    caps.consumeAuditBudget("acme", 10);
    expect(() => caps.assertAuditBudget("other", 10)).not.toThrow();
    expect(caps.auditsUsedThisMonth("acme")).toBe(10);
    expect(caps.auditsUsedThisMonth("other")).toBe(0);
  });
});
