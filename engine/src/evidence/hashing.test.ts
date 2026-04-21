import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { sha256Hex, contentHashOf, merkleRoot } from "./hashing.js";

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

describe("sha256Hex", () => {
  it("matches the NIST test vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the empty string deterministically", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("accepts Buffer input", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
  });
});

describe("contentHashOf", () => {
  it("produces identical hashes for equivalent objects with different key order", () => {
    expect(contentHashOf({ y: 1, x: 2 })).toBe(contentHashOf({ x: 2, y: 1 }));
  });

  it("produces different hashes for different values", () => {
    expect(contentHashOf({ x: 1 })).not.toBe(contentHashOf({ x: 2 }));
  });

  it("treats missing and undefined fields as equivalent", () => {
    expect(contentHashOf({ x: 1, y: undefined })).toBe(contentHashOf({ x: 1 }));
  });

  it("is order-sensitive on arrays", () => {
    expect(contentHashOf([1, 2, 3])).not.toBe(contentHashOf([3, 2, 1]));
  });

  it("stable across JSON round-trips", () => {
    const obj = { a: 1, b: [1, 2, { c: 3 }], d: null };
    expect(contentHashOf(obj)).toBe(contentHashOf(JSON.parse(JSON.stringify(obj))));
  });
});

describe("merkleRoot", () => {
  it("empty list hashes the empty string", () => {
    expect(merkleRoot([])).toBe(sha256(""));
  });

  it("single hash is returned unwrapped", () => {
    const h = sha256Hex("x");
    expect(merkleRoot([h])).toBe(h);
  });

  it("two hashes concatenate and sha256", () => {
    const a = sha256Hex("a");
    const b = sha256Hex("b");
    expect(merkleRoot([a, b])).toBe(sha256(a + b));
  });

  it("odd-count pairs by duplicating the last leaf", () => {
    const a = sha256Hex("a");
    const b = sha256Hex("b");
    const c = sha256Hex("c");
    const ab = sha256(a + b);
    const cc = sha256(c + c);
    const expected = sha256(ab + cc);
    expect(merkleRoot([a, b, c])).toBe(expected);
  });

  it("is order-sensitive", () => {
    const a = sha256Hex("a");
    const b = sha256Hex("b");
    expect(merkleRoot([a, b])).not.toBe(merkleRoot([b, a]));
  });

  it("changing one leaf breaks the root", () => {
    const hashes = ["a", "b", "c", "d"].map(sha256Hex);
    const root1 = merkleRoot(hashes);
    const perturbed = [...hashes];
    perturbed[2] = sha256Hex("c'");
    expect(merkleRoot(perturbed)).not.toBe(root1);
  });

  it("handles four leaves as balanced tree", () => {
    const hashes = ["a", "b", "c", "d"].map(sha256Hex);
    const ab = sha256(hashes[0]! + hashes[1]!);
    const cd = sha256(hashes[2]! + hashes[3]!);
    const expected = sha256(ab + cd);
    expect(merkleRoot(hashes)).toBe(expected);
  });
});
