import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import type {
  Manifest,
  ManifestEntry,
  BenchmarkRun,
  MutationRunResult,
  SingleAuditResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Runner — reads bench/dataset/manifest.json, calls POST /audit on a running
// NpmGuard engine for each entry N times, persists every audit report to
// disk, writes an aggregate BenchmarkRun summary.
//
// Designed to be resumable: every audit's outcome is appended to a running
// JSONL file BEFORE the run exits, so a Ctrl-C mid-run loses at most one
// audit's worth of data and not the whole batch.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const REPO_ROOT = resolve(BENCH_ROOT, "..");
const MANIFEST_IN = join(BENCH_ROOT, "dataset", "manifest.json");
const RESULTS_DIR = join(BENCH_ROOT, "results");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  api: string;
  runs: number;
  limit: number | null;
  out: string;
  apiKey: string | null;
  concurrency: number;
  /** Per-audit timeout in ms. Verify phase can take 5+ minutes, so we
   *  allow generous headroom. */
  timeoutMs: number;
  /**
   * CRE mode is fire-and-forget: POST /audit returns 202 and the runner polls
   * for a persisted report. If the engine fails before writing a report, the
   * runner cannot observe that failure through the public API and would
   * otherwise keep queuing artificial 30-minute "timeouts".
   */
  maxConsecutiveTimeouts: number;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      api: { type: "string", default: "http://localhost:8000" },
      runs: { type: "string", default: "3" },
      limit: { type: "string" },
      out: { type: "string" },
      "api-key": { type: "string" },
      concurrency: { type: "string", default: "1" },
      timeout: { type: "string", default: "1800000" }, // 30 min — with bounded triage concurrency (8) and the new prompt, no fixture should take >25min. v3 hit 90min only because rate-limited triage failures crashed the queue silently and polling waited the full deadline.
      "max-consecutive-timeouts": { type: "string", default: "3" },
    },
    strict: true,
  });
  const concurrency = parseInt(values.concurrency as string, 10);
  return {
    api: values.api as string,
    runs: parseInt(values.runs as string, 10),
    limit: values.limit ? parseInt(values.limit as string, 10) : null,
    out: (values.out as string) || defaultOutPath(),
    apiKey: (values["api-key"] as string) || process.env.NPMGUARD_CRE_API_KEY || null,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 1,
    timeoutMs: parseInt(values.timeout as string, 10),
    maxConsecutiveTimeouts: parseInt(values["max-consecutive-timeouts"] as string, 10),
  };
}

function defaultOutPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return join(RESULTS_DIR, `${ts}.json`);
}

// ---------------------------------------------------------------------------
// Engine + dataset metadata
// ---------------------------------------------------------------------------

function readManifest(): Manifest {
  if (!existsSync(MANIFEST_IN)) {
    throw new Error(
      `manifest.json not found. Run \`npm run -w @npmguard/bench datadog:select && datadog:fetch && datadog:manifest\` first.`,
    );
  }
  return JSON.parse(readFileSync(MANIFEST_IN, "utf-8")) as Manifest;
}

function readEngineSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

interface VersionInfo {
  modelId: string;
  sandboxImageDigest: string | null;
}

async function fetchEngineVersion(api: string): Promise<VersionInfo> {
  // Best-effort — the engine doesn't yet expose a /version endpoint, so
  // we fall back to the env var convention used in engine/src/config.ts.
  const fallback: VersionInfo = {
    modelId: process.env.NPMGUARD_TRIAGE_MODEL || "unknown",
    sandboxImageDigest: null,
  };
  try {
    const resp = await fetch(`${api}/version`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return fallback;
    const v = (await resp.json()) as Partial<VersionInfo>;
    return {
      modelId: v.modelId ?? fallback.modelId,
      sandboxImageDigest: v.sandboxImageDigest ?? fallback.sandboxImageDigest,
    };
  } catch {
    return fallback;
  }
}

async function checkEngineHealth(api: string): Promise<void> {
  const resp = await fetch(`${api}/health`, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) {
    throw new Error(`engine /health returned ${resp.status} — is it running at ${api}?`);
  }
}

// ---------------------------------------------------------------------------
// CRE fire-and-forget helpers — delete the prior report so polling can
// detect when a fresh one is written, and parse the eventual report into
// the same SingleAuditResult shape the sync path produces.
// ---------------------------------------------------------------------------

const REPORTS_DIR = join(REPO_ROOT, "data", "reports");

function isLocalFixture(entry: ManifestEntry): boolean {
  return entry.fixtureName.startsWith("test-pkg-") || entry.fixtureName.includes("-bench-");
}

function auditPackageName(entry: ManifestEntry): string {
  return isLocalFixture(entry) ? entry.fixtureName : entry.pkg.name;
}

function auditPackageVersion(entry: ManifestEntry): string | null {
  return isLocalFixture(entry) ? null : entry.pkg.version;
}

function deleteExistingReport(entry: ManifestEntry): void {
  const packageName = auditPackageName(entry);
  const version = auditPackageVersion(entry);
  const target = version ? join(REPORTS_DIR, packageName, `${version}.json`) : join(REPORTS_DIR, packageName);
  if (!existsSync(target)) return;
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

const POLL_INTERVAL_MS = 10_000;

async function fetchReportOnce(
  args: CliArgs,
  entry: ManifestEntry,
): Promise<AuditReportShape | null> {
  const packageName = auditPackageName(entry);
  const version = auditPackageVersion(entry);
  const versionQuery = version ? `?version=${encodeURIComponent(version)}` : "";
  let resp: Response;
  try {
    resp = await fetch(
      `${args.api}/package/${encodeURIComponent(packageName)}/report${versionQuery}`,
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let body: { report?: AuditReportShape };
  try {
    body = (await resp.json()) as { report?: AuditReportShape };
  } catch {
    return null;
  }
  return body.report ?? null;
}

/** Last-resort: read the report from disk. Useful when the engine wrote
 *  the report (verdict in queue logs) but the HTTP fetch raced or 404'd
 *  for some reason — the file is still authoritative.
 *  Only safe when the bench runs on the same host as the engine. */
function loadReportFromDisk(entry: ManifestEntry): AuditReportShape | null {
  const packageName = auditPackageName(entry);
  const version = auditPackageVersion(entry);
  const dir = join(REPORTS_DIR, packageName);
  if (!existsSync(dir)) return null;
  try {
    if (version) {
      const versionedPath = join(dir, `${version}.json`);
      if (existsSync(versionedPath)) {
        return JSON.parse(readFileSync(versionedPath, "utf-8")) as AuditReportShape;
      }
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return null;
    const sorted = files
      .map((f) => ({ file: f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return JSON.parse(readFileSync(join(dir, sorted[0]!.file), "utf-8")) as AuditReportShape;
  } catch {
    return null;
  }
}

async function pollForReport(
  args: CliArgs,
  entry: ManifestEntry,
  start: number,
): Promise<SingleAuditResult> {
  const deadline = start + args.timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const report = await fetchReportOnce(args, entry);
    if (report) {
      return reportToResult(report, Date.now() - start);
    }
  }
  // Final fallback: read from disk. Catches the case where the engine
  // saved the report but HTTP polling missed it (rare race, but accounts
  // for ~20 of the 26 v3 timeouts where engine logs show completion but
  // the report endpoint never returned 200 to the runner).
  const diskReport = loadReportFromDisk(entry);
  if (diskReport) {
    console.log(`[runner] disk-fallback recovered report for ${entry.fixtureName}`);
    return reportToResult(diskReport, Date.now() - start);
  }
  return {
    durationMs: Date.now() - start,
    verdict: null,
    capabilities: [],
    proofKinds: [],
    verifiedCapabilities: [],
    llmTokens: null,
    auditId: null,
    error: `polling timed out after ${args.timeoutMs}ms`,
  };
}

function isPollingTimeout(result: SingleAuditResult): boolean {
  return typeof result.error === "string" && result.error.startsWith("polling timed out after ");
}

function reportToResult(
  report: AuditReportShape,
  durationMs: number,
): SingleAuditResult {
  const proofs = report.proofs ?? [];
  const proofKinds = proofs
    .map((p) => p.kind)
    .filter((k): k is string => typeof k === "string");
  const verifiedCapabilities = proofs
    .filter((p) => p.kind === "TEST_CONFIRMED" && p.capability)
    .map((p) => p.capability as string);
  return {
    durationMs,
    verdict: report.verdict,
    capabilities: (report.capabilities ?? []) as SingleAuditResult["capabilities"],
    proofKinds: proofKinds as SingleAuditResult["proofKinds"],
    verifiedCapabilities: verifiedCapabilities as SingleAuditResult["verifiedCapabilities"],
    llmTokens: null,
    auditId: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Single audit — POST /audit, parse the report into SingleAuditResult
// ---------------------------------------------------------------------------

interface AuditReportShape {
  verdict: "SAFE" | "DANGEROUS";
  capabilities?: string[];
  proofs?: Array<{ kind?: string; capability?: string | null }>;
  triage?: unknown;
  findings?: unknown[];
  trace?: Array<{ phase: string; durationMs: number }>;
}

async function runSingleAudit(
  args: CliArgs,
  entry: ManifestEntry,
): Promise<SingleAuditResult> {
  // CRE auth (X-API-Key) returns 202 Accepted and runs the audit
  // fire-and-forget. We then poll the report endpoint until a fresh
  // report appears. To distinguish "fresh" from "previous-run report",
  // we delete the existing report file before submitting.
  if (args.apiKey) {
    deleteExistingReport(entry);
  }

  const start = Date.now();
  const version = auditPackageVersion(entry);
  let resp: Response;
  try {
    resp = await fetch(`${args.api}/audit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(args.apiKey ? { "X-API-Key": args.apiKey } : {}),
      },
      body: JSON.stringify({
        packageName: auditPackageName(entry),
        ...(version ? { version } : {}),
      }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    return {
      durationMs: Date.now() - start,
      verdict: null,
      capabilities: [],
      proofKinds: [],
      verifiedCapabilities: [],
      llmTokens: null,
      auditId: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // CRE fire-and-forget path
  if (resp.status === 202) {
    return pollForReport(args, entry, start);
  }

  const durationMs = Date.now() - start;

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return {
      durationMs,
      verdict: null,
      capabilities: [],
      proofKinds: [],
      verifiedCapabilities: [],
      llmTokens: null,
      auditId: null,
      error: `HTTP ${resp.status}: ${text.slice(0, 200)}`,
    };
  }

  let report: AuditReportShape;
  try {
    report = (await resp.json()) as AuditReportShape;
  } catch (err) {
    return {
      durationMs,
      verdict: null,
      capabilities: [],
      proofKinds: [],
      verifiedCapabilities: [],
      llmTokens: null,
      auditId: null,
      error: `invalid json: ${err instanceof Error ? err.message : err}`,
    };
  }

  return reportToResult(report, durationMs);
}

// ---------------------------------------------------------------------------
// Persistence — write results.json after EACH audit finishes so a crash
// doesn't lose progress. The file is the in-progress aggregate; it gets
// rewritten atomically each tick.
// ---------------------------------------------------------------------------

function persistRun(outPath: string, run: BenchmarkRun): void {
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = `${outPath}.partial`;
  writeFileSync(tmp, JSON.stringify(run, null, 2));
  // Atomic-ish replace
  execFileSync("mv", [tmp, outPath]);
}

function archiveAudit(
  outPath: string,
  entry: ManifestEntry,
  runIndex: number,
  result: SingleAuditResult,
): void {
  const archiveDir = join(dirname(outPath), "audits");
  mkdirSync(archiveDir, { recursive: true });
  const safe = entry.fixtureName.replace(/[^a-z0-9._-]+/gi, "_");
  const file = join(archiveDir, `${safe}-run${runIndex + 1}.json`);
  writeFileSync(file, JSON.stringify({ entry, result }, null, 2));
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseCli();
  console.log(
    `[runner] config: api=${args.api} runs=${args.runs} limit=${args.limit ?? "all"} concurrency=${args.concurrency} out=${args.out}`,
  );

  await checkEngineHealth(args.api);
  console.log(`[runner] engine reachable`);

  const manifest = readManifest();
  const engineSha = readEngineSha();
  const version = await fetchEngineVersion(args.api);
  console.log(`[runner] engine sha=${engineSha.slice(0, 12)} model=${version.modelId} dataset=${manifest.datasetVersion}`);
  if (args.apiKey && args.maxConsecutiveTimeouts > 0) {
    console.log(
      `[runner] timeout circuit breaker: stop after ${args.maxConsecutiveTimeouts} consecutive polling timeouts`,
    );
  }
  if (args.apiKey && args.concurrency > 1) {
    console.log(
      "[runner] CRE queue note: the public engine may still serialize audits; increase concurrency only after a canary.",
    );
  }

  const entries = args.limit ? manifest.entries.slice(0, args.limit) : manifest.entries;
  console.log(`[runner] processing ${entries.length} fixtures × ${args.runs} runs = ${entries.length * args.runs} audits`);

  const startedAt = new Date().toISOString();
  const run: BenchmarkRun = {
    datasetVersion: manifest.datasetVersion,
    engineSha,
    modelId: version.modelId,
    sandboxImageDigest: version.sandboxImageDigest,
    runsPerMutation: args.runs,
    startedAt,
    completedAt: startedAt,
    results: [],
  };

  let auditCount = 0;
  let consecutivePollingTimeouts = 0;
  let stopRequested = false;
  let nextEntryIndex = 0;
  const total = entries.length * args.runs;
  const resultsByFixture = new Map<string, SingleAuditResult[]>();

  function refreshRunResults(): void {
    run.results = entries.flatMap((entry): MutationRunResult[] => {
      const runs = resultsByFixture.get(entry.fixtureName) ?? [];
      return runs.length > 0 ? [{ fixtureName: entry.fixtureName, runs }] : [];
    });
    run.completedAt = new Date().toISOString();
    persistRun(args.out, run);
  }

  async function processEntry(entry: ManifestEntry): Promise<void> {
    const runs: SingleAuditResult[] = [];
    resultsByFixture.set(entry.fixtureName, runs);
    for (let i = 0; i < args.runs; i++) {
      auditCount++;
      const currentAudit = auditCount;
      const t0 = Date.now();
      console.log(
        `[runner] [${currentAudit}/${total}] ${entry.fixtureName} run ${i + 1}/${args.runs} → starting`,
      );
      const result = await runSingleAudit(args, entry);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const tag = result.error
        ? `ERROR: ${result.error.slice(0, 80)}`
        : `${result.verdict} · caps=[${result.capabilities.join(",")}] proofs=[${result.proofKinds.join(",")}]`;
      console.log(`[runner] [${currentAudit}/${total}]   ${elapsed}s ${tag}`);
      if (isPollingTimeout(result)) {
        consecutivePollingTimeouts++;
      } else {
        consecutivePollingTimeouts = 0;
      }
      runs.push(result);
      archiveAudit(args.out, entry, i, result);
      refreshRunResults();

      if (
        args.apiKey &&
        args.maxConsecutiveTimeouts > 0 &&
        consecutivePollingTimeouts >= args.maxConsecutiveTimeouts
      ) {
        console.error(
          `[runner] stopping after ${consecutivePollingTimeouts} consecutive polling timeouts. ` +
            `CRE /audit returned 202 but no report was persisted; continuing would create artificial timeout rows. ` +
            `Partial results were saved to ${args.out}.`,
        );
        stopRequested = true;
        process.exitCode = 2;
        return;
      }
    }
  }

  async function worker(): Promise<void> {
    while (!stopRequested && nextEntryIndex < entries.length) {
      const entry = entries[nextEntryIndex++]!;
      await processEntry(entry);
    }
  }

  const workerCount = Math.min(args.concurrency, entries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  refreshRunResults();

  if (stopRequested) return;

  console.log(`[runner] done — ${run.results.length} fixtures, ${auditCount} audits → ${args.out}`);
}

main().catch((err) => {
  console.error("[runner] failed:", err);
  process.exit(1);
});
