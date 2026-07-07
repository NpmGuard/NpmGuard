import * as yarnLockfileModule from "@yarnpkg/lockfile";
import { parse as parseYaml } from "yaml";
import { UnsupportedLockfileError, type LockfileDep } from "./index.js";

// @yarnpkg/lockfile is CJS with a bare module.exports — depending on the
// loader (tsx, vitest, node ESM) the callable surface lands on the namespace
// or on .default. Resolve once, defensively.
type YarnParse = (content: string) => { type: string; object: Record<string, { version?: string }> };
const yarnParse: YarnParse =
  (yarnLockfileModule as { parse?: YarnParse }).parse ??
  (yarnLockfileModule as { default?: { parse: YarnParse } }).default!.parse;

// yarn.lock — classic (v1, custom format via @yarnpkg/lockfile) and berry
// (v2+, YAML with a __metadata block). Neither records which deps are direct,
// so classification comes from the package.json manifest (best-effort: with
// no manifest everything is marked transitive).

function pushDep(
  seen: Map<string, LockfileDep>,
  manifest: Map<string, string>,
  name: string,
  version: string,
): void {
  const key = `${name}@${version}`;
  if (seen.has(key)) return;
  const direct = manifest.has(name);
  seen.set(key, { name, version, direct, range: direct ? (manifest.get(name) ?? null) : null });
}

function parseBerry(content: string, manifest: Map<string, string>): LockfileDep[] {
  let lock: Record<string, unknown>;
  try {
    lock = parseYaml(content) as Record<string, unknown>;
  } catch {
    throw new UnsupportedLockfileError("yarn.lock (berry) could not be parsed");
  }
  const seen = new Map<string, LockfileDep>();
  for (const [key, value] of Object.entries(lock ?? {})) {
    if (key === "__metadata") continue;
    const entry = value as { version?: string | number; resolution?: string };
    if (!entry?.version || !entry.resolution) continue;
    // resolution: "lodash@npm:4.17.21" / "@types/node@npm:22.1.0";
    // skip workspace:/patch:/portal: resolutions — local code, not registry deps
    const npmIdx = entry.resolution.lastIndexOf("@npm:");
    if (npmIdx <= 0) continue;
    const name = entry.resolution.slice(0, npmIdx);
    pushDep(seen, manifest, name, String(entry.version));
  }
  return [...seen.values()];
}

function parseClassic(content: string, manifest: Map<string, string>): LockfileDep[] {
  const parsed = yarnParse(content);
  if (parsed.type !== "success") {
    throw new UnsupportedLockfileError(
      `yarn.lock could not be parsed (${parsed.type === "conflict" ? "merge conflict" : parsed.type})`,
    );
  }
  const seen = new Map<string, LockfileDep>();
  for (const [key, value] of Object.entries(parsed.object)) {
    if (!value?.version) continue;
    // key: "name@range" / "@scope/name@range"
    const at = key.lastIndexOf("@");
    if (at <= 0) continue;
    pushDep(seen, manifest, key.slice(0, at), value.version);
  }
  return [...seen.values()];
}

export function parseYarnLockfile(
  content: string,
  manifest: Map<string, string>,
): LockfileDep[] {
  return content.includes("__metadata:")
    ? parseBerry(content, manifest)
    : parseClassic(content, manifest);
}
