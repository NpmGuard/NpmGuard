import { parseNpmLockfile } from "./npm.js";
import { parsePnpmLockfile } from "./pnpm.js";
import { parseYarnLockfile } from "./yarn.js";

// Lockfile parsing (spec §5.5): thin format-specific parsers producing one
// normalized shape. npm v2/v3 + pnpm are first-class, yarn (classic + berry)
// best-effort. Unsupported formats fail with a clear, user-facing error
// naming what IS supported (spec decision 11).

export interface LockfileDep {
  name: string;
  version: string;
  direct: boolean;
  /** Declared range for direct deps (e.g. "^4.17.21"); null for transitive. */
  range: string | null;
}

/** Root-relative filenames we look for, in priority order. */
export const LOCKFILE_CANDIDATES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"] as const;

export class UnsupportedLockfileError extends Error {
  readonly supported = LOCKFILE_CANDIDATES;
  constructor(detail: string) {
    super(
      `${detail} — supported lockfiles: ${LOCKFILE_CANDIDATES.join(", ")} (committed at the repo root)`,
    );
    this.name = "UnsupportedLockfileError";
  }
}

/** Extract direct-dependency ranges from a parsed package.json. */
export function manifestRanges(packageJson: unknown): Map<string, string> {
  const ranges = new Map<string, string>();
  if (!packageJson || typeof packageJson !== "object") return ranges;
  const manifest = packageJson as Record<string, unknown>;
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = manifest[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === "string" && !ranges.has(name)) ranges.set(name, range);
    }
  }
  return ranges;
}

/**
 * Parse a lockfile by filename. `manifest` (package.json ranges) classifies
 * direct deps for formats that don't carry that information themselves
 * (yarn), and is a fallback for the others.
 */
export function parseLockfile(
  filename: string,
  content: string,
  manifest: Map<string, string> = new Map(),
): LockfileDep[] {
  switch (filename) {
    case "package-lock.json":
      return parseNpmLockfile(content, manifest);
    case "pnpm-lock.yaml":
      return parsePnpmLockfile(content, manifest);
    case "yarn.lock":
      return parseYarnLockfile(content, manifest);
    default:
      throw new UnsupportedLockfileError(`Unsupported lockfile "${filename}"`);
  }
}
