import { describe, expect, it } from "vitest";

import { TESTGEN_SYSTEM_PROMPT } from "./test-gen-prompt.js";

describe("TESTGEN_SYSTEM_PROMPT", () => {
  it("explains how to call transpiled ESM default exports", () => {
    expect(TESTGEN_SYSTEM_PROMPT).toContain("exports.default = ...");
    expect(TESTGEN_SYSTEM_PROMPT).toContain("loaded?.default ?? loaded");
    expect(TESTGEN_SYSTEM_PROMPT).toContain("module namespace");
    expect(TESTGEN_SYSTEM_PROMPT).toContain("module.exports = function");
  });
});
