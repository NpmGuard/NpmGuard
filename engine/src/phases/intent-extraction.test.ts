import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PackageIntent,
  buildIntentPrompt,
  fallbackIntent,
  findReadme,
} from "./intent-extraction.js";
import type { InventoryReport } from "../models.js";

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function makeInventory(overrides: Partial<InventoryReport> = {}): InventoryReport {
  return {
    metadata: {
      name: "sample-pkg",
      version: "1.0.0",
      description: "A sample package",
      license: "MIT",
      homepage: null,
      keywords: ["util"],
      repository: null,
    },
    scripts: {},
    entryPoints: { install: [], runtime: ["index.js"], bin: [] },
    dependencies: { prod: {}, dev: {}, optional: {}, peer: {} },
    files: [],
    flags: [],
    dealbreaker: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// PackageIntent schema
// ---------------------------------------------------------------------------

describe("PackageIntent schema", () => {
  it("accepts a well-formed intent", () => {
    const parsed = PackageIntent.parse({
      statedPurpose: "Parses CSV files.",
      expectedCapabilities: ["FILESYSTEM"],
      rationale: "CSV parsing requires reading files.",
    });
    expect(parsed.expectedCapabilities).toEqual(["FILESYSTEM"]);
  });

  it("rejects invalid capability enum values", () => {
    const result = PackageIntent.safeParse({
      statedPurpose: "Does something.",
      expectedCapabilities: ["NOT_A_REAL_CAPABILITY"],
      rationale: "because.",
    });
    expect(result.success).toBe(false);
  });

  it("requires all three fields", () => {
    const missing = PackageIntent.safeParse({
      statedPurpose: "Foo",
      expectedCapabilities: [],
    });
    expect(missing.success).toBe(false);
  });

  it("allows an empty expectedCapabilities array (utility package)", () => {
    const parsed = PackageIntent.parse({
      statedPurpose: "Pure string utilities.",
      expectedCapabilities: [],
      rationale: "String manipulation needs no Node APIs.",
    });
    expect(parsed.expectedCapabilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findReadme
// ---------------------------------------------------------------------------

describe("findReadme", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "intent-readme-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no README exists", () => {
    const inv = makeInventory();
    expect(findReadme(tmp, inv)).toBeNull();
  });

  it("returns null when inventory has non-doc files only", () => {
    fs.writeFileSync(path.join(tmp, "index.js"), "module.exports = 1;");
    const inv = makeInventory({
      files: [
        {
          path: "index.js",
          fileType: "js",
          sizeBytes: 10,
          permissions: "644",
          isBinary: false,
          binaryType: null,
        },
      ],
    });
    expect(findReadme(tmp, inv)).toBeNull();
  });

  it("reads the canonical README.md when classified as doc", () => {
    const content = "# Sample\n\nA tiny package.";
    fs.writeFileSync(path.join(tmp, "README.md"), content);
    const inv = makeInventory({
      files: [
        {
          path: "README.md",
          fileType: "doc",
          sizeBytes: content.length,
          permissions: "644",
          isBinary: false,
          binaryType: null,
        },
      ],
    });
    expect(findReadme(tmp, inv)).toBe(content);
  });

  it("prefers README.md over README.txt when both present", () => {
    fs.writeFileSync(path.join(tmp, "README.md"), "md wins");
    fs.writeFileSync(path.join(tmp, "README.txt"), "txt loses");
    const inv = makeInventory({
      files: [
        { path: "README.md", fileType: "doc", sizeBytes: 7, permissions: "644", isBinary: false, binaryType: null },
        { path: "README.txt", fileType: "doc", sizeBytes: 9, permissions: "644", isBinary: false, binaryType: null },
      ],
    });
    expect(findReadme(tmp, inv)).toBe("md wins");
  });

  it("truncates very large READMEs and annotates the truncation", () => {
    const huge = "x".repeat(20_000);
    fs.writeFileSync(path.join(tmp, "README.md"), huge);
    const inv = makeInventory({
      files: [
        { path: "README.md", fileType: "doc", sizeBytes: huge.length, permissions: "644", isBinary: false, binaryType: null },
      ],
    });
    const out = findReadme(tmp, inv);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(huge.length);
    expect(out!).toContain("truncated");
  });

  it("skips a README listed in inventory but missing on disk", () => {
    const inv = makeInventory({
      files: [
        { path: "README.md", fileType: "doc", sizeBytes: 5, permissions: "644", isBinary: false, binaryType: null },
      ],
    });
    // file declared but not written — read should fail silently and return null
    expect(findReadme(tmp, inv)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildIntentPrompt
// ---------------------------------------------------------------------------

describe("buildIntentPrompt", () => {
  it("includes manifest fields", () => {
    const inv = makeInventory({
      metadata: {
        name: "my-util",
        version: "2.1.0",
        description: "formats strings",
        license: "ISC",
        homepage: "https://example.com",
        keywords: ["format", "string"],
        repository: null,
      },
    });
    const prompt = buildIntentPrompt(inv, null);
    expect(prompt).toContain("my-util");
    expect(prompt).toContain("formats strings");
    expect(prompt).toContain("format, string");
    expect(prompt).toContain("https://example.com");
  });

  it("marks missing README explicitly so the model knows", () => {
    const prompt = buildIntentPrompt(makeInventory(), null);
    expect(prompt).toContain("(no README found)");
  });

  it("includes README content verbatim when provided", () => {
    const readme = "# What\n\nDoes things.";
    const prompt = buildIntentPrompt(makeInventory(), readme);
    expect(prompt).toContain(readme);
  });

  it("lists runtime dependencies when present", () => {
    const inv = makeInventory({
      dependencies: { prod: { axios: "^1.0.0", lodash: "^4.0.0" }, dev: {}, optional: {}, peer: {} },
    });
    const prompt = buildIntentPrompt(inv, null);
    expect(prompt).toContain("axios");
    expect(prompt).toContain("lodash");
  });

  it("omits the deps section entirely when prod deps is empty", () => {
    const prompt = buildIntentPrompt(makeInventory(), null);
    expect(prompt).not.toContain("## Runtime dependencies");
  });

  it("includes bin entries when declared", () => {
    const inv = makeInventory({
      entryPoints: { install: [], runtime: ["index.js"], bin: ["./bin/my-tool.js"] },
    });
    const prompt = buildIntentPrompt(inv, null);
    expect(prompt).toContain("./bin/my-tool.js");
  });

  it("handles an empty keywords array with '(none)' marker", () => {
    const inv = makeInventory({
      metadata: { ...makeInventory().metadata, keywords: [] },
    });
    const prompt = buildIntentPrompt(inv, null);
    expect(prompt).toContain("keywords: (none)");
  });
});

// ---------------------------------------------------------------------------
// fallbackIntent
// ---------------------------------------------------------------------------

describe("fallbackIntent", () => {
  it("uses description when present", () => {
    const inv = makeInventory({
      metadata: { ...makeInventory().metadata, description: "a CSV parser" },
    });
    const intent = fallbackIntent(inv);
    expect(intent.statedPurpose).toBe("a CSV parser");
    expect(intent.expectedCapabilities).toEqual([]);
  });

  it("reports 'no stated purpose' when description is empty", () => {
    const inv = makeInventory({
      metadata: { ...makeInventory().metadata, description: "" },
    });
    const intent = fallbackIntent(inv);
    expect(intent.statedPurpose).toContain("no stated purpose");
  });

  it("reports 'no stated purpose' when description is null", () => {
    const inv = makeInventory({
      metadata: { ...makeInventory().metadata, description: null },
    });
    const intent = fallbackIntent(inv);
    expect(intent.statedPurpose).toContain("no stated purpose");
  });

  it("always validates against the PackageIntent schema", () => {
    const inv = makeInventory();
    const intent = fallbackIntent(inv);
    const result = PackageIntent.safeParse(intent);
    expect(result.success).toBe(true);
  });
});
