import { createHash } from "node:crypto";
import { canonicalize } from "./canonical-json.js";

/** sha256 over the bytes of `input`, returned as lowercase hex. */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Content hash for an arbitrary value. Canonicalizes first, so two values
 * that serialize to the same bytes produce the same hash regardless of
 * input key order or undefined-vs-missing.
 */
export function contentHashOf(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/**
 * Merkle root over an ordered list of hex-encoded sha256 hashes.
 *
 * Rules (Bitcoin-style):
 *  - Empty list → sha256("")
 *  - Single hash → itself (no wrapping)
 *  - Two hashes → sha256(concat)
 *  - Odd count at any level → duplicate the last and pair it with itself
 *
 * Order-sensitive end-to-end: permuting the input changes the root.
 */
export function merkleRoot(hashes: readonly string[]): string {
  if (hashes.length === 0) return sha256Hex("");
  if (hashes.length === 1) return hashes[0]!;

  const next: string[] = [];
  for (let i = 0; i < hashes.length; i += 2) {
    const left = hashes[i]!;
    const right = hashes[i + 1] ?? left;
    next.push(sha256Hex(left + right));
  }
  return merkleRoot(next);
}
