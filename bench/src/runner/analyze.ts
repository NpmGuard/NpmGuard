import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

import type {
  BenchmarkRun,
  EntryCategory,
  Manifest,
  ManifestEntry,
  MutationRunResult,
  SingleAuditResult,
  WilsonCI,
} from "../types.js";

// ---------------------------------------------------------------------------
// Analyzer — joins a BenchmarkRun with its source Manifest, computes
// detection metrics with Wilson 95% confidence intervals, and writes
// machine-readable summary.json + human-readable summary.md.
//
// METHODOLOGY.md §8 specifies Wilson over Wald for binomial proportions
// because Wald produces malformed intervals near 0 and 1 — exactly the
// regime where a strong auditor lives.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(__dirname, "..", "..");
const MANIFEST_IN = join(BENCH_ROOT, "dataset", "manifest.json");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  results: string;
  manifest: string;
  outDir: string;
}

function parseCli(): CliArgs {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      results: { type: "string" },
      manifest: { type: "string", default: MANIFEST_IN },
      "out-dir": { type: "string" },
    },
    strict: true,
  });
  if (!values.results) {
    console.error(
      "[analyze] --results <path-to-benchmark-run.json> is required",
    );
    process.exit(2);
  }
  const results = values.results as string;
  return {
    results,
    manifest: values.manifest as string,
    outDir: (values["out-dir"] as string) || dirname(results),
  };
}

// ---------------------------------------------------------------------------
// Wilson 95% CI (METHODOLOGY.md §8)
// ---------------------------------------------------------------------------

const Z_975 = 1.959964;

function wilson(successes: number, n: number): WilsonCI {
  if (n === 0) {
    return { estimate: 0, lower: 0, upper: 0, n: 0, successes: 0 };
  }
  const p = successes / n;
  const z = Z_975;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfWidth =
    (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    estimate: p,
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
    n,
    successes,
  };
}

// ---------------------------------------------------------------------------
// Detection rules — METHODOLOGY.md §8
// ---------------------------------------------------------------------------

function isDetected(entry: ManifestEntry, run: SingleAuditResult): boolean {
  if (run.verdict !== entry.expected.verdict) return false;
  if (entry.expected.capabilities.length === 0) {
    // Datadog samples don't constrain capabilities — verdict alone is enough.
    return true;
  }
  const got = new Set(run.capabilities);
  return entry.expected.capabilities.every((c) => got.has(c));
}

function isVerified(entry: ManifestEntry, run: SingleAuditResult): boolean {
  if (!isDetected(entry, run)) return false;
  // Verifiability: at least one proof was TEST_CONFIRMED.
  if (run.proofKinds.includes("TEST_CONFIRMED")) {
    if (entry.expected.capabilities.length === 0) return true;
    return entry.expected.capabilities.some((c) =>
      run.verifiedCapabilities.includes(c),
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface PerCategoryStats {
  category: EntryCategory;
  totalEntries: number;
  totalRuns: number;
  detected: number;
  verified: number;
  failedRuns: number;
  recall: WilsonCI;
  verifiability: WilsonCI;
  medianLatencySec: number;
  p95LatencySec: number;
}

interface AnalyzeOutput {
  datasetVersion: string;
  engineSha: string;
  modelId: string;
  startedAt: string;
  completedAt: string;
  totalAudits: number;
  perCategory: PerCategoryStats[];
  overall: {
    detected: number;
    total: number;
    recall: WilsonCI;
    verifiability: WilsonCI;
    failedRuns: number;
  };
  safeControls: {
    clean: number;
    falsePositives: number;
    total: number;
    precision: WilsonCI;
    failedRuns: number;
  };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx]!;
}

function buildLookups(manifest: Manifest): Map<string, ManifestEntry> {
  const m = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) m.set(entry.fixtureName, entry);
  return m;
}

function analyse(run: BenchmarkRun, manifest: Manifest): AnalyzeOutput {
  const lookup = buildLookups(manifest);

  // Per-category accumulators
  const buckets = new Map<
    EntryCategory,
    {
      entries: Set<string>;
      detectedRuns: number;
      verifiedRuns: number;
      totalRuns: number;
      failedRuns: number;
      latenciesSec: number[];
    }
  >();

  let overallDetected = 0;
  let overallVerified = 0;
  let overallTotal = 0;
  let overallFailed = 0;
  let totalAudits = 0;
  let safeClean = 0;
  let safeFalsePositives = 0;
  let safeTotal = 0;
  let safeFailed = 0;

  for (const fixture of run.results) {
    const entry = lookup.get(fixture.fixtureName);
    if (!entry) {
      console.warn(
        `[analyze] no manifest entry for ${fixture.fixtureName} — skipping`,
      );
      continue;
    }
    let bucket = buckets.get(entry.category);
    if (!bucket) {
      bucket = {
        entries: new Set(),
        detectedRuns: 0,
        verifiedRuns: 0,
        totalRuns: 0,
        failedRuns: 0,
        latenciesSec: [],
      };
      buckets.set(entry.category, bucket);
    }
    bucket.entries.add(fixture.fixtureName);
    for (const r of fixture.runs) {
      bucket.totalRuns++;
      totalAudits++;
      if (r.error) {
        bucket.failedRuns++;
        if (entry.expected.verdict === "SAFE") {
          safeFailed++;
        } else {
          overallFailed++;
        }
        continue;
      }
      bucket.latenciesSec.push(r.durationMs / 1000);
      if (isDetected(entry, r)) {
        bucket.detectedRuns++;
      }
      if (isVerified(entry, r)) {
        bucket.verifiedRuns++;
      }

      if (entry.expected.verdict === "SAFE") {
        safeTotal++;
        if (r.verdict === "SAFE") {
          safeClean++;
        } else if (r.verdict === "DANGEROUS") {
          safeFalsePositives++;
        }
      } else {
        overallTotal++;
        if (isDetected(entry, r)) {
          overallDetected++;
        }
        if (isVerified(entry, r)) {
          overallVerified++;
        }
      }
    }
  }

  const perCategory: PerCategoryStats[] = [];
  for (const [category, b] of buckets) {
    const sortedLat = [...b.latenciesSec].sort((a, b) => a - b);
    const median =
      sortedLat.length === 0 ? 0 : sortedLat[Math.floor(sortedLat.length / 2)]!;
    perCategory.push({
      category,
      totalEntries: b.entries.size,
      totalRuns: b.totalRuns,
      detected: b.detectedRuns,
      verified: b.verifiedRuns,
      failedRuns: b.failedRuns,
      recall: wilson(b.detectedRuns, b.totalRuns - b.failedRuns),
      verifiability:
        b.detectedRuns === 0
          ? wilson(0, 0)
          : wilson(b.verifiedRuns, b.detectedRuns),
      medianLatencySec: median,
      p95LatencySec: quantile(sortedLat, 0.95),
    });
  }

  // Stable order: known categories first, then alpha
  const order: EntryCategory[] = [
    "datadog-compromised",
    "datadog-malicious-intent",
  ];
  perCategory.sort((a, b) => {
    const ai = order.indexOf(a.category as EntryCategory);
    const bi = order.indexOf(b.category as EntryCategory);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return String(a.category).localeCompare(String(b.category));
  });

  return {
    datasetVersion: run.datasetVersion,
    engineSha: run.engineSha,
    modelId: run.modelId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    totalAudits,
    perCategory,
    overall: {
      detected: overallDetected,
      total: overallTotal,
      recall: wilson(overallDetected, overallTotal),
      verifiability:
        overallDetected === 0
          ? wilson(0, 0)
          : wilson(overallVerified, overallDetected),
      failedRuns: overallFailed,
    },
    safeControls: {
      clean: safeClean,
      falsePositives: safeFalsePositives,
      total: safeTotal,
      precision: wilson(safeClean, safeTotal),
      failedRuns: safeFailed,
    },
  };
}

// ---------------------------------------------------------------------------
// Markdown report (citable)
// ---------------------------------------------------------------------------

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function ci(c: WilsonCI): string {
  return `${pct(c.estimate)} (95% CI [${pct(c.lower)}, ${pct(c.upper)}], n=${c.n})`;
}

function markdownReport(out: AnalyzeOutput, runFile: string): string {
  const lines: string[] = [];
  lines.push("# NpmGuard benchmark — summary");
  lines.push("");
  lines.push(`- Dataset version: \`${out.datasetVersion}\``);
  lines.push(`- Engine SHA: \`${out.engineSha.slice(0, 12)}\``);
  lines.push(`- Model: \`${out.modelId}\``);
  lines.push(`- Started: ${out.startedAt}`);
  lines.push(`- Completed: ${out.completedAt}`);
  lines.push(`- Source run: \`${basename(runFile)}\``);
  lines.push("");

  lines.push("## Overall");
  lines.push("");
  lines.push(`- **Detection recall**: ${ci(out.overall.recall)}`);
  lines.push(`- **Verifiability** (TEST_CONFIRMED proofs among detections): ${ci(out.overall.verifiability)}`);
  lines.push(`- **SAFE precision**: ${ci(out.safeControls.precision)}`);
  lines.push(`- SAFE false positives: ${out.safeControls.falsePositives}`);
  lines.push(`- Total audits: ${out.totalAudits}`);
  lines.push(`- Failed dangerous audits (engine errors, excluded from recall): ${out.overall.failedRuns}`);
  lines.push(`- Failed SAFE audits (engine errors, excluded from precision): ${out.safeControls.failedRuns}`);
  lines.push("");

  lines.push("## Per-category");
  lines.push("");
  lines.push("| Category | Entries | Runs | Detected | Recall | Verified | Verifiability | Median latency | p95 latency |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const c of out.perCategory) {
    lines.push(
      [
        c.category,
        c.totalEntries,
        c.totalRuns,
        c.detected,
        ci(c.recall),
        c.verified,
        ci(c.verifiability),
        `${c.medianLatencySec.toFixed(1)}s`,
        `${c.p95LatencySec.toFixed(1)}s`,
      ].join(" | "),
    );
  }
  lines.push("");

  lines.push("## Methodology");
  lines.push("");
  lines.push("Detection events are computed per METHODOLOGY.md §8 — a run counts as a true positive when the auditor's verdict matches the expected verdict and any required capabilities are present. Verifiability counts TEST_CONFIRMED proofs among detections. Recall uses Wilson 95% confidence intervals; failed runs (HTTP errors, timeouts, infra failures) are excluded from rate denominators and reported separately.");
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseCli();
  if (!existsSync(args.results)) {
    throw new Error(`results file not found: ${args.results}`);
  }
  if (!existsSync(args.manifest)) {
    throw new Error(`manifest file not found: ${args.manifest}`);
  }

  const run = JSON.parse(readFileSync(args.results, "utf-8")) as BenchmarkRun;
  const manifest = JSON.parse(readFileSync(args.manifest, "utf-8")) as Manifest;

  const out = analyse(run, manifest);

  mkdirSync(args.outDir, { recursive: true });
  const stem = basename(args.results, ".json");
  const jsonOut = join(args.outDir, `${stem}-summary.json`);
  const mdOut = join(args.outDir, `${stem}-summary.md`);

  writeFileSync(jsonOut, JSON.stringify(out, null, 2));
  writeFileSync(mdOut, markdownReport(out, args.results));

  console.log(`[analyze] wrote ${jsonOut}`);
  console.log(`[analyze] wrote ${mdOut}`);
  console.log("");
  console.log(`[analyze] overall recall: ${ci(out.overall.recall)}`);
  for (const c of out.perCategory) {
    console.log(`[analyze]   ${c.category}: ${ci(c.recall)} (${c.detected}/${c.totalRuns - c.failedRuns})`);
  }
}

try {
  main();
} catch (err) {
  console.error("[analyze] failed:", err);
  process.exit(1);
}
