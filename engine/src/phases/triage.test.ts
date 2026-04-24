import { describe, it, expect } from "vitest";
import { Hypothesis } from "@npmguard/shared";
import { buildMapPrompt, draftToHypothesis, MAP_SYSTEM } from "./triage.js";
import type { PackageIntent } from "./intent-extraction.js";

const intent: PackageIntent = {
  statedPurpose: "Parses CSV files into JSON.",
  expectedCapabilities: ["FILESYSTEM"],
  rationale: "CSV parsing reads files; no network or env access is necessary.",
};

// ---------------------------------------------------------------------------
// buildMapPrompt
// ---------------------------------------------------------------------------

describe("buildMapPrompt", () => {
  it("includes the package intent so MAP can reason about capability mismatch", () => {
    const prompt = buildMapPrompt({
      fileName: "index.js",
      contents: "console.log('x');",
      fileFlags: [],
      intent,
    });
    expect(prompt).toContain("Parses CSV files into JSON.");
    expect(prompt).toContain("expectedCapabilities: FILESYSTEM");
    expect(prompt).toContain("CSV parsing reads files");
  });

  it("numbers file lines so MAP can return stable ranges", () => {
    const prompt = buildMapPrompt({
      fileName: "a.js",
      contents: "alpha\nbeta\ngamma",
      fileFlags: [],
      intent,
    });
    expect(prompt).toContain("1: alpha");
    expect(prompt).toContain("2: beta");
    expect(prompt).toContain("3: gamma");
  });

  it("includes structural flags when provided", () => {
    const prompt = buildMapPrompt({
      fileName: "lib.js",
      contents: "x",
      fileFlags: ["[warn] eval-present: eval() used"],
      intent,
    });
    expect(prompt).toContain("## Structural flags for this file");
    expect(prompt).toContain("eval-present");
  });

  it("omits the flags section when none are given", () => {
    const prompt = buildMapPrompt({
      fileName: "lib.js",
      contents: "x",
      fileFlags: [],
      intent,
    });
    expect(prompt).not.toContain("## Structural flags");
  });

  it("renders an empty expectedCapabilities list with a clear marker", () => {
    const prompt = buildMapPrompt({
      fileName: "lib.js",
      contents: "x",
      fileFlags: [],
      intent: { ...intent, expectedCapabilities: [] },
    });
    expect(prompt).toContain("expectedCapabilities: (none");
  });
});

describe("MAP_SYSTEM", () => {
  it("instructs the model to emit zero hypotheses for boring code", () => {
    expect(MAP_SYSTEM).toContain("Return zero hypotheses if the file is boring utility code.");
  });

  it("includes the capability mismatch rule", () => {
    expect(MAP_SYSTEM.toLowerCase()).toContain("capability");
    expect(MAP_SYSTEM.toLowerCase()).toContain("mismatch");
  });
});

// ---------------------------------------------------------------------------
// draftToHypothesis
// ---------------------------------------------------------------------------

describe("draftToHypothesis", () => {
  const now = "2026-04-24T12:00:00.000Z";

  it("produces a valid Hypothesis with scaffolded defaults", () => {
    const h = draftToHypothesis({
      draft: {
        description: "reads ~/.npmrc and POSTs it to attacker.com",
        claim: { kind: "env_exfil", gating: null },
        severity: "high",
        rangesInFile: ["42-67"],
      },
      file: "lib/setup.js",
      hypId: "trg-0001",
      now,
    });

    expect(Hypothesis.parse(h)).toEqual(h); // schema-valid
    expect(h.hypId).toBe("trg-0001");
    expect(h.state).toBe("OPEN");
    expect(h.createdBy).toBe("triage");
    expect(h.focusFiles).toEqual(["lib/setup.js"]);
    expect(h.focusLines).toEqual([{ file: "lib/setup.js", range: "42-67" }]);
    expect(h.evidenceRefs).toEqual([]);
    expect(h.parentHypId).toBeNull();
    expect(h.childHypIds).toEqual([]);
    expect(h.resolvedAt).toBeNull();
    expect(h.resolution).toBeNull();
    expect(h.createdAt).toBe(now);
  });

  it("creates one focusLine per range in rangesInFile", () => {
    const h = draftToHypothesis({
      draft: {
        description: "scattered obfuscation",
        claim: { kind: "obfuscation", gating: null },
        severity: "medium",
        rangesInFile: ["12-30", "55-80", "120-125"],
      },
      file: "dist/bundle.js",
      hypId: "trg-0002",
      now,
    });
    expect(h.focusLines).toEqual([
      { file: "dist/bundle.js", range: "12-30" },
      { file: "dist/bundle.js", range: "55-80" },
      { file: "dist/bundle.js", range: "120-125" },
    ]);
  });

  it("preserves gating modifier when provided", () => {
    const h = draftToHypothesis({
      draft: {
        description: "runs only under CI env",
        claim: { kind: "env_exfil", gating: "ci_gate" },
        severity: "high",
        rangesInFile: ["10-20"],
      },
      file: "setup.js",
      hypId: "trg-0003",
      now,
    });
    expect(h.claim.gating).toBe("ci_gate");
  });

  it("defaults gating to null when undefined", () => {
    const h = draftToHypothesis({
      draft: {
        description: "x",
        claim: { kind: "telemetry", gating: null },
        severity: "low",
        rangesInFile: ["1-1"],
      },
      file: "a.js",
      hypId: "trg-0004",
      now,
    });
    expect(h.claim.gating).toBeNull();
  });
});
