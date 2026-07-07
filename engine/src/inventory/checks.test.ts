import { describe, expect, it } from "vitest";
import { runInventoryChecks } from "./checks.js";

describe("runInventoryChecks", () => {
  it("flags HTTP dependency URL specifiers", () => {
    const { flags } = runInventoryChecks(
      {},
      { install: [], runtime: ["index.js"], bin: [] },
      [],
      "/tmp/does-not-matter",
      {
        prod: {
          "ui-styles-pkg": "http://packages.storeartifact.com/npm/badgekit-api-client",
        },
        dev: {},
        optional: {},
        peer: {},
      },
    );

    expect(flags).toContainEqual({
      severity: "warn",
      check: "dependency-url",
      detail:
        "prod dependency 'ui-styles-pkg' uses URL specifier: http://packages.storeartifact.com/npm/badgekit-api-client",
      file: "package.json",
    });
  });
});
