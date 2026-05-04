import { describe, it, expect } from "vitest";
import type { Hypothesis, EvidenceRef } from "@npmguard/shared";
import type { Finding, Proof } from "../models.js";
import { HypothesisGraph } from "../graph/hypothesis-graph.js";
import {
  claimMatchesCapability,
  parseFileLine,
  fileOverlapScore,
  scoreFindingHypothesis,
  bestMatch,
  correlateAfterInvestigation,
  correlateAfterVerify,
} from "./correlate.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypId: overrides.hypId ?? "trg-0001",
    description: overrides.description ?? "reads NPM_TOKEN and POSTs it",
    claim: overrides.claim ?? { kind: "env_exfil", gating: null },
    focusFiles: overrides.focusFiles ?? ["lib/setup.js"],
    focusLines: overrides.focusLines ?? [{ file: "lib/setup.js", range: "42-58" }],
    severity: overrides.severity ?? "high",
    parentHypId: null,
    childHypIds: [],
    state: overrides.state ?? "OPEN",
    createdBy: "triage",
    evidenceRefs: [],
    createdAt: "2026-04-24T12:00:00.000Z",
    resolvedAt: null,
    resolution: null,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    capability: overrides.capability ?? "ENV_VARS",
    confidence: overrides.confidence ?? "LIKELY",
    fileLine: overrides.fileLine ?? "lib/setup.js:42-67",
    problem: overrides.problem ?? "reads process.env.NPM_TOKEN",
    evidence: overrides.evidence ?? "found env access at line 42",
    reproductionStrategy: overrides.reproductionStrategy ?? "",
  };
}

function proof(overrides: Partial<Proof> = {}): Proof {
  return {
    capability: overrides.capability ?? "ENV_VARS",
    attackPathway: "",
    confidence: overrides.confidence ?? "CONFIRMED",
    fileLine: overrides.fileLine ?? "lib/setup.js:42-67",
    problem: overrides.problem ?? "reads process.env.NPM_TOKEN",
    evidence: overrides.evidence ?? "test confirmed env access",
    kind: overrides.kind ?? "TEST_CONFIRMED",
    contentHash: overrides.contentHash ?? null,
    reproducible: true,
    reproductionCmd: null,
    testFile: overrides.testFile ?? "/tmp/test.ts",
    testHash: overrides.testHash ?? "abc123",
    testCode: null,
    verifyError: null,
    reasoningHash: null,
    teeAttestationId: null,
  };
}

// ---------------------------------------------------------------------------
// claimMatchesCapability
// ---------------------------------------------------------------------------

describe("claimMatchesCapability", () => {
  it("env_exfil matches ENV_VARS", () => {
    expect(claimMatchesCapability("env_exfil", "ENV_VARS")).toBe(true);
  });

  it("env_exfil matches NPM_TOKEN_ABUSE", () => {
    expect(claimMatchesCapability("env_exfil", "NPM_TOKEN_ABUSE")).toBe(true);
  });

  it("env_exfil does NOT match DOM_INJECT", () => {
    expect(claimMatchesCapability("env_exfil", "DOM_INJECT")).toBe(false);
  });

  it("dos_loop matches DOS_LOOP", () => {
    expect(claimMatchesCapability("dos_loop", "DOS_LOOP")).toBe(true);
  });

  it("obfuscation matches EVAL and ENCRYPTED_PAYLOAD", () => {
    expect(claimMatchesCapability("obfuscation", "EVAL")).toBe(true);
    expect(claimMatchesCapability("obfuscation", "ENCRYPTED_PAYLOAD")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseFileLine
// ---------------------------------------------------------------------------

describe("parseFileLine", () => {
  it("parses file:start-end", () => {
    expect(parseFileLine("lib/setup.js:42-67")).toEqual({
      file: "lib/setup.js",
      startLine: 42,
      endLine: 67,
    });
  });

  it("parses file:line (single line)", () => {
    expect(parseFileLine("index.js:10")).toEqual({
      file: "index.js",
      startLine: 10,
      endLine: 10,
    });
  });

  it("parses file-only (no colon)", () => {
    expect(parseFileLine("lib/util.js")).toEqual({
      file: "lib/util.js",
      startLine: null,
      endLine: null,
    });
  });

  it("handles deeply nested paths", () => {
    expect(parseFileLine("src/a/b/c.ts:1-100")).toEqual({
      file: "src/a/b/c.ts",
      startLine: 1,
      endLine: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// fileOverlapScore
// ---------------------------------------------------------------------------

describe("fileOverlapScore", () => {
  const h = hyp({
    focusFiles: ["lib/setup.js"],
    focusLines: [{ file: "lib/setup.js", range: "42-58" }],
  });

  it("returns 0 for a different file", () => {
    expect(fileOverlapScore({ file: "other.js", startLine: 42, endLine: 50 }, h)).toBe(0);
  });

  it("returns 1 for same file but different line range", () => {
    expect(fileOverlapScore({ file: "lib/setup.js", startLine: 100, endLine: 110 }, h)).toBe(1);
  });

  it("returns 2 for overlapping line range", () => {
    expect(fileOverlapScore({ file: "lib/setup.js", startLine: 50, endLine: 70 }, h)).toBe(2);
  });

  it("returns 1 when finding has no line numbers", () => {
    expect(fileOverlapScore({ file: "lib/setup.js", startLine: null, endLine: null }, h)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scoreFindingHypothesis
// ---------------------------------------------------------------------------

describe("scoreFindingHypothesis", () => {
  it("scores high when file overlaps and claim matches", () => {
    const h = hyp({ claim: { kind: "env_exfil", gating: null } });
    const f = finding({ capability: "ENV_VARS", fileLine: "lib/setup.js:50-55" });
    const score = scoreFindingHypothesis(f, h);
    expect(score.fileScore).toBe(2);
    expect(score.claimScore).toBe(3);
    expect(score.score).toBe(5);
  });

  it("scores medium when file matches but claim does not", () => {
    const h = hyp({ claim: { kind: "env_exfil", gating: null } });
    const f = finding({ capability: "DOM_INJECT", fileLine: "lib/setup.js:50-55" });
    const score = scoreFindingHypothesis(f, h);
    expect(score.fileScore).toBe(2);
    expect(score.claimScore).toBe(0);
    expect(score.score).toBe(2);
  });

  it("scores zero when neither file nor claim matches", () => {
    const h = hyp({ claim: { kind: "dos_loop", gating: null }, focusFiles: ["other.js"] });
    const f = finding({ capability: "ENV_VARS", fileLine: "lib/setup.js:50-55" });
    const score = scoreFindingHypothesis(f, h);
    expect(score.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bestMatch
// ---------------------------------------------------------------------------

describe("bestMatch", () => {
  it("returns best-scoring hypothesis when multiple candidates", () => {
    const h1 = hyp({
      hypId: "h1",
      claim: { kind: "env_exfil", gating: null },
      focusFiles: ["lib/setup.js"],
      focusLines: [{ file: "lib/setup.js", range: "42-58" }],
    });
    const h2 = hyp({
      hypId: "h2",
      claim: { kind: "dos_loop", gating: null },
      focusFiles: ["lib/setup.js"],
      focusLines: [{ file: "lib/setup.js", range: "100-120" }],
    });
    const f = finding({ capability: "ENV_VARS", fileLine: "lib/setup.js:45-50" });
    const result = bestMatch(f, [h1, h2]);
    expect(result).not.toBeNull();
    expect(result!.hypothesis.hypId).toBe("h1");
  });

  it("returns null when no hypothesis scores above threshold", () => {
    const h = hyp({ focusFiles: ["other.js"] });
    const f = finding({ fileLine: "lib/setup.js:42-67" });
    expect(bestMatch(f, [h])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// correlateAfterInvestigation
// ---------------------------------------------------------------------------

describe("correlateAfterInvestigation", () => {
  it("transitions matched hypotheses to IN_PROGRESS", () => {
    const g = new HypothesisGraph("a1");
    g.add(hyp({ hypId: "h1" }));
    g.add(hyp({
      hypId: "h2",
      claim: { kind: "dos_loop", gating: null },
      focusFiles: ["other.js"],
      focusLines: [{ file: "other.js", range: "1-10" }],
    }));

    const result = correlateAfterInvestigation(g, {
      capabilities: [],
      proofs: [],
      findings: [finding()],
      toolCalls: [],
      agentText: "",
    });

    expect(result.matched.length).toBe(1);
    expect(result.matched[0]!.hypId).toBe("h1");
    expect(g.get("h1").state).toBe("IN_PROGRESS");
    expect(g.get("h1").evidenceRefs.length).toBe(1);
    expect(g.get("h2").state).toBe("OPEN"); // unmatched stays OPEN
  });

  it("does not match the same hypothesis twice", () => {
    const g = new HypothesisGraph("a1");
    g.add(hyp({ hypId: "h1" }));

    const result = correlateAfterInvestigation(g, {
      capabilities: [],
      proofs: [],
      findings: [
        finding({ fileLine: "lib/setup.js:42-50" }),
        finding({ fileLine: "lib/setup.js:42-55" }),
      ],
      toolCalls: [],
      agentText: "",
    });

    expect(result.matched.length).toBe(1);
    expect(result.unmatched.length).toBe(1);
  });

  it("handles empty findings gracefully", () => {
    const g = new HypothesisGraph("a1");
    g.add(hyp());
    const result = correlateAfterInvestigation(g, {
      capabilities: [],
      proofs: [],
      findings: [],
      toolCalls: [],
      agentText: "",
    });
    expect(result.matched.length).toBe(0);
    expect(g.get("trg-0001").state).toBe("OPEN");
  });
});

// ---------------------------------------------------------------------------
// correlateAfterVerify
// ---------------------------------------------------------------------------

describe("correlateAfterVerify", () => {
  it("transitions IN_PROGRESS → CONFIRMED for TEST_CONFIRMED proofs", () => {
    const g = new HypothesisGraph("a1");
    g.add(hyp({ hypId: "h1" }));
    g.transition("h1", { to: "IN_PROGRESS", by: "correlator:investigation" });

    const f = finding();
    const p = proof();

    const result = correlateAfterVerify(g, [p], [f]);
    expect(result.confirmed).toContain("h1");
    expect(g.get("h1").state).toBe("CONFIRMED");
    expect(g.get("h1").evidenceRefs.length).toBeGreaterThan(0);
  });

  it("transitions remaining OPEN/IN_PROGRESS to INCONCLUSIVE", () => {
    const g = new HypothesisGraph("a1");
    g.add(hyp({ hypId: "h1" }));
    g.add(hyp({
      hypId: "h2",
      focusFiles: ["other.js"],
      focusLines: [{ file: "other.js", range: "1-5" }],
    }));
    g.transition("h1", { to: "IN_PROGRESS", by: "correlator:investigation" });
    // h2 stays OPEN

    // No confirmed proofs
    const result = correlateAfterVerify(g, [], []);
    expect(result.inconclusive).toContain("h1");
    expect(result.inconclusive).toContain("h2");
    expect(g.get("h1").state).toBe("INCONCLUSIVE");
    expect(g.get("h2").state).toBe("INCONCLUSIVE");
  });

  it("confirmed + inconclusive mix: some proofs match, some do not", () => {
    const g = new HypothesisGraph("a1");
    g.add(hyp({ hypId: "h1" }));
    g.add(hyp({
      hypId: "h2",
      claim: { kind: "dos_loop", gating: null },
      focusFiles: ["loop.js"],
      focusLines: [{ file: "loop.js", range: "1-5" }],
    }));
    g.transition("h1", { to: "IN_PROGRESS", by: "correlator:investigation" });
    g.transition("h2", { to: "IN_PROGRESS", by: "correlator:investigation" });

    const f = finding();
    const p = proof(); // matches h1's file + capability

    const result = correlateAfterVerify(g, [p], [f]);
    expect(result.confirmed).toContain("h1");
    expect(result.inconclusive).toContain("h2");
    expect(g.get("h1").state).toBe("CONFIRMED");
    expect(g.get("h2").state).toBe("INCONCLUSIVE");
  });
});
