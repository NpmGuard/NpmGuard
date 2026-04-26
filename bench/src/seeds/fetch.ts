import {
  createHash,
  randomBytes,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import * as tar from "tar";

import { SEEDS } from "./catalog.js";
import { fetchVersionMetadata, downloadTarball } from "./registry.js";
import type { Seed } from "../types.js";

// ---------------------------------------------------------------------------
// Fetch — download every catalogue entry, verify integrity, unpack into
// bench/dataset/seeds/<name>-<version>/.
//
// Idempotent: re-running re-uses cached tarballs and unpacked directories
// when their on-disk SRI matches the locked value.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const DATASET_DIR = join(BENCH_ROOT, "dataset");
const TARBALL_CACHE = join(DATASET_DIR, "tarballs");
const SEEDS_DIR = join(DATASET_DIR, "seeds");

interface FetchSummary {
  fetched: number;
  cached: number;
  failed: Array<{ seed: string; reason: string }>;
}

function seedDirName(seed: Seed): string {
  // Scoped names like @scope/name → @scope__name to keep filesystem flat.
  return `${seed.name.replace(/\//g, "__")}-${seed.version}`;
}

function tarballPath(seed: Seed): string {
  return join(TARBALL_CACHE, `${seedDirName(seed)}.tgz`);
}

function unpackedPath(seed: Seed): string {
  return join(SEEDS_DIR, seedDirName(seed));
}

/** Compute the SRI of a file on disk. */
function computeIntegrity(filePath: string): string {
  const buf = readFileSync(filePath);
  return `sha512-${createHash("sha512").update(buf).digest("base64")}`;
}

async function ensureSeed(seed: Seed): Promise<{ status: "fetched" | "cached" }> {
  if (!seed.integrity) {
    throw new Error(
      `${seed.name}@${seed.version}: integrity not locked. Run \`npm run -w @npmguard/bench lock\` first.`,
    );
  }

  const tgz = tarballPath(seed);
  const out = unpackedPath(seed);

  // Cache hit: tarball exists with correct SRI AND unpacked dir exists.
  if (existsSync(tgz) && existsSync(out)) {
    const onDisk = computeIntegrity(tgz);
    if (onDisk === seed.integrity) {
      // Cached source. Install deps if not already present — this happens
      // when fetch is re-run after the catalogue or installer logic changes.
      if (
        seed.form !== "native-binding" &&
        !existsSync(join(out, "node_modules")) &&
        existsSync(join(out, "package.json"))
      ) {
        installRuntimeDeps(out, seed);
      }
      return { status: "cached" };
    }
    // Mismatch — delete and refetch. The mismatch is unusual and worth a log.
    console.warn(
      `[fetch] cached tarball for ${seed.name}@${seed.version} has wrong SRI; refetching.`,
    );
    rmSync(tgz, { force: true });
    rmSync(out, { recursive: true, force: true });
  }

  // Download to a tmp path first, verify, then move into the cache.
  mkdirSync(TARBALL_CACHE, { recursive: true });
  mkdirSync(SEEDS_DIR, { recursive: true });
  const tmpDir = join(tmpdir(), `npmguard-bench-${randomBytes(8).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });

  try {
    const meta = await fetchVersionMetadata(seed.name, seed.version);
    const tmpTgz = join(tmpDir, "package.tgz");
    const downloadedSri = await downloadTarball(meta.dist.tarball, tmpTgz);

    if (downloadedSri !== seed.integrity) {
      throw new Error(
        `INTEGRITY MISMATCH for ${seed.name}@${seed.version}\n  expected: ${seed.integrity}\n  got:      ${downloadedSri}\n  tarball:  ${meta.dist.tarball}`,
      );
    }

    // Move tarball into cache.
    const finalTgz = tgz;
    rmSync(finalTgz, { force: true });
    renameSync(tmpTgz, finalTgz);

    // Unpack — npm tarballs always have a top-level "package/" dir.
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    await tar.extract({
      file: finalTgz,
      cwd: out,
      strip: 1,
      // Defensive: refuse path traversal entries.
      filter: (entryPath) => !entryPath.startsWith("/") && !entryPath.includes(".."),
    });

    // Install runtime deps so the seed actually loads under `require()`.
    // We deliberately pass `--no-package-lock` so the package's published
    // package.json is the only constraint — no surprises from a stale
    // lockfile. Native-binding seeds are skipped: their build step requires
    // toolchains we don't want as a benchmark prerequisite.
    if (seed.form !== "native-binding") {
      installRuntimeDeps(out, seed);
    }

    return { status: "fetched" };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function installRuntimeDeps(seedDir: string, seed: Seed): void {
  try {
    execFileSync(
      "npm",
      [
        "install",
        "--silent",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--omit=dev",
        "--omit=optional",
        "--prefer-offline",
        "--ignore-scripts", // never run install scripts of seed deps
      ],
      {
        cwd: seedDir,
        timeout: 120_000,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
  } catch (err) {
    // Don't fail the whole fetch on install errors — the seed source is
    // still on disk and useful for static-analysis-only measurements. The
    // verify-loads pass will surface which seeds couldn't get their deps.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[fetch]   ⚠ ${seed.name}@${seed.version}: dep install failed (${msg.slice(0, 120)})`,
    );
  }
}

async function main(): Promise<void> {
  const summary: FetchSummary = { fetched: 0, cached: 0, failed: [] };

  for (const seed of SEEDS) {
    try {
      const r = await ensureSeed(seed);
      if (r.status === "fetched") {
        summary.fetched++;
        console.log(`[fetch] ✓ ${seed.name}@${seed.version} (downloaded)`);
      } else {
        summary.cached++;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      summary.failed.push({ seed: `${seed.name}@${seed.version}`, reason });
      console.error(`[fetch] ✗ ${seed.name}@${seed.version}: ${reason}`);
    }
  }

  console.log(
    `[fetch] done — ${summary.cached} cached, ${summary.fetched} fetched, ${summary.failed.length} failed`,
  );

  // Quick sanity: did anything land in the seeds dir?
  if (existsSync(SEEDS_DIR)) {
    const dirs = readdirSync(SEEDS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    console.log(`[fetch] ${dirs.length} seed(s) unpacked in ${SEEDS_DIR}`);
    for (const d of dirs.slice(0, 5)) console.log(`[fetch]   ${basename(d)}`);
    if (dirs.length > 5) console.log(`[fetch]   ... and ${dirs.length - 5} more`);
  }

  if (summary.failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[fetch] unexpected failure:", err);
  process.exit(2);
});
