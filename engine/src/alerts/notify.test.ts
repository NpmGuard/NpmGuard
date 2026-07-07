import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTesting, type DB } from "../db.js";
import { handleDangerousVerdict } from "./notify.js";

// Spec §9 test 7 (exposure computation): exact lockfile matches always alert;
// range exposure alerts only protected repos whose declared range would adopt
// the poisoned version; duplicates are suppressed. Email is skipped without
// SMTP config — the alert rows are what we assert on.

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
  setDbForTesting(db);
  db.prepare(
    "INSERT INTO installations (id, account_login, account_type) VALUES (1, 'acme', 'Organization')",
  ).run();
});

function addRepo(id: number, opts: { protected?: boolean } = {}): void {
  db.prepare(
    "INSERT INTO repos (id, installation_id, owner, name, full_name, protected_at) VALUES (?, 1, 'acme', ?, ?, ?)",
  ).run(id, `r${id}`, `acme/r${id}`, opts.protected ? "2026-01-01" : null);
}

function addDep(
  repoId: number,
  name: string,
  version: string,
  opts: { direct?: boolean; range?: string } = {},
): void {
  db.prepare("INSERT INTO repo_deps (repo_id, name, version, direct, range) VALUES (?, ?, ?, ?, ?)").run(
    repoId,
    name,
    version,
    opts.direct ? 1 : 0,
    opts.range ?? null,
  );
}

function alerts(): Array<{ repo_id: number; message: string; kind: string }> {
  return db.prepare("SELECT repo_id, message, kind FROM alerts ORDER BY repo_id").all() as never;
}

describe("handleDangerousVerdict", () => {
  it("alerts repos with the exact version installed", () => {
    addRepo(1);
    addDep(1, "lodash", "4.17.21");
    handleDangerousVerdict("lodash", "4.17.21", "scan");
    expect(alerts()).toEqual([
      { repo_id: 1, message: "installed at 4.17.21", kind: "scan" },
    ]);
  });

  it("alerts protected repos whose range would adopt the new version", () => {
    addRepo(1, { protected: true });
    addDep(1, "lodash", "4.17.21", { direct: true, range: "^4.17.0" });
    // 4.17.99 was just published upstream — nobody has it installed
    handleDangerousVerdict("lodash", "4.17.99", "watch");
    expect(alerts()).toEqual([
      { repo_id: 1, message: "range ^4.17.0 would adopt 4.17.99 on next update", kind: "watch" },
    ]);
  });

  it("does NOT range-alert unprotected repos or non-satisfying ranges", () => {
    addRepo(1); // unprotected, satisfying range
    addDep(1, "lodash", "4.17.21", { direct: true, range: "^4.17.0" });
    addRepo(2, { protected: true }); // protected, but pinned to another major
    addDep(2, "lodash", "3.10.1", { direct: true, range: "^3.0.0" });
    handleDangerousVerdict("lodash", "4.17.99", "watch");
    expect(alerts()).toEqual([]);
  });

  it("prefers the exact-match alert when both apply, and dedupes repeats", () => {
    addRepo(1, { protected: true });
    addDep(1, "lodash", "4.17.99", { direct: true, range: "^4.17.0" });
    handleDangerousVerdict("lodash", "4.17.99", "watch");
    handleDangerousVerdict("lodash", "4.17.99", "watch");
    const rows = alerts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe("installed at 4.17.99");
  });

  it("tolerates non-semver ranges (git:, workspace:) without alerting on them", () => {
    addRepo(1, { protected: true });
    addDep(1, "weird", "1.0.0", { direct: true, range: "git+https://x/y.git" });
    handleDangerousVerdict("weird", "2.0.0", "watch");
    expect(alerts()).toEqual([]);
  });
});
