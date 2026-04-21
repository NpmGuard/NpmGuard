import { describe, it, expect } from "vitest";
import { canonicalize } from "./canonical-json.js";

describe("canonicalize", () => {
  it("serializes primitives identically to JSON.stringify", () => {
    expect(canonicalize("hello")).toBe('"hello"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(-3.14)).toBe("-3.14");
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
    expect(canonicalize(null)).toBe("null");
  });

  it("sorts object keys at the top level", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":2,"b":1,"c":3}');
  });

  it("sorts keys recursively in nested objects", () => {
    const a = { outer: { z: 1, a: 2 }, alpha: 3 };
    const b = { alpha: 3, outer: { a: 2, z: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"alpha":3,"outer":{"a":2,"z":1}}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([3, 1, 2])).not.toBe(canonicalize([1, 2, 3]));
  });

  it("drops undefined in objects", () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("normalizes undefined in arrays to null", () => {
    expect(canonicalize([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("produces no whitespace", () => {
    const out = canonicalize({ a: 1, b: [2, 3], c: { d: 4 } });
    expect(out).not.toMatch(/\s/);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => canonicalize(NaN)).toThrow(/non-finite/);
    expect(() => canonicalize(Infinity)).toThrow(/non-finite/);
    expect(() => canonicalize(-Infinity)).toThrow(/non-finite/);
  });

  it("rejects top-level undefined", () => {
    expect(() => canonicalize(undefined)).toThrow(/undefined/);
  });

  it("rejects bigint", () => {
    expect(() => canonicalize(BigInt(1))).toThrow(/bigint/);
  });

  it("is determinism-stable across JSON round-trips", () => {
    const obj = { z: { y: [1, { x: 3, w: 4 }], v: null }, a: "hello" };
    const result1 = canonicalize(obj);
    const result2 = canonicalize(JSON.parse(JSON.stringify(obj)));
    expect(result1).toBe(result2);
  });

  it("escapes special string characters via JSON.stringify", () => {
    expect(canonicalize('a"b\n\\c')).toBe(JSON.stringify('a"b\n\\c'));
    expect(canonicalize("unicode: \u{1F600}")).toBe(JSON.stringify("unicode: \u{1F600}"));
  });

  it("handles deeply nested structures", () => {
    const deep = { a: { b: { c: { d: [1, 2, { e: "f" }] } } } };
    const out = canonicalize(deep);
    expect(out).toBe('{"a":{"b":{"c":{"d":[1,2,{"e":"f"}]}}}}');
  });

  it("handles empty collections", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
    expect(canonicalize({ a: [], b: {} })).toBe('{"a":[],"b":{}}');
  });
});
