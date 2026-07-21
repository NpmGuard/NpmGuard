import { describe, expect, it } from "vitest";
import type { AuditReport, Proof } from "./models.js";
import { normalizeReportVerdict } from "./report-store.js";

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    verdict: "DANGEROUS",
    capabilities: [],
    proofs: [],
    triage: null,
    findings: [],
    trace: [],
    runtimeEvidence: null,
    ...overrides,
  };
}

describe("normalizeReportVerdict", () => {
  it("removes the legacy DANGEROUS label when no actionable evidence exists", () => {
    expect(normalizeReportVerdict(report()).verdict).toBe("SAFE");
  });

  it("preserves DANGEROUS when a deterministic shell-pipe rule fired", () => {
    const proof: Proof = {
      capability: null,
      attackPathway: "",
      confidence: "CONFIRMED",
      fileLine: "package.json:scripts.postinstall",
      problem: "Install hook downloads and pipes a remote payload to a shell",
      evidence: "Dealbreaker: shell-pipe",
      kind: "STRUCTURAL",
      contentHash: null,
      reproducible: true,
      reproductionCmd: null,
      testFile: null,
      testHash: null,
      testCode: null,
      verifyError: null,
      reasoningHash: null,
      teeAttestationId: null,
    };

    expect(normalizeReportVerdict(report({ proofs: [proof] })).verdict).toBe("DANGEROUS");
  });
});
