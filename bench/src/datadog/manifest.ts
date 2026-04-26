import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fixtureNameFor } from "./fixture.js";
import type { DatadogCorpus } from "./types.js";
import type { Manifest, ManifestEntry } from "../types.js";

// ---------------------------------------------------------------------------
// Manifest builder — translates a Datadog corpus.json into the bench's
// runner-facing Manifest schema. Ground truth for every Datadog sample
// is verdict=DANGEROUS; the auditor must produce that verdict to count
// as a true positive.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(BENCH_ROOT, "..");
const DATADOG_DIR = join(BENCH_ROOT, "dataset", "datadog");
const CORPUS_IN = join(DATADOG_DIR, "corpus.json");
const FIXTURES_DIR = join(REPO_ROOT, "sandbox", "test-fixtures");
const MANIFEST_OUT = join(BENCH_ROOT, "dataset", "manifest.json");

const DATASET_VERSION = "0.2.0-datadog";

function readCorpus(): DatadogCorpus {
  if (!existsSync(CORPUS_IN)) {
    throw new Error(
      `corpus.json not found at ${CORPUS_IN}. Run \`npm run -w @npmguard/bench datadog:select\` first.`,
    );
  }
  return JSON.parse(readFileSync(CORPUS_IN, "utf-8")) as DatadogCorpus;
}

function entryFor(sample: DatadogCorpus["samples"][number]): ManifestEntry {
  const fixtureName = fixtureNameFor(sample);
  const fixtureDir = join(FIXTURES_DIR, fixtureName);

  return {
    fixtureName,
    pkg: { name: sample.packageName, version: sample.version },
    sourceId: sample.zipFilename,
    category:
      sample.className === "compromised_lib"
        ? "datadog-compromised"
        : "datadog-malicious-intent",
    difficulty: null,
    expected: {
      verdict: "DANGEROUS",
      // The Datadog manifest doesn't tag attack capabilities. We require
      // only that the auditor flag the package as DANGEROUS — a successful
      // detection at any capability level counts as a true positive.
      // The analyzer will still report which capabilities the auditor
      // emitted, so per-class break-down is available without requiring it
      // as ground truth.
      capabilities: [],
      // We don't require TEST_CONFIRMED because some Datadog samples
      // genuinely cannot be reproduced in a sandbox (anti-analysis,
      // geo-gates). The verifiability metric is computed but not gated.
      kind: "AI_STATIC",
    },
    rationale: `Datadog ${sample.className} sample (${sample.discoveryDate}) — known malicious npm package; expected verdict is DANGEROUS.`,
    datadog: {
      discoveryDate: sample.discoveryDate,
      zipFilename: sample.zipFilename,
    },
  };
}

function buildManifest(corpus: DatadogCorpus): Manifest {
  const entries: ManifestEntry[] = [];
  const excludedMutations: { fixtureName: string; reason: string }[] = [];

  for (const sample of corpus.samples) {
    const fixtureName = fixtureNameFor(sample);
    const fixtureDir = join(FIXTURES_DIR, fixtureName);
    if (!existsSync(fixtureDir)) {
      excludedMutations.push({
        fixtureName,
        reason: `fixture not on disk — run \`npm run -w @npmguard/bench datadog:fetch\``,
      });
      continue;
    }
    if (!existsSync(join(fixtureDir, "package.json"))) {
      excludedMutations.push({
        fixtureName,
        reason: "no package.json — extraction layout unsupported",
      });
      continue;
    }
    entries.push(entryFor(sample));
  }

  return {
    datasetVersion: DATASET_VERSION,
    generatedAt: new Date().toISOString(),
    excludedSeeds: [],
    excludedMutations,
    entries,
  };
}

function main(): void {
  const corpus = readCorpus();
  console.log(
    `[datadog:manifest] reading ${corpus.samples.length} samples from corpus (dataset @ ${corpus.datasetCommitSha.slice(0, 12)})`,
  );

  const manifest = buildManifest(corpus);

  mkdirSync(dirname(MANIFEST_OUT), { recursive: true });
  writeFileSync(MANIFEST_OUT, JSON.stringify(manifest, null, 2));

  console.log(
    `[datadog:manifest] wrote ${MANIFEST_OUT} — ${manifest.entries.length} entries, ${manifest.excludedMutations.length} excluded`,
  );
  if (manifest.excludedMutations.length > 0) {
    for (const ex of manifest.excludedMutations.slice(0, 5)) {
      console.log(`[datadog:manifest]   excluded ${ex.fixtureName}: ${ex.reason}`);
    }
  }
  const byCategory = new Map<string, number>();
  for (const e of manifest.entries) {
    byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + 1);
  }
  for (const [cat, n] of byCategory) {
    console.log(`[datadog:manifest]   ${cat}: ${n}`);
  }
}

try {
  main();
} catch (err) {
  console.error("[datadog:manifest] failed:", err);
  process.exit(1);
}
