import { beforeEach, describe, expect, it } from "vitest";
import { openDb, setDbForTesting } from "./db.js";
import { getVerdict, upsertVerdict } from "./verdict-index.js";

beforeEach(() => {
  setDbForTesting(openDb(":memory:"));
});

describe("verdict index explanations", () => {
  it("stores the normalized verdict reason with its evidence count", () => {
    upsertVerdict(
      "bad-package",
      "1.0.0",
      "DANGEROUS",
      "Sandbox exploit reproduced at postinstall.js:4.",
      1,
      "2026-07-17T20:00:00.000Z",
    );

    expect(getVerdict("bad-package", "1.0.0")).toEqual({
      verdict: "DANGEROUS",
      reason: "Sandbox exploit reproduced at postinstall.js:4.",
      evidenceCount: 1,
      auditedAt: "2026-07-17T20:00:00.000Z",
    });
  });

  it("updates stale explanations when a report is reclassified", () => {
    upsertVerdict("package", "2.0.0", "SUSPECT", "Old static signal.", 1);
    upsertVerdict("package", "2.0.0", "SAFE", "Audit completed with no actionable finding.", 0);

    expect(getVerdict("package", "2.0.0")).toEqual(
      expect.objectContaining({
        verdict: "SAFE",
        reason: "Audit completed with no actionable finding.",
        evidenceCount: 0,
      }),
    );
  });
});
