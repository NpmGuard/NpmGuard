import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DatadogClass, DatadogCorpus, DatadogSample } from "./types.js";

// ---------------------------------------------------------------------------
// Selector — fetch the Datadog dataset's npm manifest and produce a
// reproducible, stratified random sample of N entries per class.
//
// We never clone the 18GB dataset repo. Instead we make ONE GitHub git/trees
// API call (recursive=1) which returns every file path in the repo at the
// chosen commit, then index it locally to find the ZIPs we need. This avoids
// the per-sample directory listing pattern that hits abuse rate limits.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const DATADOG_DIR = join(BENCH_ROOT, "dataset", "datadog");
const CORPUS_OUT = join(DATADOG_DIR, "corpus.json");
/** Treeless mirror of the Datadog dataset. Holds the .git directory only;
 *  blobs are fetched on demand. Lives outside dataset/ so a `rm -rf` of
 *  dataset/ for a clean rebuild doesn't force a 50MB re-clone. */
const MIRROR_DIR = join(BENCH_ROOT, ".datadog-mirror");

const DATASET_OWNER = "DataDog";
const DATASET_REPO = "malicious-software-packages-dataset";
const DATASET_BRANCH = "main";
const DATASET_GIT_URL = `https://github.com/${DATASET_OWNER}/${DATASET_REPO}.git`;

/** Sampling targets — 50 per class = 100 fixtures total. v1 used 25 each
 *  but 50 gives stronger statistical signal on TEST_CONFIRMED rate. */
const SAMPLES_PER_CLASS: Record<DatadogClass, number> = {
  compromised_lib: 50,
  malicious_intent: 50,
};

const RNG_SEED = 42;

// ---------------------------------------------------------------------------
// Deterministic RNG (xorshift32) — same seed → same selection forever
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ---------------------------------------------------------------------------
// GitHub API helpers — minimal, unauthenticated read-only.
// ---------------------------------------------------------------------------

/** Ensure the treeless dataset mirror exists; clone if absent, fetch+reset
 *  if present. We use --filter=blob:none --no-checkout so the local copy
 *  contains only metadata (commits + trees) — no zip blobs are pulled until
 *  the fetch phase asks for them. */
function ensureMirror(): void {
  if (existsSync(join(MIRROR_DIR, ".git"))) {
    console.log(`[select] updating dataset mirror at ${MIRROR_DIR}`);
    execFileSync("git", ["fetch", "--filter=blob:none", "origin", DATASET_BRANCH], {
      cwd: MIRROR_DIR,
      stdio: ["ignore", "inherit", "inherit"],
    });
    execFileSync("git", ["reset", "--hard", `origin/${DATASET_BRANCH}`], {
      cwd: MIRROR_DIR,
      stdio: ["ignore", "inherit", "inherit"],
    });
    return;
  }
  console.log(`[select] cloning dataset mirror (treeless) → ${MIRROR_DIR}`);
  mkdirSync(dirname(MIRROR_DIR), { recursive: true });
  execFileSync(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--branch",
      DATASET_BRANCH,
      DATASET_GIT_URL,
      MIRROR_DIR,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
}

function readDatasetSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: MIRROR_DIR, encoding: "utf-8" }).trim();
}

/** Read the manifest.json blob from the mirror without checking out files.
 *  `git show` materialises a single blob to stdout. */
function readManifestFromMirror(): Record<string, string[] | null> {
  const raw = execFileSync(
    "git",
    ["show", "HEAD:samples/npm/manifest.json"],
    { cwd: MIRROR_DIR, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(raw) as Record<string, string[] | null>;
}

/** Walk the entire `samples/npm/` tree using `git ls-tree -r`. Returns one
 *  line per file; we filter to .zip paths and parse them. The tree is
 *  fetched lazily on first ls-tree call (--filter=blob:none keeps blobs
 *  remote, but the trees themselves come down). */
function listAllZipPaths(): string[] {
  const out = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "HEAD", "samples/npm"],
    { cwd: MIRROR_DIR, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  return out
    .split("\n")
    .filter((line) => line.endsWith(".zip"));
}

function rawZipUrl(treePath: string): string {
  // treePath is "samples/npm/<class>/<name>/<version>/<filename>.zip"
  return `https://raw.githubusercontent.com/${DATASET_OWNER}/${DATASET_REPO}/${DATASET_BRANCH}/${treePath}`;
}

function parseDiscoveryDate(zipFilename: string): string {
  // "2025-11-24-02-echo-v0.0.7.zip" → "2025-11-24"
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(zipFilename);
  return m ? m[1]! : "unknown";
}

// ---------------------------------------------------------------------------
// Strategy: pull the entire repo tree once, build an index of every
// `samples/npm/<class>/<name>/<version>/<file>.zip` path, then run the
// stratified sample over candidate (name, version, class) triples and
// look up the exact ZIP from the index. One API call total.
// ---------------------------------------------------------------------------

interface CandidateTriple {
  packageName: string;
  version: string;
  className: DatadogClass;
}

function flattenManifest(manifest: Record<string, string[] | null>): {
  compromised_lib: CandidateTriple[];
  malicious_intent: CandidateTriple[];
} {
  const compromised: CandidateTriple[] = [];
  const malicious: CandidateTriple[] = [];

  for (const [pkg, versions] of Object.entries(manifest)) {
    if (versions === null) {
      // malicious_intent: the manifest doesn't tell us the version; we
      // discover it from the tree index below.
      malicious.push({ packageName: pkg, version: "_any_", className: "malicious_intent" });
    } else {
      for (const v of versions) {
        compromised.push({ packageName: pkg, version: v, className: "compromised_lib" });
      }
    }
  }

  return { compromised_lib: compromised, malicious_intent: malicious };
}

interface ZipEntry {
  className: DatadogClass;
  packageName: string;
  version: string;
  zipFilename: string;
  treePath: string;
}

/** Build an index keyed by `<class>/<name>` so we can find every ZIP for a
 *  given (class, name) in O(1). The value is a list because malicious_intent
 *  packages may have multiple version directories. */
function indexZipPaths(paths: string[]): Map<string, ZipEntry[]> {
  const index = new Map<string, ZipEntry[]>();
  for (const path of paths) {
    if (!path.startsWith("samples/npm/")) continue;
    // samples/npm/<class>/<package>/<version>/<filename>.zip
    const parts = path.split("/");
    if (parts.length < 6) continue;
    const className = parts[2] as DatadogClass;
    if (className !== "compromised_lib" && className !== "malicious_intent") continue;
    const packageName = parts[3]!;
    const version = parts[4]!;
    const zipFilename = parts.slice(5).join("/");

    const key = `${className}/${packageName}`;
    const list = index.get(key);
    const zipEntry: ZipEntry = { className, packageName, version, zipFilename, treePath: path };
    if (list) list.push(zipEntry);
    else index.set(key, [zipEntry]);
  }
  return index;
}

function resolveSample(
  triple: CandidateTriple,
  index: Map<string, ZipEntry[]>,
): DatadogSample | null {
  const key = `${triple.className}/${triple.packageName}`;
  const entries = index.get(key);
  if (!entries || entries.length === 0) return null;

  // For compromised_lib we want the exact version; for malicious_intent we
  // pick the first version present (most have only one).
  const match =
    triple.version === "_any_"
      ? entries[0]
      : entries.find((e) => e.version === triple.version);
  if (!match) return null;

  return {
    packageName: triple.packageName,
    version: match.version,
    className: triple.className,
    discoveryDate: parseDiscoveryDate(match.zipFilename),
    zipFilename: match.zipFilename,
    zipUrl: rawZipUrl(match.treePath),
  };
}

function main(): void {
  ensureMirror();
  const sha = readDatasetSha();
  console.log(`[select] dataset @ ${sha.slice(0, 12)}`);

  console.log(`[select] reading manifest.json from mirror...`);
  const manifest = readManifestFromMirror();
  const flat = flattenManifest(manifest);
  const total = flat.compromised_lib.length + flat.malicious_intent.length;
  console.log(
    `[select] dataset contains ${flat.compromised_lib.length} compromised_lib triples, ${flat.malicious_intent.length} malicious_intent triples (total ${total})`,
  );

  console.log(`[select] indexing zip paths from mirror tree...`);
  const zipPaths = listAllZipPaths();
  const index = indexZipPaths(zipPaths);
  console.log(`[select] indexed ${[...index.values()].reduce((a, b) => a + b.length, 0)} zip entries`);

  const rng = makeRng(RNG_SEED);

  const samples: DatadogSample[] = [];
  for (const className of ["compromised_lib", "malicious_intent"] as const) {
    const target = SAMPLES_PER_CLASS[className];
    const candidates = shuffle(flat[className], rng);
    console.log(`[select] resolving up to ${target} ${className} samples...`);

    let resolved = 0;
    let scanned = 0;
    while (resolved < target && scanned < candidates.length) {
      const triple = candidates[scanned]!;
      scanned++;
      const sample = resolveSample(triple, index);
      if (sample) {
        samples.push(sample);
        resolved++;
      }
    }
    console.log(`[select] resolved ${resolved} ${className} (scanned ${scanned} candidates)`);
  }

  const corpus: DatadogCorpus = {
    datasetCommitSha: sha,
    selectedAt: new Date().toISOString(),
    seed: RNG_SEED,
    totalSamplesInDataset: total,
    sampledPerClass: {
      compromised_lib: samples.filter((s) => s.className === "compromised_lib").length,
      malicious_intent: samples.filter((s) => s.className === "malicious_intent").length,
    },
    samples,
  };

  mkdirSync(dirname(CORPUS_OUT), { recursive: true });
  writeFileSync(CORPUS_OUT, JSON.stringify(corpus, null, 2));
  console.log(`[select] wrote ${CORPUS_OUT} (${samples.length} samples)`);
}

try {
  main();
} catch (err) {
  console.error("[select] failed:", err);
  process.exit(1);
}
