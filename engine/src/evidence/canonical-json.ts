/**
 * Deterministic JSON serialization for integrity hashing.
 *
 * Contract:
 * - Objects: keys sorted lexicographically at every level
 * - Arrays: order preserved (semantically meaningful)
 * - `undefined` in object fields: dropped
 * - `undefined` in arrays: serialized as `null` (matching JSON.stringify)
 * - Numbers: JS default number-to-string; non-finite values rejected
 * - Strings: JSON-escaped via JSON.stringify
 * - No whitespace anywhere
 *
 * Two values that canonicalize to the same bytes produce the same sha256.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new Error("canonicalize: top-level undefined is not representable");
  }
  return canonicalizeInner(value);
}

function canonicalizeInner(value: unknown): string {
  if (value === null) return "null";

  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`canonicalize: non-finite number (${String(value)}) is not representable`);
    }
    return JSON.stringify(value);
  }

  if (typeof value === "bigint") {
    throw new Error("canonicalize: bigint is not representable");
  }

  if (Array.isArray(value)) {
    const parts = value.map((v) => canonicalizeInner(v === undefined ? null : v));
    return "[" + parts.join(",") + "]";
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = obj[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + canonicalizeInner(v));
    }
    return "{" + parts.join(",") + "}";
  }

  throw new Error(`canonicalize: unsupported type ${typeof value}`);
}
