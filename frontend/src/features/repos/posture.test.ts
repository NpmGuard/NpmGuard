/**
 * Unit: repo-level posture classification — posture.ts.
 *
 * Pure functions over the two axes at SET level (design §4.4): `status`
 * (`running | done`, progress, never a verdict) and `rollup.outcome`
 * (SAFE | ERROR | DANGEROUS, null until something concludes).
 *
 * Input classes:
 *  R1  needsAttention — DANGEROUS and ERROR yes; SAFE, null-outcome and no-set
 *      no. ERROR is the load-bearing one: "we tried and failed" is a coverage
 *      gap a human has to close, and folding it in with "never scanned" hides it.
 *  R2  needsAttention ignores PROGRESS: a still-running set with a DANGEROUS
 *      partial rollup already needs a human — that finding will not un-happen.
 *  R3  repoBucket — total, exactly one bucket per repo, and PROGRESS WINS: the
 *      same running-DANGEROUS repo from R2 is `running` here, because a rail
 *      segment claims a settled proportion and that one is not settled. This
 *      divergence from R2 is intentional and is the reason both live in one
 *      module.
 *  R4  repoBucket — no set, and a set that concluded over NOTHING (outcome null,
 *      total 0), are both `unknown`. Never `safe`: absence of knowledge is not
 *      absence of threats.
 *  R5  portfolioCounts PARTITIONS the list — attention + safe + running +
 *      unknown === total, for every mix. This is the property the rail's
 *      proportion rests on; four independent filters that happen to add up would
 *      not survive a new bucket.
 *  R6  portfolioCounts — `protectedRepos` and `audited` are independent of the
 *      bucket axis (a protected repo can sit in any bucket; `audited` counts a
 *      running first scan, which `unknown` also counts).
 *  R7  repoFilterCounts agrees with matchesRepoFilter, chip for chip. A count
 *      that disagreed with the predicate would advertise rows the grid then
 *      fails to show.
 *  R8  matchesRepoQuery — matches fullName and defaultBranch, case-insensitively;
 *      an empty/whitespace query matches EVERYTHING ("no filter" is not "no
 *      results").
 *
 * Blackbox: call the exported functions over built `PanelRepo`s.
 */

import type { AuditSet, Outcome, PanelRepo } from "@npmguard/shared";
import { describe, expect, it } from "vitest";
import {
  matchesRepoFilter,
  matchesRepoQuery,
  needsAttention,
  portfolioCounts,
  repoBucket,
  repoFilterCounts,
  type RepoFilter,
} from "./posture.ts";

const ALL_FILTERS: RepoFilter[] = ["all", "protected", "unscanned", "attention"];

type SetOverrides = Omit<Partial<AuditSet>, "rollup"> & { rollup?: Partial<AuditSet["rollup"]> };

function set(over: SetOverrides = {}): AuditSet {
  return {
    id: 1,
    origin: "repo_scan",
    trigger: "manual",
    status: "done",
    commitSha: "abc123",
    startedAt: "2026-07-01T00:00:00.000Z",
    finishedAt: "2026-07-01T00:01:00.000Z",
    ...over,
    rollup: {
      outcome: "SAFE",
      total: 1,
      safe: 1,
      dangerous: 0,
      error: 0,
      pending: 0,
      cached: 0,
      ...over.rollup,
    },
  };
}

/** A repo whose last set concluded with `outcome`; `null` = never scanned. */
function repo(over: Partial<PanelRepo> = {}): PanelRepo {
  return {
    id: 1,
    installationId: 500,
    owner: "acme",
    name: "web",
    fullName: "acme/web",
    private: false,
    defaultBranch: "main",
    protected: false,
    lastScan: null,
    ...over,
  };
}

const concluded = (outcome: Outcome | null, over: Partial<PanelRepo> = {}) =>
  repo({ lastScan: set({ rollup: { outcome } }), ...over });

describe("needsAttention", () => {
  it("R1: is true for exactly the two outcomes a human has to act on", () => {
    expect(needsAttention(concluded("DANGEROUS"))).toBe(true);
    expect(needsAttention(concluded("ERROR"))).toBe(true);
    expect(needsAttention(concluded("SAFE"))).toBe(false);
    // Nothing concluded yet, and no set at all: neither is a finding.
    expect(needsAttention(concluded(null))).toBe(false);
    expect(needsAttention(repo())).toBe(false);
  });

  it("R2: reads the outcome axis only — a live scan does not defer a finding", () => {
    const live = repo({
      lastScan: set({ status: "running", finishedAt: null, rollup: { outcome: "DANGEROUS", pending: 3 } }),
    });
    expect(needsAttention(live)).toBe(true);
  });
});

describe("repoBucket", () => {
  it("R3: progress wins — the same live DANGEROUS set is `running`, not `attention`", () => {
    const live = repo({
      lastScan: set({ status: "running", finishedAt: null, rollup: { outcome: "DANGEROUS", pending: 3 } }),
    });
    expect(needsAttention(live)).toBe(true);
    expect(repoBucket(live)).toBe("running");
  });

  it("R3: a concluded set buckets by its outcome", () => {
    expect(repoBucket(concluded("DANGEROUS"))).toBe("attention");
    expect(repoBucket(concluded("ERROR"))).toBe("attention");
    expect(repoBucket(concluded("SAFE"))).toBe("safe");
  });

  it("R4: no set, and a set that covered nothing, are both unknown — never safe", () => {
    expect(repoBucket(repo())).toBe("unknown");
    expect(repoBucket(repo({ lastScan: set({ rollup: { outcome: null, total: 0, safe: 0 } }) }))).toBe(
      "unknown",
    );
  });
});

describe("portfolioCounts", () => {
  const mixed = [
    concluded("DANGEROUS", { id: 1 }),
    concluded("ERROR", { id: 2 }),
    concluded("SAFE", { id: 3, protected: true }),
    repo({ id: 4, protected: true }),
    repo({
      id: 5,
      lastScan: set({ status: "running", finishedAt: null, rollup: { outcome: null, pending: 2 } }),
    }),
  ];

  it("R5: the four buckets partition the list", () => {
    const counts = portfolioCounts(mixed);
    expect(counts).toMatchObject({ attention: 2, safe: 1, running: 1, unknown: 1, total: 5 });
    expect(counts.attention + counts.safe + counts.running + counts.unknown).toBe(counts.total);
  });

  it("R5: an empty portfolio partitions too, with no division by anything", () => {
    expect(portfolioCounts([])).toMatchObject({
      attention: 0,
      safe: 0,
      running: 0,
      unknown: 0,
      total: 0,
    });
  });

  it("R6: protected and audited are their own axes", () => {
    const counts = portfolioCounts(mixed);
    // One protected repo is SAFE, the other has never been scanned.
    expect(counts.protectedRepos).toBe(2);
    // Every repo with a set at all, INCLUDING the one still running — which the
    // bucket axis reports as neither known nor unknown.
    expect(counts.audited).toBe(4);
  });
});

describe("the filter chips", () => {
  const repos = [
    concluded("DANGEROUS", { id: 1, fullName: "acme/web" }),
    concluded("SAFE", { id: 2, fullName: "acme/api", protected: true }),
    repo({ id: 3, fullName: "acme/docs", defaultBranch: "trunk" }),
  ];

  it("R7: every chip's count is exactly what its predicate admits", () => {
    const counts = repoFilterCounts(repos);
    for (const filter of ALL_FILTERS) {
      expect(counts[filter], filter).toBe(repos.filter((r) => matchesRepoFilter(r, filter)).length);
    }
    expect(counts).toEqual({ all: 3, protected: 1, unscanned: 1, attention: 1 });
  });

  it("R8: the query matches name or branch, case-insensitively", () => {
    expect(matchesRepoQuery(repos[0], "WEB")).toBe(true);
    expect(matchesRepoQuery(repos[2], "trunk")).toBe(true);
    expect(matchesRepoQuery(repos[0], "trunk")).toBe(false);
  });

  it("R8: an empty or whitespace query matches everything", () => {
    for (const r of repos) {
      expect(matchesRepoQuery(r, "")).toBe(true);
      expect(matchesRepoQuery(r, "   ")).toBe(true);
    }
  });
});
