/**
 * Unit: format helpers — format.ts.
 *
 * Input classes (per formatter, the branch boundaries):
 *  C1  formatBytes      — B (<1KiB) | KB (<1MiB) | MB, one decimal above bytes.
 *  C2  formatDuration   — ms (<1s) | s (<1min) | "Xm Ys".
 *  C3  formatWeiAsEth   — whole ETH | fractional with trailing zeros trimmed | bigint input.
 *  C4  truncateMiddle   — short-enough passes through | long collapses to head…tail.
 *  C5  formatDate       — "—" on null/undefined/invalid | a real string otherwise.
 *
 * Blackbox, locale-stable assertions only (dates asserted by "not —", not by locale text).
 */

import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatDuration, formatWeiAsEth, truncateMiddle } from "./format.ts";

describe("format — C1 formatBytes", () => {
  it("C1: bytes below 1 KiB stay in B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });
  it("C1: KiB range renders with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
  it("C1: MiB range renders with one decimal", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("format — C2 formatDuration", () => {
  it("C2: sub-second stays in ms", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
  });
  it("C2: seconds render with one decimal", () => {
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(1500)).toBe("1.5s");
  });
  it("C2: minute-plus renders as 'Xm Ys'", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(90_000)).toBe("1m 30s");
  });
});

describe("format — C3 formatWeiAsEth (trailing-zero trim)", () => {
  it("C3: a whole-ETH value has no fractional part", () => {
    expect(formatWeiAsEth(10n ** 18n)).toBe("1 ETH");
  });
  it("C3: fractional wei trims trailing zeros", () => {
    // 0.5 ETH = 5 * 10^17 wei
    expect(formatWeiAsEth(5n * 10n ** 17n)).toBe("0.5 ETH");
  });
  it("C3: accepts a decimal string as well as a bigint", () => {
    expect(formatWeiAsEth("1000000000000000000")).toBe("1 ETH");
    expect(formatWeiAsEth("1500000000000000000")).toBe("1.5 ETH");
  });
});

describe("format — C4 truncateMiddle", () => {
  it("C4: strings within head+tail+1 pass through unchanged", () => {
    expect(truncateMiddle("0xabcd", 6, 4)).toBe("0xabcd");
  });
  it("C4: long strings collapse to head…tail", () => {
    expect(truncateMiddle("0x1234567890abcdef", 6, 4)).toBe("0x1234…cdef");
  });
});

describe("format — C5 formatDate", () => {
  it("C5: null / undefined / invalid all render an em-dash", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
    expect(formatDate("not-a-date")).toBe("—");
  });
  it("C5: a valid ISO date renders a non-dash string", () => {
    const out = formatDate("2026-07-01T12:00:00Z");
    expect(out).not.toBe("—");
    expect(out.length).toBeGreaterThan(0);
  });
});
