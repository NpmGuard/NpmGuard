import { parse as parseYaml } from "yaml";
import { UnsupportedLockfileError, type LockfileDep } from "./index.js";

interface PnpmImporter {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

/**
 * pnpm-lock.yaml — package keys across lockfile versions:
 *   v5:  "/name/1.2.3"          (peer suffix: "_react@18.0.0")
 *   v6:  "/name@1.2.3"          (peer suffix: "(react@18.0.0)")
 *   v9:  "name@1.2.3"           (peer suffix: "(react@18.0.0)")
 * Scoped names keep their internal slash ("/@scope/name@1.2.3"). The format
 * is decided by lockfileVersion, not guessed — package names may legally
 * contain "_" (string_decoder) and versions contain "@" in v5 peer suffixes,
 * so heuristics mis-split.
 */
function keyToNameVersion(
  rawKey: string,
  v5: boolean,
): { name: string; version: string } | null {
  let key = rawKey.trim();
  const paren = key.indexOf("(");
  if (paren !== -1) key = key.slice(0, paren);
  if (key.startsWith("/")) key = key.slice(1);
  if (!key) return null;

  if (v5) {
    const slash = key.lastIndexOf("/");
    if (slash <= 0) return null;
    const version = key.slice(slash + 1).split("_")[0]!;
    return version ? { name: key.slice(0, slash), version } : null;
  }

  const at = key.lastIndexOf("@");
  if (at <= 0) return null;
  const version = key.slice(at + 1);
  return version ? { name: key.slice(0, at), version } : null;
}

/** Importer values are "1.2.3" (v5) or { specifier, version } (v6/v9). */
function importerEntry(value: unknown): { range: string | null } {
  if (typeof value === "string") return { range: null };
  const v = value as { specifier?: string };
  return { range: typeof v?.specifier === "string" ? v.specifier : null };
}

export function parsePnpmLockfile(
  content: string,
  manifest: Map<string, string>,
): LockfileDep[] {
  let lock: Record<string, unknown>;
  try {
    lock = parseYaml(content) as Record<string, unknown>;
  } catch {
    throw new UnsupportedLockfileError("pnpm-lock.yaml could not be parsed");
  }
  if (!lock || typeof lock !== "object") {
    throw new UnsupportedLockfileError("pnpm-lock.yaml could not be parsed");
  }

  // Direct deps: importers["."] (v6/v9) or root-level sections (v5).
  const importers = lock.importers as Record<string, PnpmImporter> | undefined;
  const rootImporter: PnpmImporter = importers?.["."] ?? (lock as PnpmImporter);
  const directRanges = new Map<string, string | null>();
  for (const section of [
    rootImporter.dependencies,
    rootImporter.devDependencies,
    rootImporter.optionalDependencies,
  ]) {
    for (const [name, value] of Object.entries(section ?? {})) {
      directRanges.set(name, importerEntry(value).range ?? manifest.get(name) ?? null);
    }
  }
  for (const [name, range] of manifest) {
    if (!directRanges.has(name)) directRanges.set(name, range);
  }

  const v5 = parseFloat(String(lock.lockfileVersion ?? "0")) < 6;
  const packages = (lock.packages ?? {}) as Record<string, unknown>;
  const seen = new Map<string, LockfileDep>();
  for (const key of Object.keys(packages)) {
    const parsed = keyToNameVersion(key, v5);
    if (!parsed) continue;
    const dedupKey = `${parsed.name}@${parsed.version}`;
    if (seen.has(dedupKey)) continue;
    const direct = directRanges.has(parsed.name);
    seen.set(dedupKey, {
      name: parsed.name,
      version: parsed.version,
      direct,
      range: direct ? (directRanges.get(parsed.name) ?? null) : null,
    });
  }

  if (seen.size === 0 && Object.keys(packages).length === 0 && !importers) {
    throw new UnsupportedLockfileError("pnpm-lock.yaml has no packages section");
  }
  return [...seen.values()];
}
