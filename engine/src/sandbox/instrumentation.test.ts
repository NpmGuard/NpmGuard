import { describe, it, expect } from "vitest";
import { buildInstrumentation } from "./instrumentation.js";

describe("buildInstrumentation", () => {
  it("always includes the monkey-patch and the exit flush", () => {
    for (const inspector of [true, false]) {
      const src = buildInstrumentation({ inspector });
      expect(src).toContain("Module._resolveFilename"); // require hook
      expect(src).toContain("__NPMGUARD_TRACE__"); // flush marker
    }
  });

  it("adds the in-process inspector layer only when asked", () => {
    const withInspector = buildInstrumentation({ inspector: true });
    const without = buildInstrumentation({ inspector: false });

    expect(withInspector).toContain("require('inspector')");
    expect(withInspector).toContain("Debugger.scriptParsed");
    expect(withInspector).toContain("Debugger.setSkipAllPauses"); // never halts the unattended process
    expect(without).not.toContain("inspector");
    expect(without).not.toContain("scriptParsed");
  });

  it("produces valid JavaScript for both forms", () => {
    // Compiling with the Function constructor parses without executing.
    expect(() => new Function(buildInstrumentation({ inspector: true }))).not.toThrow();
    expect(() => new Function(buildInstrumentation({ inspector: false }))).not.toThrow();
  });
});
