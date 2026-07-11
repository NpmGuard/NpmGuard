import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InventoryReport } from "../models.js";
import type { PackageIntent } from "./intent-extraction.js";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../llm.js", () => ({ getModel: vi.fn(() => "model") }));

import { generateObject } from "ai";
import { buildFlagPrompt, runFlag, FLAG_SYSTEM } from "./flag.js";
import { AuditIncompleteError } from "../errors.js";

const generateObjectMock = vi.mocked(generateObject);

const intent: PackageIntent = {
  statedPurpose: "Parses CSV files into JSON.",
  expectedCapabilities: ["FILESYSTEM"],
  rationale: "CSV parsing reads files; no network or env access is necessary.",
};

function inventoryFor(dir: string, files: string[]): InventoryReport {
  return {
    metadata: { name: "p", version: null, description: null, license: null, homepage: null, keywords: [], repository: null },
    scripts: {},
    entryPoints: { install: [], runtime: ["index.js"], bin: [] },
    dependencies: {},
    files: files.map((p) => ({
      path: p,
      fileType: "js",
      sizeBytes: fs.statSync(path.join(dir, p)).size,
      permissions: "0644",
      isBinary: false,
      binaryType: null,
    })),
    flags: [],
    dealbreaker: null,
  };
}

function withTempPkg(files: Record<string, string>, run: (dir: string, inv: InventoryReport) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npmguard-flag-"));
    try {
      for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), body);
      }
      await run(dir, inventoryFor(dir, Object.keys(files)));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

beforeEach(() => {
  generateObjectMock.mockReset();
});

// ---------------------------------------------------------------------------
// buildFlagPrompt (pure)
// ---------------------------------------------------------------------------

describe("buildFlagPrompt", () => {
  it("gives the model the intent, the file, and structural facts, line-numbered", () => {
    const prompt = buildFlagPrompt({
      fileName: "a.js",
      contents: "alpha\nbeta",
      fileFlags: ["[warn] binary-detected: bin blob"],
      intent,
    });
    expect(prompt).toContain("Parses CSV files into JSON.");
    expect(prompt).toContain("expectedCapabilities: FILESYSTEM");
    expect(prompt).toContain("a.js");
    expect(prompt).toContain("1: alpha");
    expect(prompt).toContain("2: beta");
    expect(prompt).toContain("binary-detected");
  });

  it("the system prompt spells out the dual lens (beyond-intent AND gates/obfuscation) and over-flagging", () => {
    expect(FLAG_SYSTEM).toMatch(/beyond the stated purpose/i);
    expect(FLAG_SYSTEM).toMatch(/obfuscation/i);
    expect(FLAG_SYSTEM).toMatch(/gate/i);
    expect(FLAG_SYSTEM).toMatch(/over-?zealous|over-?flag/i);
  });
});

// ---------------------------------------------------------------------------
// runFlag — LLM-backed, mocked
// ---------------------------------------------------------------------------

describe("runFlag", () => {
  it("emits thin flags with the file attached", withTempPkg(
    { "index.js": "const x = eval(atob('...'));" },
    async (dir, inv) => {
      generateObjectMock.mockResolvedValue({
        object: {
          summary: "decodes and evals a payload",
          capabilities: ["DYNAMIC_CODE"],
          flags: [{ lines: ["1-1"], why: "eval of a base64 blob" }],
        },
      } as never);

      const out = await runFlag(dir, inv, intent);

      expect(out.flags).toEqual([{ file: "index.js", lines: ["1-1"], why: "eval of a base64 blob" }]);
      expect(out.fileSummaries).toHaveLength(1);
      expect(out.fileSummaries[0]!.capabilities).toEqual(["DYNAMIC_CODE"]);
    },
  ));

  it("raises an audit ERROR when the model call fails (not a masked coverage gap)", withTempPkg(
    { "index.js": "const x = 1;" },
    async (dir, inv) => {
      generateObjectMock.mockRejectedValue(new Error("503 upstream"));
      await expect(runFlag(dir, inv, intent)).rejects.toBeInstanceOf(AuditIncompleteError);
    },
  ));

  it("raises an audit ERROR on incoherent output (summary describes a risk but emits no flag)", withTempPkg(
    { "index.js": "harvest();" },
    async (dir, inv) => {
      generateObjectMock.mockResolvedValue({
        object: {
          summary: "steals AWS credentials and exfiltrates them",
          capabilities: [],
          flags: [],
        },
      } as never);
      await expect(runFlag(dir, inv, intent)).rejects.toBeInstanceOf(AuditIncompleteError);
    },
  ));

  it("returns zero flags for genuinely boring code", withTempPkg(
    { "index.js": "module.exports = (n) => n + 1;" },
    async (dir, inv) => {
      generateObjectMock.mockResolvedValue({
        object: { summary: "adds one", capabilities: [], flags: [] },
      } as never);

      const out = await runFlag(dir, inv, intent);
      expect(out.flags).toHaveLength(0);
    },
  ));
});
