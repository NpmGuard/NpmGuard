import { describe, it, expect } from "vitest";
import {
  jaroWinkler,
  similarDescription,
  findDuplicate,
  DEFAULT_MERGE_THRESHOLD,
} from "./merge.js";

describe("jaroWinkler", () => {
  it("scores identical strings as 1", () => {
    expect(jaroWinkler("hello", "hello")).toBe(1);
  });

  it("scores empty pair as 1 and empty-nonempty as 0", () => {
    expect(jaroWinkler("", "")).toBe(1);
    expect(jaroWinkler("", "x")).toBe(0);
    expect(jaroWinkler("y", "")).toBe(0);
  });

  it("scores completely different strings near 0", () => {
    const score = jaroWinkler("abc", "xyz");
    expect(score).toBeLessThan(0.5);
  });

  it("matches the classic MARTHA/MARHTA Winkler score (~0.961)", () => {
    const score = jaroWinkler("MARTHA", "MARHTA");
    expect(score).toBeGreaterThan(0.96);
    expect(score).toBeLessThan(0.97);
  });

  it("awards prefix bonus for strings sharing the same start", () => {
    const prefixShared = jaroWinkler("hello world", "hello earth");
    const prefixNot = jaroWinkler("ahello world", "bhello earth");
    expect(prefixShared).toBeGreaterThan(prefixNot);
  });

  it("is symmetric for identical inputs", () => {
    expect(jaroWinkler("abc", "abc")).toBe(jaroWinkler("abc", "abc"));
  });
});

describe("similarDescription", () => {
  it("matches paraphrased descriptions above threshold", () => {
    const a = "lib/init.js:42 reads NPM_TOKEN and posts to attacker.com";
    const b = "lib/init.js:42 reads NPM_TOKEN and POSTs to attacker.com";
    expect(similarDescription(a, b)).toBe(true);
  });

  it("handles case and whitespace differences", () => {
    const a = "  lib/Init.js:42 reads NPM_TOKEN ";
    const b = "lib/init.js:42 reads npm_token";
    expect(similarDescription(a, b)).toBe(true);
  });

  it("rejects clearly different descriptions", () => {
    const a = "lib/init.js:42 reads NPM_TOKEN";
    const b = "utils/hex.js:10 contains obfuscated blob";
    expect(similarDescription(a, b)).toBe(false);
  });

  it("respects a caller-provided threshold", () => {
    const a = "envelope opener";
    const b = "envelope sender";
    // Sharing the prefix 'envelope' gives a high Jaro-Winkler, but strict
    // threshold should still reject
    expect(similarDescription(a, b, 0.99)).toBe(false);
  });

  it("default threshold is 0.88", () => {
    expect(DEFAULT_MERGE_THRESHOLD).toBe(0.88);
  });
});

describe("findDuplicate", () => {
  it("returns null when the list is empty", () => {
    expect(findDuplicate({ description: "anything" }, [])).toBeNull();
  });

  it("returns the first near-match", () => {
    const existing = [
      { description: "utils/hex.js contains encoded blob" },
      { description: "lib/init.js:42 reads NPM_TOKEN and posts" },
      { description: "index.js sets interval posting to URL" },
    ];
    const match = findDuplicate(
      { description: "lib/init.js:42 reads NPM_TOKEN and POSTs" },
      existing,
    );
    expect(match?.description).toMatch(/reads NPM_TOKEN/);
  });

  it("returns null when no description clears the threshold", () => {
    const existing = [{ description: "utils/hex.js contains encoded blob" }];
    expect(
      findDuplicate({ description: "lib/init.js:42 reads NPM_TOKEN" }, existing),
    ).toBeNull();
  });
});
