import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PackageIntent } from "./intent-extraction.js";
import type { EntryPoints } from "../models.js";
import type { Flag } from "./flag.js";
import { AuditIncompleteError } from "../errors.js";

vi.mock("ai", () => ({
  generateText: vi.fn(),
  tool: vi.fn((def) => def),
  stepCountIs: vi.fn((n) => n),
}));
vi.mock("../llm.js", () => ({ getModel: vi.fn(() => "model") }));

import { generateText } from "ai";
import {
  buildHypothesizePrompt,
  readFocusCode,
  runHypothesize,
  HYPOTHESIZE_SYSTEM,
} from "./hypothesize.js";

const generateTextMock = vi.mocked(generateText);

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

// The typed object the forced submitHypothesis tool call carries: setup is a
// discriminated union ({tool, ...args}), trigger is one typed field.
const validOutput = {
  description: "reads ~/.npmrc and POSTs it to an undocumented host after a date gate",
  claim: { kind: "env_exfil", gating: "time_gate" },
  severity: "high",
  setup: [
    { tool: "setEnv", env: { NPM_TOKEN: "canary" } },
    { tool: "plantFiles", files: [{ path: "/home/node/.npmrc", content: "x" }] },
  ],
  trigger: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null },
};

function mockSubmit(output: unknown) {
  generateTextMock.mockResolvedValue({
    toolCalls: [{ toolName: "submitHypothesis", input: output }],
  } as never);
}

beforeEach(() => {
  generateTextMock.mockReset();
});

// ---------------------------------------------------------------------------
// buildHypothesizePrompt (pure)
// ---------------------------------------------------------------------------

describe("buildHypothesizePrompt", () => {
  it("gives the model the intent, the flag, the tool catalog, and entry points", () => {
    const prompt = buildHypothesizePrompt({ flag, focusCode: "1: doEvilThings()", intent, entryPoints });
    expect(prompt).toContain("Formats strings.");
    expect(prompt).toContain("reads ~/.npmrc"); // the flag's why
    expect(prompt).toContain("doEvilThings"); // the focus code
    expect(prompt).toContain("setEnv");
    expect(prompt).toContain("plantFiles");
    expect(prompt).toContain("trigger");
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
// runHypothesize — one forced tool call, mocked
// ---------------------------------------------------------------------------

describe("runHypothesize", () => {
  const ctx = { packagePath: "/tmp/nope", intent, entryPoints };

  it("converts the typed submit object into an armed hypothesis (setup union + trigger → ToolCall[])", async () => {
    mockSubmit(validOutput);

    const hyps = await runHypothesize([flag], ctx);

    expect(hyps).toHaveLength(1);
    const h = hyps[0]!;
    expect(h.description).toContain("~/.npmrc");
    expect(h.claim.kind).toBe("env_exfil");
    expect(h.severity).toBe("high");
    // setup variants → {tool, args}; trigger → a trigger ToolCall, in order.
    expect(h.experiment.map((c) => c.tool)).toEqual(["setEnv", "plantFiles", "trigger"]);
    expect(h.experiment[0]!.args).toEqual({ env: { NPM_TOKEN: "canary" } });
    expect(h.experiment[1]!.args).toEqual({ files: [{ path: "/home/node/.npmrc", content: "x" }] });
    expect(h.experiment[2]!.args).toMatchObject({ kind: "entrypoint", target: "setup.js" });
    expect(h.focusFiles).toEqual(["setup.js"]);
    expect(h.focusLines).toEqual([{ file: "setup.js", range: "1-10" }]);
    expect(h.createdBy).toBe("hypothesize");
    // Exactly one generation — no hand-coded retry.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("passes a submitHypothesis tool forced by toolChoice", async () => {
    mockSubmit(validOutput);
    await runHypothesize([flag], ctx);
    const arg = generateTextMock.mock.calls[0]![0]! as Record<string, unknown>;
    expect((arg.tools as Record<string, unknown>).submitHypothesis).toBeDefined();
    expect(arg.toolChoice).toEqual({ type: "tool", toolName: "submitHypothesis" });
  });

  it("validates the submission against the schema and repairs an invalid one, then arms", async () => {
    // The backend does not constrain tool args, so a submission can still be
    // schema-invalid (env as a string) — we validate and hand the error back.
    generateTextMock
      .mockResolvedValueOnce({
        toolCalls: [{ toolName: "submitHypothesis", input: { ...validOutput, setup: [{ tool: "setEnv", env: "NPM_TOKEN=x" }] } }],
      } as never)
      .mockResolvedValueOnce({ toolCalls: [{ toolName: "submitHypothesis", input: validOutput }] } as never);

    const hyps = await runHypothesize([flag], ctx);

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    const retryPrompt = generateTextMock.mock.calls[1]![0]!.prompt as string;
    expect(retryPrompt).toMatch(/previous submission was rejected/i);
    expect(retryPrompt).toMatch(/env/); // the exact rejection was handed back
    expect(hyps[0]!.experiment.map((c) => c.tool)).toEqual(["setEnv", "plantFiles", "trigger"]);
  });

  it("raises an audit ERROR after the repair budget is exhausted (never arms an invalid experiment)", async () => {
    mockSubmit({ ...validOutput, setup: [{ tool: "setEnv", env: "still-a-string" }] });
    await expect(runHypothesize([flag], ctx)).rejects.toBeInstanceOf(AuditIncompleteError);
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });

  it("raises an audit ERROR when the model never submits (not a fabricated one)", async () => {
    generateTextMock.mockResolvedValue({ toolCalls: [] } as never);
    await expect(runHypothesize([flag], ctx)).rejects.toBeInstanceOf(AuditIncompleteError);
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });

  it("raises an audit ERROR when the generation call itself keeps failing", async () => {
    generateTextMock.mockRejectedValue(new Error("No object generated"));
    await expect(runHypothesize([flag], ctx)).rejects.toBeInstanceOf(AuditIncompleteError);
    expect(generateTextMock).toHaveBeenCalledTimes(3);
  });
});
