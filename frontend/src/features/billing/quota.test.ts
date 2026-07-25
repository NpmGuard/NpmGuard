/**
 * Unit: pure quota-display logic — quota.ts.
 *
 * Input classes (the three states a UsageBucket collapses to):
 *  C1  unlimited  — remaining === null (limit 0) → {kind:"unlimited"}; copy/label
 *                   both render the ∞ branch, NEVER "zero left".
 *  C2  exhausted  — remaining <= 0 with a real limit → {kind:"exhausted"}; re-audit copy
 *                   still tells the user existing repos can be re-audited (not a dead end).
 *  C3  available  — remaining > 0 → {kind:"available", remaining}; copy singular/plural.
 *
 * Blackbox: quotaState is total over the bucket shape; the derived copy/label
 * helpers are asserted against each state.
 *
 * The `usageFraction` assertions moved with the helper's deletion — the bar's
 * magnitude is now derived inside `ui/meter`, so the property that a bucket never
 * reads as a full or empty bar it has not earned is pinned in
 * `components/AllowanceMeter.test.tsx` (M2/M3) against the rendered meter state
 * rather than against a number this module no longer produces.
 */

import { describe, expect, it } from "vitest";
import { publicAuditAllowanceCopy, quotaState, usageLabel } from "./quota.ts";
import type { UsageBucket } from "@npmguard/shared";

const bucket = (used: number, limit: number, remaining: number | null): UsageBucket => ({
  used,
  limit,
  remaining,
});

describe("quota — C1 unlimited", () => {
  it("C1: remaining === null classifies as unlimited regardless of used", () => {
    expect(quotaState(bucket(9, 0, null))).toEqual({ kind: "unlimited" });
  });

  it("C1: unlimited never reads as 'zero left' in copy or label", () => {
    const b = bucket(9, 0, null);
    expect(publicAuditAllowanceCopy(b)).toBe("Unlimited public repository audits.");
    expect(usageLabel(b)).toBe("9 / ∞");
  });
});

describe("quota — C2 exhausted", () => {
  it("C2: remaining <= 0 with a real limit classifies as exhausted", () => {
    expect(quotaState(bucket(3, 3, 0))).toEqual({ kind: "exhausted" });
    // negative remaining still reads exhausted, never 'available'
    expect(quotaState(bucket(4, 3, -1))).toEqual({ kind: "exhausted" });
  });

  it("C2: exhausted copy still offers free re-audits; the label reflects full use", () => {
    const b = bucket(3, 3, 0);
    expect(publicAuditAllowanceCopy(b)).toBe(
      "Free repository allowance used. Existing repositories can still be re-audited.",
    );
    expect(usageLabel(b)).toBe("3 / 3");
  });
});

describe("quota — C3 available", () => {
  it("C3: remaining > 0 classifies as available and carries the count", () => {
    expect(quotaState(bucket(1, 3, 2))).toEqual({ kind: "available", remaining: 2 });
  });

  it("C3: copy is pluralized on the remaining count", () => {
    expect(publicAuditAllowanceCopy(bucket(2, 3, 1))).toBe(
      "1 new public repository left. Re-audits are free.",
    );
    expect(publicAuditAllowanceCopy(bucket(1, 3, 2))).toBe(
      "2 new public repositories left. Re-audits are free.",
    );
  });

  it("C3: label reads used/limit", () => {
    expect(usageLabel(bucket(1, 3, 2))).toBe("1 / 3");
    expect(usageLabel(bucket(9, 3, -6))).toBe("9 / 3");
  });
});
