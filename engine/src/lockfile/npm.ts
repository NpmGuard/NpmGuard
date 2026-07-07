import { UnsupportedLockfileError, type LockfileDep } from "./index.js";

interface NpmLockEntry {
  version?: string;
  link?: boolean;
}

interface NpmLockRoot extends NpmLockEntry {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** package-lock.json v2/v3 — walk the `packages` map. v1 (npm <7) has no
 *  `packages` key and is rejected with a regenerate hint. */
export function parseNpmLockfile(
  content: string,
  manifest: Map<string, string>,
): LockfileDep[] {
  let lock: { lockfileVersion?: number; packages?: Record<string, NpmLockEntry> };
  try {
    lock = JSON.parse(content);
  } catch {
    throw new UnsupportedLockfileError("package-lock.json is not valid JSON");
  }
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new UnsupportedLockfileError(
      "package-lock.json v1 is not supported — regenerate it with npm >= 7",
    );
  }

  // Direct ranges: the lockfile's root entry is authoritative; the manifest
  // fills gaps (e.g. lockfile written by an older npm).
  const root = (lock.packages[""] ?? {}) as NpmLockRoot;
  const directRanges = new Map<string, string>(manifest);
  for (const section of [
    root.dependencies,
    root.devDependencies,
    root.optionalDependencies,
    root.peerDependencies,
  ]) {
    for (const [name, range] of Object.entries(section ?? {})) {
      directRanges.set(name, range);
    }
  }

  const seen = new Map<string, LockfileDep>();
  for (const [pkgPath, entry] of Object.entries(lock.packages)) {
    if (pkgPath === "" || entry.link) continue;
    // "node_modules/foo", "node_modules/a/node_modules/@scope/b", or a
    // workspace dir ("packages/a" — skipped, it's local code, not a dep).
    const idx = pkgPath.lastIndexOf("node_modules/");
    if (idx === -1) continue;
    const name = pkgPath.slice(idx + "node_modules/".length);
    if (!name || !entry.version) continue;

    const key = `${name}@${entry.version}`;
    if (seen.has(key)) continue;
    const direct = directRanges.has(name);
    seen.set(key, {
      name,
      version: entry.version,
      direct,
      range: direct ? (directRanges.get(name) ?? null) : null,
    });
  }
  return [...seen.values()];
}
