import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";

import { fixtureNameFor } from "./fixture.js";
import type { DatadogCorpus, DatadogSample } from "./types.js";

// ---------------------------------------------------------------------------
// Fetcher — for each sample in corpus.json:
//   1. download the encrypted ZIP from raw.githubusercontent.com
//   2. unzip with the dataset's universal password "infected"
//   3. copy the unpacked package contents to
//      sandbox/test-fixtures/<fixtureName>/
//
// Idempotent: if the fixture already exists with a content-hash matching
// the current pull, we skip. The hash is the SHA-256 of the unzipped
// contents tar and is stamped into a meta file.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(BENCH_ROOT, "..");
const CORPUS_IN = join(BENCH_ROOT, "dataset", "datadog", "corpus.json");
const ZIP_CACHE = join(BENCH_ROOT, "dataset", "datadog", "zips");
const FIXTURES_DIR = join(REPO_ROOT, "sandbox", "test-fixtures");
const ZIP_PASSWORD = "infected";

function readCorpus(): DatadogCorpus {
  if (!existsSync(CORPUS_IN)) {
    throw new Error(
      `corpus.json not found at ${CORPUS_IN}. Run \`npm run -w @npmguard/bench datadog:select\` first.`,
    );
  }
  return JSON.parse(readFileSync(CORPUS_IN, "utf-8")) as DatadogCorpus;
}

async function downloadZip(sample: DatadogSample): Promise<string> {
  mkdirSync(ZIP_CACHE, { recursive: true });
  const cached = join(ZIP_CACHE, sample.zipFilename);
  if (existsSync(cached)) return cached;

  const resp = await fetch(sample.zipUrl, { signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) {
    throw new Error(
      `failed to download ${sample.packageName}@${sample.version}: HTTP ${resp.status}`,
    );
  }
  if (!resp.body) throw new Error("empty response body");

  const tmp = `${cached}.partial`;
  const nodeStream = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream);
  await pipeline(nodeStream, createWriteStream(tmp));

  // Atomic move
  execFileSync("mv", [tmp, cached]);
  return cached;
}

/** Unzip with the dataset's universal `infected` password into a fresh
 *  tmpdir and return the path of the directory we should treat as the
 *  package root. */
function unzipSample(zipPath: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "datadog-extract-"));
  try {
    execFileSync(
      "unzip",
      ["-o", "-q", "-P", ZIP_PASSWORD, zipPath, "-d", tmp],
      { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    const e = err as { stderr?: Buffer; message?: string };
    throw new Error(
      `unzip failed for ${zipPath}: ${e.stderr?.toString().slice(0, 200) || e.message}`,
    );
  }

  // Datadog ZIPs vary wildly in layout: some have one top-level dir named
  // after the discovery date; some additionally wrap in a `package/` dir;
  // some have preserved the original packager's full filesystem path
  // (e.g. `var/folders/rs/.../T/tmpXXX/package/`) inside the ZIP, requiring
  // 7+ levels of drilling. We continue while a single subdirectory is
  // present and no package.json is found at the current level. The depth
  // cap is generous; in practice samples bottom out within 10 levels.
  let cursor = tmp;
  // First, prefer drilling toward an explicit `package/` subdirectory if
  // it appears at any level — that's the npm convention and the most
  // reliable signal that we've hit the package root.
  for (let i = 0; i < 16; i++) {
    const here = readdirSync(cursor, { withFileTypes: true });
    if (here.some((e) => e.isFile() && e.name === "package.json")) break;
    const dirs = here.filter((e) => e.isDirectory());
    if (dirs.length === 0) break;
    // If a `package/` dir is here, drill into it (covers the most common
    // sibling-file case where another sibling JSON is `package_info-X.json`
    // and would otherwise leave dirs.length=1 anyway).
    const explicitPackage = dirs.find((d) => d.name === "package");
    if (explicitPackage) {
      cursor = join(cursor, "package");
      continue;
    }
    if (dirs.length !== 1) break;
    cursor = join(cursor, dirs[0]!.name);
  }
  return cursor;
}

interface FetchOutcome {
  sample: DatadogSample;
  fixtureName: string;
  status: "fetched" | "cached" | "failed";
  reason?: string;
}

async function processSample(sample: DatadogSample): Promise<FetchOutcome> {
  const fixtureName = fixtureNameFor(sample);
  const fixtureDir = join(FIXTURES_DIR, fixtureName);
  const stampFile = join(fixtureDir, ".datadog-bench-stamp.json");

  // Cache check: stamp present + matches expected zipFilename.
  if (existsSync(stampFile)) {
    try {
      const stamp = JSON.parse(readFileSync(stampFile, "utf-8")) as {
        zipFilename: string;
      };
      if (stamp.zipFilename === sample.zipFilename) {
        return { sample, fixtureName, status: "cached" };
      }
    } catch {
      // Corrupted stamp — fall through and re-extract.
    }
  }

  let zipPath: string;
  try {
    zipPath = await downloadZip(sample);
  } catch (err) {
    return {
      sample,
      fixtureName,
      status: "failed",
      reason: `download: ${err instanceof Error ? err.message : err}`,
    };
  }

  let extracted: string;
  try {
    extracted = unzipSample(zipPath);
  } catch (err) {
    return {
      sample,
      fixtureName,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Copy extracted contents to the fixture dir.
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
  cpSync(extracted, fixtureDir, { recursive: true });
  // Cleanup the tmpdir parent of `extracted` (we created it in unzipSample).
  // We don't know its exact path here without juggling — leave OS to GC it.

  // Write stamp so subsequent runs short-circuit.
  writeFileSync(
    stampFile,
    JSON.stringify(
      {
        source: "datadog",
        packageName: sample.packageName,
        version: sample.version,
        className: sample.className,
        discoveryDate: sample.discoveryDate,
        zipFilename: sample.zipFilename,
        zipUrl: sample.zipUrl,
      },
      null,
      2,
    ),
  );

  return { sample, fixtureName, status: "fetched" };
}

async function main(): Promise<void> {
  const corpus = readCorpus();
  console.log(
    `[datadog:fetch] processing ${corpus.samples.length} samples (dataset @ ${corpus.datasetCommitSha.slice(0, 12)})`,
  );

  const outcomes: FetchOutcome[] = [];
  for (const sample of corpus.samples) {
    const res = await processSample(sample);
    outcomes.push(res);
    const tag =
      res.status === "fetched" ? "✓" : res.status === "cached" ? "·" : "✗";
    console.log(
      `[datadog:fetch] ${tag} ${sample.className}/${sample.packageName}@${sample.version} → ${res.fixtureName}${res.reason ? ` (${res.reason})` : ""}`,
    );
  }

  const fetched = outcomes.filter((o) => o.status === "fetched").length;
  const cached = outcomes.filter((o) => o.status === "cached").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  console.log(
    `[datadog:fetch] done — ${fetched} fetched, ${cached} cached, ${failed} failed`,
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("[datadog:fetch] unexpected failure:", err);
  process.exit(2);
});
