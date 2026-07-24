/**
 * Unit: frontend domain helpers — types.ts.
 *
 * Input classes:
 *  C1  parsePackageInput      — plain name | name@version | scoped @s/p@version
 *                               (split on the LAST @) | leading-@ scoped-no-version
 *                               (the scope @ must NOT be read as a version) | blank.
 *  C2  parseLineRanges        — single | range | list | garbage-dropped | reversed
 *                               dropped | null/empty → [].
 *  C3  riskContributionToStatus — thresholds: <3 safe | 3–4 suspicious | ≥5 dangerous.
 *  C4  fileFromFileLine       — "path:line" strips the suffix | comma-list takes the
 *                               first | no-colon returns the trimmed path.
 *
 * Blackbox — inputs → outputs only.
 */

import { describe, expect, it } from "vitest";
import { fileFromFileLine, parseLineRanges, parsePackageInput, riskContributionToStatus } from "./types.ts";

describe("types — C1 parsePackageInput", () => {
  it("C1: a bare name has a null version", () => {
    expect(parsePackageInput("chalk")).toEqual({ name: "chalk", version: null });
  });
  it("C1: name@version splits on the @", () => {
    expect(parsePackageInput("chalk@5.0.0")).toEqual({ name: "chalk", version: "5.0.0" });
  });
  it("C1: a scoped name splits on the LAST @ so the scope survives", () => {
    expect(parsePackageInput("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
  });
  it("C1: a scoped name with no version keeps the leading @ as part of the name", () => {
    expect(parsePackageInput("@scope/pkg")).toEqual({ name: "@scope/pkg", version: null });
  });
  it("C1: surrounding whitespace is trimmed", () => {
    expect(parsePackageInput("  chalk@5.0.0  ")).toEqual({ name: "chalk", version: "5.0.0" });
  });
});

describe("types — C2 parseLineRanges", () => {
  it("C2: null / empty yields an empty list", () => {
    expect(parseLineRanges(null)).toEqual([]);
    expect(parseLineRanges("")).toEqual([]);
  });
  it("C2: a single number becomes a degenerate [n,n] range", () => {
    expect(parseLineRanges("20")).toEqual([[20, 20]]);
  });
  it("C2: a mixed list parses ranges and singles, dropping garbage", () => {
    expect(parseLineRanges("12-14, 20, junk, 30-31")).toEqual([
      [12, 14],
      [20, 20],
      [30, 31],
    ]);
  });
  it("C2: a reversed range (end < start) is dropped", () => {
    expect(parseLineRanges("14-12")).toEqual([]);
  });
});

describe("types — C3 riskContributionToStatus", () => {
  it("C3: below the suspicious threshold is safe", () => {
    expect(riskContributionToStatus(0)).toBe("safe");
    expect(riskContributionToStatus(2)).toBe("safe");
  });
  it("C3: 3–4 is suspicious", () => {
    expect(riskContributionToStatus(3)).toBe("suspicious");
    expect(riskContributionToStatus(4)).toBe("suspicious");
  });
  it("C3: 5 and above is dangerous", () => {
    expect(riskContributionToStatus(5)).toBe("dangerous");
    expect(riskContributionToStatus(10)).toBe("dangerous");
  });
});

describe("types — C4 fileFromFileLine", () => {
  it("C4: strips a trailing :line-range", () => {
    expect(fileFromFileLine("lib/index.js:42-67")).toBe("lib/index.js");
  });
  it("C4: a comma list takes the first segment", () => {
    expect(fileFromFileLine("lib/index.js:42, other.js:5")).toBe("lib/index.js");
  });
  it("C4: a path with no colon is returned trimmed", () => {
    expect(fileFromFileLine("  lib/index.js  ")).toBe("lib/index.js");
  });
});
