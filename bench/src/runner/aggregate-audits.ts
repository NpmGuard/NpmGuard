import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(BENCH_ROOT, "..");
const DEFAULT_AUDITS_DIR = join(BENCH_ROOT, "results", "audits");
const DEFAULT_OUT = join(BENCH_ROOT, "results", "v3-datadog-143.json");

interface CliArgs {
  auditsDir: string;
  out: string;
  datasetVersion: string;
}

interface ManifestEntryShape {
  fixtureName: string;
  pkg?: { name?: string; version?: string };
  category?: string;
  datadog?: { discoveryDate?: string; zipFilename?: string };
}

interface SingleAuditResultShape {
  durationMs?: number;
  verdict?: "SAFE" | "DANGEROUS" | null;
  capabilities?: string[];
  proofKinds?: string[];
  verifiedCapabilities?: string[];
  llmTokens?: number | null;
  auditId?: string | null;
  error?: string | null;
}

interface AuditReportFile {
  entry?: ManifestEntryShape;
  result?: SingleAuditResultShape;
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

function readAuditFiles(auditsDir: string): Array<AuditReportFile & { file: string; mtimeMs: number }> {
  if (!existsSync(auditsDir)) {
    throw new Error(`audit reports directory does not exist: ${auditsDir}`);
  }

  return readdirSync(auditsDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const filePath = join(auditsDir, file);
      return {
        ...JSON.parse(readFileSync(filePath, "utf-8")),
        file,
        mtimeMs: statSync(filePath).mtimeMs,
      } as AuditReportFile & { file: string; mtimeMs: number };
    });
}

function main(): void {
  const args = parseCli();
  const reports = readAuditFiles(args.auditsDir);
  const mtimes = reports.map((report) => report.mtimeMs).filter((value) => Number.isFinite(value));
  const generatedAt = new Date().toISOString();

  const aggregate = {
    datasetVersion: args.datasetVersion,
    engineSha: "unknown",
    modelId: "unknown",
    sandboxImageDigest: null,
    runsPerMutation: 1,
    startedAt: mtimes.length > 0 ? new Date(Math.min(...mtimes)).toISOString() : generatedAt,
    completedAt: mtimes.length > 0 ? new Date(Math.max(...mtimes)).toISOString() : generatedAt,
    generatedAt,
    source: "per-fixture-audit-reports",
    results: reports.map((report) => {
      if (!report.entry?.fixtureName) {
        throw new Error(`missing entry.fixtureName in ${report.file}`);
      }
      if (!report.result) {
        throw new Error(`missing result in ${report.file}`);
      }
      return {
        fixtureName: report.entry.fixtureName,
        entry: report.entry,
        runs: [report.result],
      };
    }),
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(aggregate, null, 2)}\n`);
  console.log(`[aggregate:v3] wrote ${args.out}`);
  console.log(`[aggregate:v3] results: ${aggregate.results.length}`);
}

try {
  main();
} catch (err) {
  console.error("[aggregate:v3] failed:", err);
  process.exit(1);
}
