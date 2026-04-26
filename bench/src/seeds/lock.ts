import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SEEDS } from "./catalog.js";
import { fetchVersionMetadata } from "./registry.js";

// ---------------------------------------------------------------------------
// Lock — fetches the registry's published `dist.integrity` for every
// catalogue entry whose `integrity` field is empty, and writes the values
// back into catalog.ts in place.
//
// The methodology requires that re-runs of the benchmark see the exact
// same source code as the original run. The integrity field is the lock
// that enforces this. Once locked, the fetcher refuses to install anything
// whose tarball SRI doesn't match.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(__dirname, "catalog.ts");

interface MissingEntry {
  name: string;
  version: string;
}

function findMissing(): MissingEntry[] {
  return SEEDS.filter((s) => !s.integrity).map((s) => ({ name: s.name, version: s.version }));
}

async function fetchIntegrity(entry: MissingEntry): Promise<string> {
  const meta = await fetchVersionMetadata(entry.name, entry.version);
  if (meta.dist.integrity) return meta.dist.integrity;
  if (meta.dist.shasum) {
    // Some old packages publish only sha-1 shasum. We refuse to lock those —
    // sha-1 is too weak to anchor a security benchmark. Either pick a newer
    // version, or accept that this seed must be excluded from the run.
    throw new Error(
      `${entry.name}@${entry.version} only publishes shasum (sha-1), not integrity (sha-512). Pick a newer version.`,
    );
  }
  throw new Error(`${entry.name}@${entry.version}: registry returned no integrity field`);
}

/** Replace the integrity for a `name`+`version` pair inside a catalog.ts text.
 *  We anchor on the version line because catalog entries are arrays of
 *  literal objects with that field always present. */
function patchCatalog(source: string, name: string, version: string, integrity: string): string {
  // Match a block like:
  //   {
  //     name: "X",
  //     version: "Y",
  //     integrity: "",
  //     ...
  //   }
  const pattern = new RegExp(
    String.raw`(name:\s*"${escapeRe(name)}"\s*,\s*\n\s*version:\s*"${escapeRe(version)}"\s*,\s*\n\s*integrity:\s*)"[^"]*"`,
    "m",
  );
  if (!pattern.test(source)) {
    throw new Error(
      `Could not find catalog entry for ${name}@${version}. The catalog format may have drifted from what lock.ts expects.`,
    );
  }
  return source.replace(pattern, `$1"${integrity}"`);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main(): Promise<void> {
  const missing = findMissing();
  if (missing.length === 0) {
    console.log("[lock] catalog is fully locked. No work to do.");
    return;
  }

  console.log(`[lock] ${missing.length} unlocked seed(s) — fetching from registry...`);
  let source = readFileSync(CATALOG_PATH, "utf-8");

  for (const entry of missing) {
    try {
      const integrity = await fetchIntegrity(entry);
      source = patchCatalog(source, entry.name, entry.version, integrity);
      console.log(`[lock]   ${entry.name}@${entry.version} → ${integrity.slice(0, 32)}...`);
    } catch (err) {
      console.error(
        `[lock]   ${entry.name}@${entry.version} FAILED: ${err instanceof Error ? err.message : err}`,
      );
      process.exitCode = 1;
    }
  }

  writeFileSync(CATALOG_PATH, source, "utf-8");
  console.log(`[lock] wrote ${CATALOG_PATH}`);
  console.log(
    "[lock] Review the diff with `git diff bench/src/seeds/catalog.ts` then commit.",
  );
}

main().catch((err) => {
  console.error("[lock] unexpected failure:", err);
  process.exit(2);
});
