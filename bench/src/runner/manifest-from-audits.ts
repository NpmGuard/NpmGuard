import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import { Manifest, ManifestEntry, type ManifestEntry as ManifestEntryType } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(BENCH_ROOT, "..");
const DEFAULT_AUDITS_DIR = join(BENCH_ROOT, "results", "audits");
const DEFAULT_OUT = join(BENCH_ROOT, "dataset", "manifest.v3.json");

interface CliArgs {
  auditsDir: string;
  out: string;
  datasetVersion: string;
}

interface AuditReportFile {
  entry?: unknown;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "audits-dir": { type: "string", default: DEFAULT_AUDITS_DIR },
      out: { type: "string", default: DEFAULT_OUT },
      "dataset-version": { type: "string", default: "0.3.0-v3-datadog-143" },
    },
    strict: true,
  });

  return {
    auditsDir: resolveInputPath(values["audits-dir"] as string),
    out: resolveInputPath(values.out as string),
    datasetVersion: values["dataset-version"] as string,
  };
}

function resolveInputPath(path: string): string {
  if (isAbsolute(path)) return path;
  if (path === "bench" || path.startsWith("bench/")) return resolve(REPO_ROOT, path);
  return resolve(process.cwd(), path);
}

function sortEntries(entries: ManifestEntryType[]): ManifestEntryType[] {
  return [...entries].sort((a, b) => {
    const byCategory = a.category.localeCompare(b.category);
    if (byCategory !== 0) return byCategory;
    return a.fixtureName.localeCompare(b.fixtureName);
  });
}

function readEntries(auditsDir: string): ManifestEntryType[] {
  if (!existsSync(auditsDir)) {
    throw new Error(`audit reports directory does not exist: ${auditsDir}`);
  }

  const byFixture = new Map<string, ManifestEntryType>();
  const files = readdirSync(auditsDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(auditsDir, file), "utf-8")) as AuditReportFile;
    const parsed = ManifestEntry.safeParse(raw.entry);
    if (!parsed.success) {
      throw new Error(`invalid manifest entry in ${file}: ${parsed.error.message}`);
    }

    const existing = byFixture.get(parsed.data.fixtureName);
    if (existing && JSON.stringify(existing) !== JSON.stringify(parsed.data)) {
      throw new Error(`conflicting manifest entries for ${parsed.data.fixtureName}`);
    }
    byFixture.set(parsed.data.fixtureName, parsed.data);
  }

  return sortEntries([...byFixture.values()]);
}

function main(): void {
  const args = parseCli();
  const entries = readEntries(args.auditsDir);
  const manifest = Manifest.parse({
    datasetVersion: args.datasetVersion,
    generatedAt: new Date().toISOString(),
    excludedSeeds: [],
    excludedMutations: [],
    entries,
  });

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);

  const byCategory = new Map<string, number>();
  for (const entry of manifest.entries) {
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
  }

  console.log(`[manifest:v3] wrote ${args.out}`);
  console.log(`[manifest:v3] entries: ${manifest.entries.length}`);
  for (const [category, count] of byCategory) {
    console.log(`[manifest:v3]   ${category}: ${count}`);
  }
}

try {
  main();
} catch (err) {
  console.error("[manifest:v3] failed:", err);
  process.exit(1);
}
