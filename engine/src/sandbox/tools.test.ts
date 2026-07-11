import { describe, it, expect } from "vitest";
import type { ToolCall } from "@npmguard/shared";
import {
  TOOLS,
  compileExperiment,
  renderToolCatalog,
  buildExperimentSchema,
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

});

describe("buildExperimentSchema — the typed HYPOTHESIZE generation schema", () => {
  const schema = buildExperimentSchema(["setup.js", "index.js"]);

  it("accepts a well-formed typed experiment (setup union + one trigger target)", () => {
    const r = schema.safeParse({
      setup: [
        { tool: "setEnv", env: { NPM_TOKEN: "bait" } },
        { tool: "plantFiles", files: [{ path: "/home/node/.npmrc", content: "x" }] },
      ],
      trigger: { target: "setup.js" },
    });
    expect(r.success).toBe(true);
  });

  it("rejects the shape that broke us: setEnv.env as a string (no freeform args hole)", () => {
    const r = schema.safeParse({
      setup: [{ tool: "setEnv", env: "NPM_TOKEN=bait" }],
      trigger: { target: "setup.js" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects a trigger target that is not a real package file (enum); kind is not a model field", () => {
    const r = schema.safeParse({ setup: [], trigger: { target: "nope.js" } });
    expect(r.success).toBe(false);
    const ok = schema.safeParse({ setup: [], trigger: { target: "index.js" } });
    expect(ok.success).toBe(true);
  });

  it("has a discriminated-union variant for every setup tool (registry is the source)", () => {
    for (const t of TOOLS) {
      if (t.kind !== "setup") continue;
      const example: Record<string, unknown> = { setEnv: { env: { A: "b" } }, plantFiles: { files: [{ path: "/x", content: "y" }] }, setDate: { iso: "2027-03-01T00:00:00Z" }, stubUrl: { stubs: [{ pattern: "*x*" }] }, patchFile: { patches: [{ path: "a.js", replacements: [{ pattern: "a", replacement: "b" }] }] }, preload: { code: "1" } }[t.name]!;
      const r = schema.safeParse({ setup: [{ tool: t.name, ...example }], trigger: { target: "index.js" } });
      expect(r.success, `variant for ${t.name}`).toBe(true);
    }
  });

  it("tightens setDate.iso to an ISO datetime (a junk date is unrepresentable)", () => {
    const bad = schema.safeParse({ setup: [{ tool: "setDate", iso: "last tuesday" }], trigger: { target: "index.js" } });
    expect(bad.success).toBe(false);
    const good = schema.safeParse({ setup: [{ tool: "setDate", iso: "2027-03-01T00:00:00Z" }], trigger: { target: "index.js" } });
    expect(good.success).toBe(true);
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
