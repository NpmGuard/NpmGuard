import { describe, it, expect } from "vitest";
import { setEnv } from "./env.js";
import { setDate } from "./date.js";
import { preload } from "./preload.js";
import { plantFiles } from "./plant-files.js";
import { patchFile } from "./patch-file.js";
import { stubUrl } from "./stub-url.js";
import { sha256Hex } from "../evidence/hashing.js";

describe("setEnv", () => {
  it("emits envs into spec and applied.env verbatim", () => {
    const r = setEnv({ CI: "true", NPM_TOKEN: "fake" });
    expect(r.envs).toEqual({ CI: "true", NPM_TOKEN: "fake" });
    expect(r.applied.env).toEqual({ CI: "true", NPM_TOKEN: "fake" });
    expect(r.postStart).toBeUndefined();
  });

  it("copies the env object (mutating the input does not leak)", () => {
    const input = { NPM_TOKEN: "fake" };
    const r = setEnv(input);
    input.NPM_TOKEN = "mutated";
    expect(r.envs!.NPM_TOKEN).toBe("fake");
  });
});

describe("setDate", () => {
  it("converts ISO to libfaketime's space-separated YYYY-MM-DD HH:MM:SS", () => {
    const r = setDate("2027-01-02T03:04:05Z");
    expect(r.envs).toEqual({ FAKETIME: "@2027-01-02 03:04:05" });
    expect(r.ldPreload).toBe("/usr/lib/libfaketime.so.1");
    expect(r.applied.date).toBe("2027-01-02T03:04:05Z"); // original ISO preserved
  });

  it("throws on invalid ISO input", () => {
    expect(() => setDate("not-a-date")).toThrow(/invalid ISO timestamp/);
  });
});

describe("preload", () => {
  it("sets NODE_OPTIONS preload path and writes the code in postStart", () => {
    const r = preload("console.log('preload')");
    expect(r.preload).toBe("/tmp/npmguard-preload.js");
    expect(r.applied.preloadHash).toBe(sha256Hex("console.log('preload')"));
    expect(r.postStart).toBeDefined();
  });
});

describe("plantFiles", () => {
  it("records a contentHash for each planted file", () => {
    const r = plantFiles([
      { path: "/home/node/.npmrc", content: "//registry.npmjs.org/:_authToken=fake" },
      { path: "/home/node/.ssh/id_rsa", content: "-----BEGIN RSA PRIVATE KEY-----\nFAKE" },
    ]);
    expect(r.applied.plantFiles).toHaveLength(2);
    expect(r.applied.plantFiles![0]).toEqual({
      path: "/home/node/.npmrc",
      contentHash: sha256Hex("//registry.npmjs.org/:_authToken=fake"),
    });
    expect(r.postStart).toBeDefined();
  });
});

describe("patchFile", () => {
  it("records a stable hash over pattern+replacement pairs", () => {
    const r1 = patchFile([
      { path: "index.js", replacements: [{ pattern: "Date.now() > T", replacement: "true" }] },
    ]);
    const r2 = patchFile([
      { path: "index.js", replacements: [{ pattern: "Date.now() > T", replacement: "true" }] },
    ]);
    expect(r1.applied.patches![0]!.patchHash).toBe(r2.applied.patches![0]!.patchHash);
  });

  it("distinguishes regex from string patterns in the hash", () => {
    const r1 = patchFile([
      { path: "x.js", replacements: [{ pattern: "foo", replacement: "bar" }] },
    ]);
    const r2 = patchFile([
      { path: "x.js", replacements: [{ pattern: /foo/g, replacement: "bar" }] },
    ]);
    expect(r1.applied.patches![0]!.patchHash).not.toBe(r2.applied.patches![0]!.patchHash);
  });

  it("distinguishes regex flags in the hash", () => {
    const r1 = patchFile([
      { path: "x.js", replacements: [{ pattern: /foo/g, replacement: "bar" }] },
    ]);
    const r2 = patchFile([
      { path: "x.js", replacements: [{ pattern: /foo/gi, replacement: "bar" }] },
    ]);
    expect(r1.applied.patches![0]!.patchHash).not.toBe(r2.applied.patches![0]!.patchHash);
  });
});

describe("stubUrl", () => {
  it("emits HTTP_PROXY env + stub JSON + readiness script", () => {
    const r = stubUrl([
      { pattern: "*attacker.com/*", responseStatus: 200, responseBody: "ok" },
    ]);
    expect(r.envs!.HTTP_PROXY).toBe("http://127.0.0.1:18080");
    expect(r.envs!.HTTPS_PROXY).toBe("http://127.0.0.1:18080");
    expect(r.envs!.http_proxy).toBe("http://127.0.0.1:18080");
    expect(r.envs!.https_proxy).toBe("http://127.0.0.1:18080");
    expect(r.envs!.NPMGUARD_STUBS).toContain("attacker.com");
    expect(r.envs!.NPMGUARD_STUB_PORT).toBe("18080");
    expect(r.applied.stubUrls).toHaveLength(1);
    expect(r.applied.stubUrls![0]!.pattern).toBe("*attacker.com/*");
    expect(r.postStart).toBeDefined();
  });

  it("defaults responseStatus=200 and body='ok' when omitted", () => {
    const r = stubUrl([{ pattern: "*c2*" }]);
    const parsed = JSON.parse(r.envs!["NPMGUARD_STUBS"]!);
    expect(parsed[0].responseStatus).toBe(200);
    expect(parsed[0].responseBody).toBe("ok");
  });
});
