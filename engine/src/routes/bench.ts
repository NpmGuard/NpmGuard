import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";

type AuditLatestRow = {
  packageName?: string;
  version?: string;
  latestVersion?: string;
  status?: string;
  verdict?: string;
  error?: string;
  durationMs?: number;
};

type AuditLatestPayload = {
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  watchlist?: string;
  packageCount?: number;
  limit?: number | null;
  resultLimit?: number | null;
  dryRun?: boolean;
  counts?: Record<string, number>;
  results?: AuditLatestRow[];
};

type DatadogRun = {
  durationMs?: number;
  verdict?: string | null;
  capabilities?: string[];
  proofKinds?: string[];
  verifiedCapabilities?: string[];
  error?: string | null;
};

type DatadogResult = {
  fixtureName?: string;
  runs?: DatadogRun[];
};

type DatadogPayload = {
  datasetVersion?: string;
  engineSha?: string;
  modelId?: string;
  startedAt?: string;
  completedAt?: string;
  results?: DatadogResult[];
};

type BenchRow = {
  source: "public" | "datadog";
  packageName: string;
  version: string | null;
  fixtureName: string | null;
  category: "public" | "datadog-compromised" | "datadog-malicious-intent";
  status: string;
  verdict: string | null;
  durationMs: number;
  error: string | null;
  capabilities: string[];
  proofKinds: string[];
  verifiedCapabilities: string[];
  confirmedProofs: number;
  runIndex: number | null;
};

type BenchRunSummary = {
  file: string;
  source: "public" | "datadog";
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  watchlist: string | null;
  datasetVersion: string | null;
  engineSha: string | null;
  modelId: string | null;
  packageCount: number | null;
  limit: number | null;
  resultLimit: number | null;
  dryRun: boolean;
  counts: Record<string, number>;
  verdictCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  totalRows: number;
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  slowest: BenchRow[];
  rows: BenchRow[];
};

const RESULTS_DIR = path.resolve(process.cwd(), "../bench/results");
const MAX_RUNS = 20;

export const benchRoutes = new Hono();

function safeResultPath(file: string): string {
  if (!/^[A-Za-z0-9_.-]+\.json$/.test(file)) {
    throw new Error("Invalid benchmark result filename");
  }
  const resolved = path.resolve(RESULTS_DIR, file);
  const rel = path.relative(RESULTS_DIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Benchmark result path escapes results directory");
  }
  return resolved;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] ?? null;
}

function countBy(rows: BenchRow[], keyFor: (row: BenchRow) => string | null): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = keyFor(row);
    if (!key) return acc;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function timingStats(rows: BenchRow[]): {
  avgDurationMs: number | null;
  p95DurationMs: number | null;
  slowest: BenchRow[];
} {
  const durations = rows.map((row) => row.durationMs).filter((ms) => ms > 0);
  const avgDurationMs =
    durations.length === 0 ? null : Math.round(durations.reduce((sum, ms) => sum + ms, 0) / durations.length);

  return {
    avgDurationMs,
    p95DurationMs: percentile(durations, 95),
    slowest: [...rows].sort((a, b) => b.durationMs - a.durationMs).slice(0, 8),
  };
}

function commonSummary(args: {
  file: string;
  source: "public" | "datadog";
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  rows: BenchRow[];
  watchlist?: string | null;
  datasetVersion?: string | null;
  engineSha?: string | null;
  modelId?: string | null;
  packageCount?: number | null;
  limit?: number | null;
  resultLimit?: number | null;
  dryRun?: boolean;
  counts?: Record<string, number>;
}): BenchRunSummary {
  const timing = timingStats(args.rows);
  const counts = args.counts ?? countBy(args.rows, (row) => row.status);

  return {
    file: args.file,
    source: args.source,
    updatedAt: args.updatedAt,
    startedAt: args.startedAt,
    completedAt: args.completedAt,
    watchlist: args.watchlist ?? null,
    datasetVersion: args.datasetVersion ?? null,
    engineSha: args.engineSha ?? null,
    modelId: args.modelId ?? null,
    packageCount: args.packageCount ?? null,
    limit: args.limit ?? null,
    resultLimit: args.resultLimit ?? null,
    dryRun: args.dryRun === true,
    counts,
    verdictCounts: countBy(args.rows, (row) => row.verdict ?? row.status),
    categoryCounts: countBy(args.rows, (row) => row.category),
    totalRows: args.rows.length,
    avgDurationMs: timing.avgDurationMs,
    p95DurationMs: timing.p95DurationMs,
    slowest: timing.slowest,
    rows: args.rows,
  };
}

function summarizeAuditLatestPayload(
  file: string,
  payload: AuditLatestPayload,
  updatedAt: string,
): BenchRunSummary | null {
  if (!Array.isArray(payload.results)) return null;

  const rows = payload.results
    .filter((row) => typeof row.packageName === "string" && typeof row.status === "string")
    .map((row) => ({
      source: "public" as const,
      packageName: row.packageName!,
      version: row.latestVersion ?? row.version ?? null,
      fixtureName: null,
      category: "public" as const,
      status: row.status!,
      verdict: row.verdict ?? null,
      durationMs: typeof row.durationMs === "number" ? row.durationMs : 0,
      error: row.error ?? null,
      capabilities: [],
      proofKinds: [],
      verifiedCapabilities: [],
      confirmedProofs: 0,
      runIndex: null,
    }));

  return commonSummary({
    file,
    source: "public",
    updatedAt: payload.updatedAt ?? payload.finishedAt ?? payload.startedAt ?? updatedAt,
    startedAt: payload.startedAt ?? null,
    completedAt: payload.finishedAt ?? null,
    watchlist: payload.watchlist ?? null,
    packageCount: typeof payload.packageCount === "number" ? payload.packageCount : null,
    limit: typeof payload.limit === "number" ? payload.limit : null,
    resultLimit: typeof payload.resultLimit === "number" ? payload.resultLimit : null,
    dryRun: payload.dryRun === true,
    rows,
    counts: payload.counts,
  });
}

function fixtureCategory(fixtureName: string): BenchRow["category"] {
  if (fixtureName.includes("-dd-c-")) return "datadog-compromised";
  return "datadog-malicious-intent";
}

function fixtureVersion(fixtureName: string): string | null {
  const marker = fixtureName.lastIndexOf("-v");
  if (marker === -1) return null;
  return fixtureName.slice(marker + 2) || null;
}

function datadogStatus(run: DatadogRun): string {
  if (run.error) {
    return /time(?:d)? out|timeout/i.test(run.error) ? "timeout" : "failed";
  }
  if (run.verdict === "DANGEROUS") return "detected";
  if (run.verdict === "SAFE") return "missed";
  return "unknown";
}

function summarizeDatadogPayload(
  file: string,
  payload: DatadogPayload,
  updatedAt: string,
): BenchRunSummary | null {
  if (!Array.isArray(payload.results)) return null;

  const rows: BenchRow[] = [];
  for (const item of payload.results) {
    if (typeof item.fixtureName !== "string") continue;
    const runs = Array.isArray(item.runs) && item.runs.length > 0 ? item.runs : [{ error: "No run result" }];
    runs.forEach((run, index) => {
      const proofKinds = Array.isArray(run.proofKinds) ? run.proofKinds.filter((v): v is string => typeof v === "string") : [];
      rows.push({
        source: "datadog",
        packageName: item.fixtureName!,
        version: fixtureVersion(item.fixtureName!),
        fixtureName: item.fixtureName!,
        category: fixtureCategory(item.fixtureName!),
        status: datadogStatus(run),
        verdict: typeof run.verdict === "string" ? run.verdict : null,
        durationMs: typeof run.durationMs === "number" ? run.durationMs : 0,
        error: run.error ?? null,
        capabilities: Array.isArray(run.capabilities)
          ? run.capabilities.filter((v): v is string => typeof v === "string")
          : [],
        proofKinds,
        verifiedCapabilities: Array.isArray(run.verifiedCapabilities)
          ? run.verifiedCapabilities.filter((v): v is string => typeof v === "string")
          : [],
        confirmedProofs: proofKinds.filter((kind) => kind === "TEST_CONFIRMED").length,
        runIndex: runs.length > 1 ? index + 1 : null,
      });
    });
  }

  return commonSummary({
    file,
    source: "datadog",
    updatedAt: payload.completedAt ?? payload.startedAt ?? updatedAt,
    startedAt: payload.startedAt ?? null,
    completedAt: payload.completedAt ?? null,
    datasetVersion: payload.datasetVersion ?? null,
    engineSha: payload.engineSha ?? null,
    modelId: payload.modelId ?? null,
    rows,
  });
}

function summarizePayload(file: string, payload: unknown, updatedAt: string): BenchRunSummary | null {
  if (!payload || typeof payload !== "object") return null;
  const resultPayload = payload as { results?: unknown[] };
  const first = resultPayload.results?.[0] as Record<string, unknown> | undefined;
  if (first && typeof first.fixtureName === "string") {
    return summarizeDatadogPayload(file, payload as DatadogPayload, updatedAt);
  }
  return summarizeAuditLatestPayload(file, payload as AuditLatestPayload, updatedAt);
}

function readRun(file: string): BenchRunSummary | null {
  const filePath = safeResultPath(file);
  const stat = fs.statSync(filePath);
  const payload = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  return summarizePayload(file, payload, stat.mtime.toISOString());
}

benchRoutes.get("/bench/results", (c) => {
  if (!fs.existsSync(RESULTS_DIR)) {
    return c.json({ runs: [], resultsDir: RESULTS_DIR });
  }

  const runs = fs
    .readdirSync(RESULTS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const stat = fs.statSync(safeResultPath(file));
      return { file, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_RUNS)
    .flatMap(({ file }) => {
      try {
        const run = readRun(file);
        return run ? [run] : [];
      } catch {
        return [];
      }
    });

  return c.json({ runs, resultsDir: RESULTS_DIR });
});
