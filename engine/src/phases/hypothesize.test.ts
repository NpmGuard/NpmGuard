import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolCall } from "@npmguard/shared";
import type { PackageIntent } from "./intent-extraction.js";
import type { EntryPoints } from "../models.js";
import type { Flag } from "./flag.js";
import { AuditIncompleteError } from "../errors.js";

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

const flag: Flag = {
  file: "setup.js",
  lines: ["1-10"],
  why: "reads ~/.npmrc then POSTs to a string-built URL, only after a date check",
};

const validExperiment: ToolCall[] = [
  { tool: "setEnv", args: { env: { NPM_TOKEN: "canary" } } },
  { tool: "plantFiles", args: { files: [{ path: "/home/node/.npmrc", content: "x" }] } },
  { tool: "trigger", args: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null } },
];

const validResponse = {
  description: "reads ~/.npmrc and POSTs it to an undocumented host after a date gate",
  claim: { kind: "env_exfil", gating: "time_gate" },
  severity: "high",
  reasoning: "plant npmrc bait, advance the clock past the gate, trigger the install script",
  experiment: validExperiment,
};

beforeEach(() => {
  generateObjectMock.mockReset();
});

// ---------------------------------------------------------------------------
// buildHypothesizePrompt (pure)
// ---------------------------------------------------------------------------

describe("buildHypothesizePrompt", () => {
  it("gives the model the intent, the flag, the tool catalog, and entry points", () => {
    const prompt = buildHypothesizePrompt({
      flag,
      focusCode: "1: doEvilThings()",
      intent,
      entryPoints,
    });
    expect(prompt).toContain("Formats strings.");
    expect(prompt).toContain("reads ~/.npmrc"); // the flag's why
    expect(prompt).toContain("doEvilThings"); // the focus code
    // The catalog is rendered from the registry — tools offered by name.
    expect(prompt).toContain("setEnv");
    expect(prompt).toContain("plantFiles");
    expect(prompt).toContain("trigger");
    // Entry points are candidate trigger targets.
    expect(prompt).toContain("setup.js");
    expect(prompt).toContain("index.js");
  });

  it("the system prompt forbids a benign refusal (no dismissal)", () => {
    expect(HYPOTHESIZE_SYSTEM).toMatch(/never refuse/i);
  });
});

// ---------------------------------------------------------------------------
// readFocusCode (pure, touches disk)
// ---------------------------------------------------------------------------

describe("readFocusCode", () => {
  it("reads the flagged file and line-numbers it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npmguard-hyp-"));
    try {
      fs.writeFileSync(path.join(dir, "setup.js"), "const a = 1;\nsteal();");
      const code = readFocusCode(dir, flag);
      expect(code).toContain("1: const a = 1;");
      expect(code).toContain("2: steal();");
      expect(code).toContain("setup.js");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty string for an unreadable file (no throw)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npmguard-hyp-"));
    try {
      expect(readFocusCode(dir, { ...flag, file: "nope.js" })).toBe("");
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
    expect(validateExperiment(validExperiment).ok).toBe(true);
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

  it("arms each flag into a hypothesis (description + label + experiment)", async () => {
    generateObjectMock.mockResolvedValue({ object: validResponse } as never);

    const hyps = await runHypothesize([flag], ctx);

    expect(hyps).toHaveLength(1);
    const h = hyps[0]!;
    expect(h.description).toContain("~/.npmrc");
    expect(h.claim.kind).toBe("env_exfil");
    expect(h.experiment.map((c) => c.tool)).toEqual(["setEnv", "plantFiles", "trigger"]);
    // Focus carries the flag's location.
    expect(h.focusFiles).toEqual(["setup.js"]);
    expect(h.focusLines).toEqual([{ file: "setup.js", range: "1-10" }]);
    expect(h.createdBy).toBe("hypothesize");
  });

  it("retries once with the rejection when the first experiment is invalid, then arms", async () => {
    generateObjectMock
      .mockResolvedValueOnce({
        object: { ...validResponse, experiment: [{ tool: "setEnv", args: { env: "NPM_TOKEN=x" } }] },
      } as never)
      .mockResolvedValueOnce({ object: validResponse } as never);

    const hyps = await runHypothesize([flag], ctx);

    expect(generateObjectMock).toHaveBeenCalledTimes(2);
    // The retry prompt carries the exact registry rejection back to the model.
    const retryPrompt = generateObjectMock.mock.calls[1]![0]!.prompt as string;
    expect(retryPrompt).toMatch(/previous experiment was rejected/i);
    expect(hyps[0]!.experiment.map((c) => c.tool)).toEqual(["setEnv", "plantFiles", "trigger"]);
  });

  it("raises an audit ERROR when the experiment is still invalid after the retry (not a hypothesis)", async () => {
    generateObjectMock.mockResolvedValue({
      object: { ...validResponse, experiment: [{ tool: "bogus", args: {} }] },
    } as never);

    await expect(runHypothesize([flag], ctx)).rejects.toBeInstanceOf(AuditIncompleteError);
    expect(generateObjectMock).toHaveBeenCalledTimes(2);
  });

  it("raises an audit ERROR when the model call itself fails (no fabricated hypothesis)", async () => {
    generateObjectMock.mockRejectedValue(new Error("503 upstream"));

    await expect(runHypothesize([flag], ctx)).rejects.toBeInstanceOf(AuditIncompleteError);
  });
});
