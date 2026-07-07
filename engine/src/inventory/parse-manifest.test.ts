import { describe, expect, it } from "vitest";
import { extractScriptFileRef, parsePackageJson } from "./parse-manifest.js";

describe("extractScriptFileRef", () => {
  it("normalizes ./ prefixes in node lifecycle script references", () => {
    expect(extractScriptFileRef("node ./postinstall.mjs")).toBe("postinstall.mjs");
  });

  it("normalizes quoted lifecycle script references", () => {
    expect(extractScriptFileRef('node "./scripts/install.js"')).toBe("scripts/install.js");
  });
});

describe("parsePackageJson", () => {
  it("stores normalized install entry refs", () => {
    const parsed = parsePackageJson({
      main: "index.js",
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
    });

    expect(parsed.entryPoints.install).toEqual(["postinstall.mjs"]);
  });
});
