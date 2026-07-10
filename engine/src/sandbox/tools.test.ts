import { describe, it, expect } from "vitest";
import type { ToolCall } from "@npmguard/shared";
import {
  TOOLS,
  compileExperiment,
  renderToolCatalog,
  ExperimentCompileError,
} from "./tools.js";

const run: ToolCall = { tool: "trigger", args: { kind: "entrypoint", target: "index.js" } };

describe("tool registry", () => {
  it("exposes the starter tools with unique names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ["setEnv", "plantFiles", "setDate", "stubUrl", "patchFile", "preload", "trigger"]) {
      expect(names).toContain(n);
    }
  });

  it("has exactly one trigger tool; the rest are setup", () => {
    expect(TOOLS.filter((t) => t.kind === "trigger").map((t) => t.name)).toEqual(["trigger"]);
    expect(TOOLS.filter((t) => t.kind === "setup").length).toBe(TOOLS.length - 1);
  });

  it("renders a catalog naming every tool (one source for prompt + executor)", () => {
    const catalog = renderToolCatalog();
    for (const t of TOOLS) expect(catalog).toContain(t.name);
  });

  it("renders each tool's concrete arg shape so the model doesn't guess it", () => {
    const catalog = renderToolCatalog();
    // The nested shape the model must match — e.g. setEnv takes { env: {...} }.
    expect(catalog).toContain(`args: {"env":{`);
    expect(catalog).toContain(`args: {"files":[{`);
    // Every rendered example must itself compile against its tool's schema.
    for (const t of TOOLS) {
      const parsed = t.paramSchema.safeParse(t.argsExample);
      expect(parsed.success).toBe(true);
    }
  });
});

describe("compileExperiment", () => {
  it("compiles setup tool calls into manipulations and extracts the one trigger", () => {
    const experiment: ToolCall[] = [
      { tool: "setEnv", args: { env: { NPM_TOKEN: "bait", HOME: "/home/node" } } },
      { tool: "plantFiles", args: { files: [{ path: "/home/node/.npmrc", content: "//x/:_authToken=bait\n" }] } },
      run,
    ];
    const { setup, trigger } = compileExperiment(experiment);

    expect(trigger).toEqual({ kind: "entrypoint", target: "index.js", argv: [], stdin: null });
    expect(setup).toHaveLength(2);
    // The built manipulations actually carry the intended contribution.
    expect(setup[0]!.applied.env).toEqual({ NPM_TOKEN: "bait", HOME: "/home/node" });
    expect(setup[1]!.applied.plantFiles).toEqual([
      { path: "/home/node/.npmrc", contentHash: expect.any(String) },
    ]);
  });

  it("rejects an unknown tool (incoherent experiment → error, not silent skip)", () => {
    expect(() => compileExperiment([{ tool: "rm_rf", args: {} }, run])).toThrow(ExperimentCompileError);
  });

  it("rejects invalid args against the tool's schema (never silently executed)", () => {
    // setEnv expects { env: Record<string,string> }; a number value is invalid.
    const bad: ToolCall = { tool: "setEnv", args: { env: { NPM_TOKEN: 42 } } as unknown as Record<string, string> };
    expect(() => compileExperiment([bad, run])).toThrow(ExperimentCompileError);
  });

  it("rejects an experiment with no trigger (nothing to run)", () => {
    expect(() => compileExperiment([{ tool: "setEnv", args: { env: { A: "1" } } }])).toThrow(
      /no trigger/,
    );
  });

  it("rejects an experiment with more than one trigger (one entrypoint per run)", () => {
    expect(() => compileExperiment([run, run])).toThrow(/more than one trigger/);
  });

  it("propagates a primitive's own validation as a compile error (e.g. bad ISO date)", () => {
    expect(() => compileExperiment([{ tool: "setDate", args: { iso: "not-a-date" } }, run])).toThrow();
  });
});
