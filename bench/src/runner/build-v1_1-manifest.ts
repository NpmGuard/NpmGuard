import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { SEEDS } from "../seeds/catalog.js";
import { Manifest, type ManifestEntry } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_DATADOG_MANIFEST = join(BENCH_ROOT, "dataset", "manifest.v3.json");
const DEFAULT_OUT = join(BENCH_ROOT, "dataset", "manifest.v1.1.json");
const DEFAULT_DATASET_VERSION = "0.4.0-v1.1-datadog-143-safe-28";

interface CliArgs {
  datadogManifest: string;
  out: string;
  datasetVersion: string;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      datadog: { type: "string", default: DEFAULT_DATADOG_MANIFEST },
      out: { type: "string", default: DEFAULT_OUT },
      "dataset-version": { type: "string", default: DEFAULT_DATASET_VERSION },
    },
    strict: true,
  });

  return {
    datadogManifest: resolve(values.datadog as string),
    out: resolve(values.out as string),
    datasetVersion: values["dataset-version"] as string,
  };
}

function safeBaselineEntries(): ManifestEntry[] {
  return SEEDS.map((seed) => ({
    fixtureName: seed.name,
    pkg: {
      name: seed.name,
      version: seed.version,
    },
    sourceId: "safe-baseline",
    category: "baseline",
    difficulty: null,
    expected: {
      verdict: "SAFE",
      capabilities: [],
      kind: "AI_STATIC",
    },
    rationale:
      `SAFE baseline: real npm package ${seed.name}@${seed.version}, ` +
      `pinned by SRI in the seed catalog. ${seed.description}`,
  }));
}

function main(): void {
  const args = parseCli();
  const datadog = Manifest.parse(
    JSON.parse(readFileSync(args.datadogManifest, "utf-8")),
  );
  const safeEntries = safeBaselineEntries();
  const combined = Manifest.parse({
    ...datadog,
    datasetVersion: args.datasetVersion,
    generatedAt: new Date().toISOString(),
    entries: [...datadog.entries, ...safeEntries],
  });

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(combined, null, 2)}\n`);
  console.log(
    `[manifest:v1.1] wrote ${args.out} (${datadog.entries.length} dangerous + ${safeEntries.length} safe)`,
  );
}

main();
