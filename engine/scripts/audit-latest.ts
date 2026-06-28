import "dotenv/config";

type WatchItem = {
  packageName: string;
  latestVersion?: string;
  status:
    | "already-audited"
    | "accepted"
    | "completed"
    | "failed"
    | "timeout"
    | "would-audit";
  verdict?: string;
  error?: string;
  durationMs: number;
};

const DEFAULT_API = "http://127.0.0.1:8000";
const DEFAULT_WATCHLIST = new URL("../config/watchlist-packages.json", import.meta.url);
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_POLL_MS = 5_000;

function usage(): never {
  console.log(`Usage:
  npm run audit:latest -- [options]

Options:
  --api <url>          Engine API URL (default: ${DEFAULT_API})
  --watchlist <path>   JSON array or newline-delimited package list
  --limit <n>          Max missing latest versions to audit this run
  --result-limit <n>   Stop after this many result rows, including already-audited packages
  --timeout-ms <ms>    Per-package wait timeout (default: ${DEFAULT_TIMEOUT_MS})
  --poll-ms <ms>       Report polling interval (default: ${DEFAULT_POLL_MS})
  --delay-ms <ms>      Delay between packages to avoid API rate limits
  --out <path>         Write run metadata and results to a JSON file
  --dry-run            Resolve and compare only; do not enqueue audits

Auth:
  Reads NPMGUARD_CRE_API_KEY from the environment when not using --dry-run.
`);
  process.exit(0);
}

function readArg(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function readWatchlist(pathOrUrl: string | URL): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(pathOrUrl, "utf8");
  const trimmed = raw.trim();
  const values = trimmed.startsWith("[")
    ? JSON.parse(trimmed) as unknown
    : trimmed
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean);
  if (!Array.isArray(values) || !values.every((v) => typeof v === "string")) {
    throw new Error("Watchlist must be a JSON string array or newline-delimited package names");
  }
  return Array.from(new Set(values));
}

async function writeResults(outPath: string, payload: unknown): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function summarizeResults(results: WatchItem[]): Record<string, number> {
  return results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
}

function packagePath(packageName: string): string {
  return packageName.split("/").map(encodeURIComponent).join("/");
}

async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; ok: boolean; body: T | null; text: string }> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body: T | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  return { status: resp.status, ok: resp.ok, body, text };
}

async function resolveLatest(api: string, packageName: string): Promise<string> {
  const resp = await fetchJson<{ version?: string }>(
    new URL(`/resolve/${packagePath(packageName)}?version=latest`, api).toString(),
  );
  if (!resp.ok || !resp.body?.version) {
    throw new Error(`resolve failed (${resp.status}): ${resp.text}`);
  }
  return resp.body.version;
}

async function reportForVersion(
  api: string,
  packageName: string,
  version: string,
): Promise<{ verdict?: string } | null> {
  const resp = await fetchJson<{ report?: { verdict?: string } }>(
    new URL(`/package/${packagePath(packageName)}/report?version=${encodeURIComponent(version)}`, api).toString(),
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`report lookup failed (${resp.status}): ${resp.text}`);
  return { verdict: resp.body?.report?.verdict };
}

async function enqueueAudit(
  api: string,
  packageName: string,
  version: string,
  creApiKey: string,
): Promise<void> {
  const resp = await fetchJson<{ error?: string; message?: string }>(
    new URL("/audit", api).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": creApiKey,
      },
      body: JSON.stringify({ packageName, version }),
    },
  );
  if (!resp.ok) {
    throw new Error(
      `audit enqueue failed (${resp.status}): ${resp.body?.message ?? resp.body?.error ?? resp.text}`,
    );
  }
}

async function waitForVersionReport(
  api: string,
  packageName: string,
  version: string,
  timeoutMs: number,
  pollMs: number,
): Promise<{ verdict?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const report = await reportForVersion(api, packageName, version);
    if (report) return report;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) usage();

  let api = process.env.NPMGUARD_API_URL ?? DEFAULT_API;
  let watchlist: string | URL = DEFAULT_WATCHLIST;
  let limit = Number.POSITIVE_INFINITY;
  let resultLimit = Number.POSITIVE_INFINITY;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let pollMs = DEFAULT_POLL_MS;
  let delayMs = 0;
  let outPath: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--api") {
      api = readArg(args, i, arg);
      i++;
    } else if (arg === "--watchlist") {
      watchlist = readArg(args, i, arg);
      i++;
    } else if (arg === "--limit") {
      limit = Number(readArg(args, i, arg));
      i++;
    } else if (arg === "--result-limit") {
      resultLimit = Number(readArg(args, i, arg));
      i++;
    } else if (arg === "--timeout-ms") {
      timeoutMs = Number(readArg(args, i, arg));
      i++;
    } else if (arg === "--poll-ms") {
      pollMs = Number(readArg(args, i, arg));
      i++;
    } else if (arg === "--delay-ms") {
      delayMs = Number(readArg(args, i, arg));
      i++;
    } else if (arg === "--out") {
      outPath = readArg(args, i, arg);
      i++;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(limit) && limit !== Number.POSITIVE_INFINITY) throw new Error("--limit must be a number");
  if (limit <= 0) throw new Error("--limit must be positive");
  if (!Number.isFinite(resultLimit) && resultLimit !== Number.POSITIVE_INFINITY) throw new Error("--result-limit must be a number");
  if (resultLimit <= 0) throw new Error("--result-limit must be positive");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error("--poll-ms must be positive");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms must be non-negative");

  const creApiKey = process.env.NPMGUARD_CRE_API_KEY;
  if (!dryRun && !creApiKey) throw new Error("NPMGUARD_CRE_API_KEY is required");

  const packages = await readWatchlist(watchlist);
  const results: WatchItem[] = [];
  let enqueued = 0;
  const startedAt = new Date();
  console.log(`[audit:latest] api=${api} packages=${packages.length} limit=${limit} dryRun=${dryRun}`);

  const makePayload = () => ({
    startedAt: startedAt.toISOString(),
    updatedAt: new Date().toISOString(),
    api,
    watchlist: String(watchlist),
    packageCount: packages.length,
    limit: Number.isFinite(limit) ? limit : null,
    resultLimit: Number.isFinite(resultLimit) ? resultLimit : null,
    dryRun,
    timeoutMs,
    pollMs,
    delayMs,
    counts: summarizeResults(results),
    results,
  });

  for (const packageName of packages) {
    if (results.length >= resultLimit) {
      console.log(`[audit:latest] result limit reached (${results.length}); stopping`);
      break;
    }

    const start = Date.now();
    try {
      const latestVersion = await resolveLatest(api, packageName);
      const existing = await reportForVersion(api, packageName, latestVersion);
      if (existing) {
        console.log(`[audit:latest] ok ${packageName}@${latestVersion}: ${existing.verdict ?? "UNKNOWN"}`);
        results.push({
          packageName,
          latestVersion,
          status: "already-audited",
          verdict: existing.verdict,
          durationMs: Date.now() - start,
        });
        continue;
      }

      if (dryRun) {
        console.log(`[audit:latest] would audit ${packageName}@${latestVersion}`);
        results.push({
          packageName,
          latestVersion,
          status: "would-audit",
          durationMs: Date.now() - start,
        });
        continue;
      }

      if (enqueued >= limit) {
        console.log(`[audit:latest] limit reached; leaving ${packageName}@${latestVersion} for a later run`);
        continue;
      }

      console.log(`[audit:latest] enqueue ${packageName}@${latestVersion}`);
      await enqueueAudit(api, packageName, latestVersion, creApiKey!);
      enqueued++;
      const report = await waitForVersionReport(api, packageName, latestVersion, timeoutMs, pollMs);
      if (!report) {
        console.log(`[audit:latest] timeout ${packageName}@${latestVersion}`);
        results.push({
          packageName,
          latestVersion,
          status: "timeout",
          durationMs: Date.now() - start,
        });
        continue;
      }

      console.log(`[audit:latest] done ${packageName}@${latestVersion}: ${report.verdict ?? "UNKNOWN"}`);
      results.push({
        packageName,
        latestVersion,
        status: "completed",
        verdict: report.verdict,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[audit:latest] failed ${packageName}: ${error}`);
      results.push({
        packageName,
        status: "failed",
        error,
        durationMs: Date.now() - start,
      });
    } finally {
      if (outPath) {
        await writeResults(outPath, makePayload());
      }
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  const payload = makePayload();

  if (outPath) {
    await writeResults(outPath, payload);
    console.log(`[audit:latest] wrote ${outPath}`);
  }

  console.log(`[audit:latest] summary ${JSON.stringify(payload.counts)}`);
  console.log(JSON.stringify(payload, null, 2));

  if (results.some((r) => r.status === "failed" || r.status === "timeout")) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[audit:latest] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
