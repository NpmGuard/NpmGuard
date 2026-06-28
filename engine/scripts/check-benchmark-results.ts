type BenchRow = {
  packageName?: string;
  latestVersion?: string;
  version?: string;
  status?: string;
  verdict?: string;
  durationMs?: number;
  error?: string;
};

type BenchPayload = {
  startedAt?: string;
  results?: BenchRow[];
};

type Options = {
  file?: string;
  resultsDir: string;
  minRows: number;
  maxTimeouts: number;
  maxFailed: number;
  maxDangerous: number;
  maxP95Ms: number;
  json: boolean;
};

const DEFAULT_RESULTS_DIR = "../bench/results";

function usage(): never {
  console.log(`Usage:
  npm run bench:check -- [options]

Options:
  --file <path>          Check a specific benchmark JSON file
  --results-dir <path>   Directory to scan for latest JSON (default: ${DEFAULT_RESULTS_DIR})
  --min-rows <n>         Minimum result rows required (default: 1)
  --max-timeouts <n>     Maximum timeout rows allowed (default: 0)
  --max-failed <n>       Maximum failed rows allowed (default: 0)
  --max-dangerous <n>    Maximum DANGEROUS verdicts allowed (default: 0)
  --max-p95-ms <n>       Maximum p95 duration allowed (default: 600000)
  --json                 Print machine-readable summary
`);
  process.exit(0);
}

function readArg(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function readNumber(args: string[], index: number, flag: string): number {
  const value = Number(readArg(args, index, flag));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number`);
  return value;
}

async function latestResultFile(resultsDir: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const entries = await fs.readdir(resultsDir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const file = path.join(resultsDir, entry.name);
        const stat = await fs.stat(file);
        return { file, mtimeMs: stat.mtimeMs };
      }),
  );
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!files[0]) throw new Error(`No benchmark JSON files found in ${resultsDir}`);
  return files[0].file;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))]!;
}

function summarize(rows: BenchRow[]) {
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.status ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const verdictCounts = rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.verdict ?? row.status ?? "unknown";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const durations = rows
    .map((row) => row.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    rows: rows.length,
    counts,
    verdictCounts,
    p95Ms: percentile(durations, 95),
    slowest: [...rows]
      .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
      .slice(0, 5)
      .map((row) => ({
        packageName: row.packageName,
        version: row.latestVersion ?? row.version,
        status: row.status,
        verdict: row.verdict,
        durationMs: row.durationMs,
        error: row.error,
      })),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();

  const options: Options = {
    resultsDir: DEFAULT_RESULTS_DIR,
    minRows: 1,
    maxTimeouts: 0,
    maxFailed: 0,
    maxDangerous: 0,
    maxP95Ms: 600_000,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--file") {
      options.file = readArg(args, i, arg);
      i++;
    } else if (arg === "--results-dir") {
      options.resultsDir = readArg(args, i, arg);
      i++;
    } else if (arg === "--min-rows") {
      options.minRows = readNumber(args, i, arg);
      i++;
    } else if (arg === "--max-timeouts") {
      options.maxTimeouts = readNumber(args, i, arg);
      i++;
    } else if (arg === "--max-failed") {
      options.maxFailed = readNumber(args, i, arg);
      i++;
    } else if (arg === "--max-dangerous") {
      options.maxDangerous = readNumber(args, i, arg);
      i++;
    } else if (arg === "--max-p95-ms") {
      options.maxP95Ms = readNumber(args, i, arg);
      i++;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const fs = await import("node:fs/promises");
  const file = options.file ?? await latestResultFile(options.resultsDir);
  const payload = JSON.parse(await fs.readFile(file, "utf8")) as BenchPayload;
  if (!Array.isArray(payload.results)) throw new Error(`${file} is not an audit-latest result file`);

  const summary = summarize(payload.results);
  const violations: string[] = [];
  const timeouts = summary.counts.timeout ?? 0;
  const failed = summary.counts.failed ?? 0;
  const dangerous = summary.verdictCounts.DANGEROUS ?? 0;

  if (summary.rows < options.minRows) violations.push(`rows ${summary.rows} < ${options.minRows}`);
  if (timeouts > options.maxTimeouts) violations.push(`timeouts ${timeouts} > ${options.maxTimeouts}`);
  if (failed > options.maxFailed) violations.push(`failed ${failed} > ${options.maxFailed}`);
  if (dangerous > options.maxDangerous) violations.push(`dangerous ${dangerous} > ${options.maxDangerous}`);
  if (summary.p95Ms !== null && summary.p95Ms > options.maxP95Ms) {
    violations.push(`p95Ms ${summary.p95Ms} > ${options.maxP95Ms}`);
  }

  const result = {
    ok: violations.length === 0,
    file,
    startedAt: payload.startedAt,
    ...summary,
    violations,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[bench:check] ${result.ok ? "ok" : "failed"} ${file}`);
    console.log(
      `[bench:check] rows=${summary.rows} safe=${summary.verdictCounts.SAFE ?? 0} ` +
        `dangerous=${dangerous} timeout=${timeouts} failed=${failed} p95Ms=${summary.p95Ms ?? "-"}`,
    );
    if (violations.length > 0) {
      console.error(`[bench:check] violations: ${violations.join("; ")}`);
    }
  }

  if (!result.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
