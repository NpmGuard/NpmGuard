import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(BENCH_ROOT, "..");
const DEFAULT_AUDITS_DIR = join(BENCH_ROOT, "results", "audits");

interface CliArgs {
  auditsDir: string;
  watchlists: string[];
  outJson: string | null;
  outMd: string | null;
  maxList: number;
}

interface AuditReportFile {
  entry?: {
    fixtureName?: string;
    category?: string;
    pkg?: { name?: string; version?: string };
  };
  result?: {
    durationMs?: number;
    verdict?: "SAFE" | "DANGEROUS" | null;
    capabilities?: string[];
    proofKinds?: string[];
    verifiedCapabilities?: string[];
    error?: string | null;
  };
}

interface WatchlistFile {
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  packageCount?: number;
  results?: WatchlistRow[];
  rows?: WatchlistRow[];
  packages?: WatchlistRow[];
}

interface WatchlistRow {
  packageName?: string;
  latestVersion?: string;
  status?: string;
  verdict?: string;
  error?: string | null;
  durationMs?: number;
  report?: { verdict?: string };
  result?: { verdict?: string };
}

interface CountMap {
  [key: string]: number;
}

interface MissedDatadogEntry {
  fixtureName: string;
  category: string;
  verdict: string;
  error: string | null;
}

interface CategorySummary {
  total: number;
  dangerous: number;
  safe: number;
  nullVerdict: number;
  errors: number;
  timeouts: number;
  recallIncludingFailures: number;
  recallExcludingInfraFailures: number | null;
}

interface DatadogSummary extends CategorySummary {
  categories: Record<string, CategorySummary>;
  capabilities: CountMap;
  verifiedCapabilities: CountMap;
  proofKinds: CountMap;
  latencyMs: {
    p50: number | null;
    p90: number | null;
    p95: number | null;
  };
  missed: MissedDatadogEntry[];
}

interface WatchlistSummary {
  file: string;
  packageCount: number | null;
  rows: number;
  safe: number;
  dangerous: number;
  timeouts: number;
  errors: number;
  precisionIncludingFailures: number | null;
  precisionExcludingInfraFailures: number | null;
  statuses: CountMap;
  verdicts: CountMap;
  falsePositives: WatchlistRow[];
}

interface V3Summary {
  generatedAt: string;
  auditsDir: string;
  datadog: DatadogSummary;
  watchlists: WatchlistSummary[];
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "audits-dir": { type: "string", default: DEFAULT_AUDITS_DIR },
      watchlist: { type: "string", multiple: true },
      "out-json": { type: "string" },
      "out-md": { type: "string" },
      "max-list": { type: "string", default: "25" },
    },
    strict: true,
  });

  const watchlistValue = values.watchlist;
  const watchlists = Array.isArray(watchlistValue)
    ? watchlistValue
    : watchlistValue
      ? [watchlistValue]
      : [];

  return {
    auditsDir: resolveInputPath(values["audits-dir"] as string),
    watchlists: watchlists.map(resolveInputPath),
    outJson: values["out-json"] ? resolveInputPath(values["out-json"] as string) : null,
    outMd: values["out-md"] ? resolveInputPath(values["out-md"] as string) : null,
    maxList: parseInt(values["max-list"] as string, 10),
  };
}

function resolveInputPath(path: string): string {
  if (isAbsolute(path)) return path;
  if (path === "bench" || path.startsWith("bench/")) return resolve(REPO_ROOT, path);
  return resolve(process.cwd(), path);
}

function increment(map: CountMap, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function ratio(successes: number, total: number): number | null {
  if (total <= 0) return null;
  return successes / total;
}

function quantile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
  return sorted[idx]!;
}

function isTimeout(error: string | null | undefined): boolean {
  return typeof error === "string" && error.toLowerCase().includes("timed out");
}

function emptyCategory(): CategorySummary {
  return {
    total: 0,
    dangerous: 0,
    safe: 0,
    nullVerdict: 0,
    errors: 0,
    timeouts: 0,
    recallIncludingFailures: 0,
    recallExcludingInfraFailures: null,
  };
}

function finalizeCategory(summary: CategorySummary): CategorySummary {
  const infraFailures = summary.errors;
  return {
    ...summary,
    recallIncludingFailures: ratio(summary.dangerous, summary.total) ?? 0,
    recallExcludingInfraFailures: ratio(
      summary.dangerous,
      summary.total - infraFailures,
    ),
  };
}

function summarizeDatadog(auditsDir: string, maxList: number): DatadogSummary {
  const overall = emptyCategory();
  const categories: Record<string, CategorySummary> = {};
  const capabilities: CountMap = {};
  const verifiedCapabilities: CountMap = {};
  const proofKinds: CountMap = {};
  const durations: number[] = [];
  const missed: MissedDatadogEntry[] = [];

  if (!existsSync(auditsDir)) {
    return {
      ...finalizeCategory(overall),
      categories,
      capabilities,
      verifiedCapabilities,
      proofKinds,
      latencyMs: { p50: null, p90: null, p95: null },
      missed,
    };
  }

  const files = readdirSync(auditsDir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  for (const file of files) {
    const report = JSON.parse(
      readFileSync(join(auditsDir, file), "utf-8"),
    ) as AuditReportFile;
    const category = report.entry?.category ?? "unknown";
    const fixtureName = report.entry?.fixtureName ?? file.replace(/-run\d+\.json$/, "");
    const result = report.result ?? {};
    const verdict = result.verdict === null || result.verdict === undefined
      ? "null"
      : result.verdict;
    const error = result.error ?? null;

    const bucket = categories[category] ?? emptyCategory();
    categories[category] = bucket;

    for (const summary of [overall, bucket]) {
      summary.total++;
      if (verdict === "DANGEROUS") summary.dangerous++;
      else if (verdict === "SAFE") summary.safe++;
      else summary.nullVerdict++;
      if (error) summary.errors++;
      if (isTimeout(error)) summary.timeouts++;
    }

    if (typeof result.durationMs === "number") durations.push(result.durationMs);
    for (const capability of result.capabilities ?? []) increment(capabilities, capability);
    for (const capability of result.verifiedCapabilities ?? []) {
      increment(verifiedCapabilities, capability);
    }
    for (const proofKind of result.proofKinds ?? []) increment(proofKinds, proofKind);

    if (verdict !== "DANGEROUS" && missed.length < maxList) {
      missed.push({ fixtureName, category, verdict, error });
    }
  }

  const finalizedCategories: Record<string, CategorySummary> = {};
  for (const [category, summary] of Object.entries(categories)) {
    finalizedCategories[category] = finalizeCategory(summary);
  }

  return {
    ...finalizeCategory(overall),
    categories: finalizedCategories,
    capabilities,
    verifiedCapabilities,
    proofKinds,
    latencyMs: {
      p50: quantile(durations, 0.5),
      p90: quantile(durations, 0.9),
      p95: quantile(durations, 0.95),
    },
    missed,
  };
}

function getWatchlistRows(file: WatchlistFile): WatchlistRow[] {
  if (Array.isArray(file.results)) return file.results;
  if (Array.isArray(file.rows)) return file.rows;
  if (Array.isArray(file.packages)) return file.packages;
  return [];
}

function rowVerdict(row: WatchlistRow): string {
  return row.verdict ?? row.report?.verdict ?? row.result?.verdict ?? row.status ?? "unknown";
}

function summarizeWatchlist(path: string): WatchlistSummary {
  const file = JSON.parse(readFileSync(path, "utf-8")) as WatchlistFile;
  const rows = getWatchlistRows(file);
  const statuses: CountMap = {};
  const verdicts: CountMap = {};
  const falsePositives: WatchlistRow[] = [];

  let safe = 0;
  let dangerous = 0;
  let timeouts = 0;
  let errors = 0;

  for (const row of rows) {
    const status = row.status ?? "unknown";
    const verdict = rowVerdict(row);
    increment(statuses, status);
    increment(verdicts, verdict);
    if (verdict === "SAFE") safe++;
    if (verdict === "DANGEROUS") {
      dangerous++;
      falsePositives.push(row);
    }
    if (status === "timeout" || verdict === "timeout" || isTimeout(row.error)) timeouts++;
    if (row.error) errors++;
  }

  return {
    file: basename(path),
    packageCount: file.packageCount ?? null,
    rows: rows.length,
    safe,
    dangerous,
    timeouts,
    errors,
    precisionIncludingFailures: ratio(safe, rows.length),
    precisionExcludingInfraFailures: ratio(safe, rows.length - timeouts - errors),
    statuses,
    verdicts,
    falsePositives,
  };
}

function pct(value: number | null): string {
  if (value === null) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(summary: V3Summary): string {
  const lines: string[] = [];
  lines.push("# NpmGuard Benchmark V3 Summary");
  lines.push("");
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push("");
  lines.push("## Datadog Replay");
  lines.push("");
  lines.push(`- Total: ${summary.datadog.total}`);
  lines.push(`- DANGEROUS: ${summary.datadog.dangerous}`);
  lines.push(`- SAFE misses: ${summary.datadog.safe}`);
  lines.push(`- Null verdicts: ${summary.datadog.nullVerdict}`);
  lines.push(`- Errors: ${summary.datadog.errors}`);
  lines.push(`- Timeouts: ${summary.datadog.timeouts}`);
  lines.push(`- Recall including failures: ${pct(summary.datadog.recallIncludingFailures)}`);
  lines.push(
    `- Recall excluding infra failures: ${pct(summary.datadog.recallExcludingInfraFailures)}`,
  );
  lines.push("");
  lines.push("| Category | Total | DANGEROUS | SAFE | Null | Errors | Recall | Recall excl. infra |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [category, stats] of Object.entries(summary.datadog.categories)) {
    lines.push(
      `| ${category} | ${stats.total} | ${stats.dangerous} | ${stats.safe} | ${stats.nullVerdict} | ${stats.errors} | ${pct(stats.recallIncludingFailures)} | ${pct(stats.recallExcludingInfraFailures)} |`,
    );
  }
  lines.push("");
  lines.push("## SAFE Watchlists");
  lines.push("");
  if (summary.watchlists.length === 0) {
    lines.push("- No watchlist result files supplied.");
  } else {
    lines.push("| File | Rows | SAFE | DANGEROUS | Timeouts | Errors | Precision | Precision excl. infra |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const watchlist of summary.watchlists) {
      lines.push(
        `| ${watchlist.file} | ${watchlist.rows} | ${watchlist.safe} | ${watchlist.dangerous} | ${watchlist.timeouts} | ${watchlist.errors} | ${pct(watchlist.precisionIncludingFailures)} | ${pct(watchlist.precisionExcludingInfraFailures)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Misses");
  lines.push("");
  if (summary.datadog.missed.length === 0) {
    lines.push("- No Datadog misses in the summarized audit files.");
  } else {
    for (const miss of summary.datadog.missed) {
      const suffix = miss.error ? ` (${miss.error})` : "";
      lines.push(`- ${miss.fixtureName}: ${miss.verdict}${suffix}`);
    }
  }
  for (const watchlist of summary.watchlists) {
    if (watchlist.falsePositives.length === 0) continue;
    lines.push("");
    lines.push(`## False Positives: ${watchlist.file}`);
    lines.push("");
    for (const row of watchlist.falsePositives) {
      const version = row.latestVersion ? `@${row.latestVersion}` : "";
      lines.push(`- ${row.packageName ?? "unknown"}${version}: ${row.status ?? "unknown"}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function writeOutput(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function main(): void {
  const args = parseCli();
  const summary: V3Summary = {
    generatedAt: new Date().toISOString(),
    auditsDir: args.auditsDir,
    datadog: summarizeDatadog(args.auditsDir, args.maxList),
    watchlists: args.watchlists.map(summarizeWatchlist),
  };

  if (args.outJson) {
    writeOutput(args.outJson, `${JSON.stringify(summary, null, 2)}\n`);
  }

  const markdown = renderMarkdown(summary);
  if (args.outMd) {
    writeOutput(args.outMd, markdown);
  }

  if (!args.outJson && !args.outMd) {
    process.stdout.write(markdown);
  }
}

try {
  main();
} catch (err) {
  console.error("[summarize:v3] failed:", err);
  process.exit(1);
}
