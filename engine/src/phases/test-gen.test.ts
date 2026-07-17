import { describe, expect, it } from "vitest";

import type { InvestigationResult } from "./investigate.js";
import { generateTests } from "./test-gen.js";

describe("generateTests", () => {
  it("does not generate a harness test for a caller-manufactured ReDoS input", async () => {
    const finding = {
      capability: "DOS_LOOP" as const,
      confidence: "LIKELY" as const,
      fileLine: "ignore.js:10",
      problem:
        "Potential ReDoS when eslint-module-utils constructs a RegExp from import/ignore settings.",
      evidence:
        "ignore.js calls new RegExp(ignoreStrings[i]) where ignoreStrings comes from context.settings['import/ignore'].",
      reproductionStrategy:
        "Provide a crafted, complex regular expression via context.settings['import/ignore'] to cause excessive processing time.",
    };
    const investigation: InvestigationResult = {
      capabilities: ["DOS_LOOP"],
      findings: [finding],
      proofs: [{
        capability: "DOS_LOOP",
        attackPathway: "",
        confidence: "LIKELY",
        fileLine: finding.fileLine,
        problem: finding.problem,
        evidence: finding.evidence,
        kind: "AI_STATIC",
        contentHash: null,
        reproducible: false,
        reproductionCmd: null,
        testFile: null,
        testHash: null,
        testCode: null,
        verifyError: null,
        reasoningHash: null,
        teeAttestationId: null,
      }],
      toolCalls: [],
      agentText: "",
    };

    const result = await generateTests(
      investigation,
      "/path/that/must/not/be-read/eslint-module-utils",
    );

    expect(result).toEqual(investigation.proofs);
    expect(result[0]?.testFile).toBeNull();
  });
});
