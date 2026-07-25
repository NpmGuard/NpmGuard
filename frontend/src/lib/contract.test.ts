/**
 * Unit: the generated wire contract (@npmguard/shared) as a RUNTIME validator.
 *
 * Sharing types alone still lets a drift pass silently at runtime; sharing the
 * schemas lets the boundary fail loud. These are the properties the API layer
 * relies on, so they are asserted directly rather than through a caller.
 *
 * Input classes:
 *  C1  wire nullability      — an explicitly-null nullable field parses. The
 *                             engine dumps with exclude_none=False, so `null` (not
 *                             `undefined`) is what actually arrives; a schema
 *                             using .optional() here would throw on real traffic.
 *  C2  missing-key rejection — a response field absent from the payload is a
 *                             FAILURE, never a silent default. Defaulting would
 *                             let a dropped engine field validate cleanly, which
 *                             is the exact drift this contract exists to catch.
 *  C3  unrepresentable states — the retired SUSPECT / UNKNOWN outcomes cannot be
 *                             expressed at all, so they cannot be reintroduced by
 *                             an engine regression.
 *  C4  domain sentinels      — limit 0 / remaining null is the UNLIMITED signal
 *                             (caps.py), and it must validate.
 *  C5  narrowed literals     — a shape whose producer only ever emits one value
 *                             rejects the others (alerts are only raised for
 *                             DANGEROUS).
 */

import { describe, expect, it } from "vitest";
import {
  AlertSchema,
  AuditSetRollupSchema,
  FileVerdictSchema,
  UsageBucketSchema,
} from "@npmguard/shared";

const ROLLUP = { total: 1, safe: 0, dangerous: 0, error: 0, pending: 1, cached: 0 };

describe("wire contract — runtime validation", () => {
  it("C1: an explicitly-null nullable field parses", () => {
    expect(
      FileVerdictSchema.safeParse({
        file: "index.js",
        capabilities: [],
        suspiciousPatterns: [],
        suspiciousLines: null, // every clean file sends this
        summary: "ok",
        riskContribution: 0,
      }).success,
    ).toBe(true);
  });

  it("C2: a missing response key is rejected, not silently defaulted", () => {
    const { pending: _dropped, ...withoutPending } = ROLLUP;
    expect(AuditSetRollupSchema.safeParse({ ...withoutPending, outcome: "SAFE" }).success).toBe(
      false,
    );
  });

  it("C3: SUSPECT and UNKNOWN are unrepresentable outcomes", () => {
    expect(AuditSetRollupSchema.safeParse({ ...ROLLUP, outcome: "SUSPECT" }).success).toBe(false);
    expect(AuditSetRollupSchema.safeParse({ ...ROLLUP, outcome: "UNKNOWN" }).success).toBe(false);
    // …while the three real outcomes and the not-yet-concluded null all do parse.
    for (const outcome of ["SAFE", "ERROR", "DANGEROUS", null]) {
      expect(AuditSetRollupSchema.safeParse({ ...ROLLUP, outcome }).success).toBe(true);
    }
  });

  it("C4: the unlimited usage bucket (limit 0 → remaining null) validates", () => {
    expect(UsageBucketSchema.safeParse({ used: 7, limit: 0, remaining: null }).success).toBe(true);
    expect(UsageBucketSchema.safeParse({ used: 7, limit: 10, remaining: 3 }).success).toBe(true);
  });

  it("C5: an alert cannot claim a non-DANGEROUS outcome", () => {
    const alert = {
      id: 1,
      org: "acme",
      repoId: 5,
      packageName: "p",
      version: "1.0.0",
      origin: "repo_scan",
      message: "m",
      seen: false,
      createdAt: "2026-07-25T00:00:00Z",
    };
    expect(AlertSchema.safeParse({ ...alert, outcome: "DANGEROUS" }).success).toBe(true);
    expect(AlertSchema.safeParse({ ...alert, outcome: "SAFE" }).success).toBe(false);
  });
});
