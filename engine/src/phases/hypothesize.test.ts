import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Hypothesis, ToolCall } from "@npmguard/shared";
import type { PackageIntent } from "./intent-extraction.js";
import type { EntryPoints } from "../models.js";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../llm.js", () => ({ getModel: vi.fn(() => "model") }));

import { generateObject } from "ai";
import {
  buildHypothesizePrompt,
  readFocusCode,
  validateExperiment,
  runHypothesize,
  HYPOTHESIZE_SYSTEM,
} from "./hypothesize.js";

const generateObjectMock = vi.mocked(generateObject);

const intent: PackageIntent = {
  statedPurpose: "Formats strings.",
  expectedCapabilities: [],
  rationale: "Pure string formatting needs no IO.",
};

const entryPoints: EntryPoints = { install: ["setup.js"], runtime: ["index.js"], bin: [] };

function hyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypId: "h1",
    description: "reads ~/.npmrc and POSTs it to an undocumented host",
    claim: { kind: "env_exfil", gating: "time_gate" },
    focusFiles: ["setup.js"],
    focusLines: [{ file: "setup.js", range: "1-10" }],
    experiment: [],
    severity: "high",
    parentHypId: null,
    childHypIds: [],
    state: "OPEN",
    createdBy: "triage",
    evidenceRefs: [],
    createdAt: "2026-07-10T00:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    ...overrides,
  };
}

const validExperiment: ToolCall[] = [
  { tool: "setEnv", args: { env: { NPM_TOKEN: "canary" } } },
  { tool: "plantFiles", args: { files: [{ path: "/home/node/.npmrc", content: "x" }] } },
  { tool: "trigger", args: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null } },
];

beforeEach(() => {
  generateObjectMock.mockReset();
});

// ---------------------------------------------------------------------------
// buildHypothesizePrompt (pure)
// ---------------------------------------------------------------------------

describe("buildHypothesizePrompt", () => {
  it("gives the model the intent, the hypothesis, the tool catalog, and entry points", () => {
    const prompt = buildHypothesizePrompt({
      hypothesis: hyp(),
      focusCode: "1: doEvilThings()",
      intent,
      entryPoints,
    });
    expect(prompt).toContain("Formats strings.");
    expect(prompt).toContain("reads ~/.npmrc");
    expect(prompt).toContain("doEvilThings");
    // The catalog is rendered from the registry — the tools must be offered by name.
    expect(prompt).toContain("setEnv");
    expect(prompt).toContain("plantFiles");
    expect(prompt).toContain("trigger");
    // Entry points are candidate trigger targets.
    expect(prompt).toContain("setup.js");
    expect(prompt).toContain("index.js");
  });

  it("tells the model a spotted gate must be defeated", () => {
    const prompt = buildHypothesizePrompt({
      hypothesis: hyp({ claim: { kind: "env_exfil", gating: "time_gate" } }),
      focusCode: "",
      intent,
      entryPoints,
    });
    expect(prompt).toContain("time_gate");
    expect(prompt).toMatch(/defeat/i);
  });

  it("the system prompt forbids a benign refusal (no dismissal)", () => {
    expect(HYPOTHESIZE_SYSTEM).toMatch(/never refuse/i);
  });
});

// ---------------------------------------------------------------------------
// readFocusCode (pure, touches disk)
// ---------------------------------------------------------------------------

describe("readFocusCode", () => {
  it("reads the focus file and line-numbers it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npmguard-hyp-"));
    try {
      fs.writeFileSync(path.join(dir, "setup.js"), "const a = 1;\nsteal();");
      const code = readFocusCode(dir, hyp({ focusFiles: ["setup.js"] }));
      expect(code).toContain("1: const a = 1;");
      expect(code).toContain("2: steal();");
      expect(code).toContain("setup.js");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips unreadable files without throwing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npmguard-hyp-"));
    try {
      const code = readFocusCode(dir, hyp({ focusFiles: ["does-not-exist.js"] }));
      expect(code).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// validateExperiment — the registry is the one contract
// ---------------------------------------------------------------------------

describe("validateExperiment", () => {
  it("accepts a well-formed experiment (bait + one trigger)", () => {
    const r = validateExperiment(validExperiment);
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown tool", () => {
    const r = validateExperiment([{ tool: "rm_rf_slash", args: {} }, ...validExperiment]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown tool/i);
  });

  it("rejects an experiment with no trigger", () => {
    const r = validateExperiment([{ tool: "setEnv", args: { env: { A: "b" } } }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no trigger/i);
  });

  it("rejects bad args for a known tool", () => {
    const r = validateExperiment([
      { tool: "setEnv", args: { env: "not-an-object" } },
      { tool: "trigger", args: { kind: "entrypoint", target: "x.js", argv: [], stdin: null } },
    ]);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runHypothesize — LLM-backed, mocked
// ---------------------------------------------------------------------------

describe("runHypothesize", () => {
  const ctx = { packagePath: "/tmp/nope", intent, entryPoints };

  it("arms each node with the experiment the model composed", async () => {
    generateObjectMock.mockResolvedValue({
      object: { reasoning: "plant bait and trigger install", experiment: validExperiment },
    } as never);

    const out = await runHypothesize([hyp()], ctx);

    expect(out.experiments).toHaveLength(1);
    expect(out.experiments[0]!.experiment.map((c) => c.tool)).toEqual(["setEnv", "plantFiles", "trigger"]);
    expect(out.failures).toHaveLength(0);
  });

  it("retries once when the first experiment is invalid, then succeeds", async () => {
    generateObjectMock
      .mockResolvedValueOnce({ object: { reasoning: "oops", experiment: [{ tool: "bogus", args: {} }] } } as never)
      .mockResolvedValueOnce({ object: { reasoning: "fixed", experiment: validExperiment } } as never);

    const out = await runHypothesize([hyp()], ctx);

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    expect(out.experiments[0]!.experiment).toHaveLength(3);
    expect(out.failures).toHaveLength(0);
  });

  it("records a coverage gap (empty experiment) when both attempts are invalid — never a silent pass", async () => {
    generateObjectMock.mockResolvedValue({
      object: { reasoning: "still bad", experiment: [{ tool: "bogus", args: {} }] },
    } as never);

    const out = await runHypothesize([hyp()], ctx);

    expect(out.experiments[0]!.experiment).toEqual([]);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0]!.hypId).toBe("h1");
  });
});
