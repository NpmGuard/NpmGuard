import { SOURCE_FILE_TYPES } from "./config.js";
import type { AuditReport, DealBreaker, FileVerdict, PhaseLog } from "./models.js";
import type { FileSummary, Hypothesis, HypothesisSeverity } from "@npmguard/shared";
import { resolvePackage, cleanupPackage } from "./phases/resolve.js";
import { analyzeInventory } from "./phases/inventory.js";
import { extractIntent } from "./phases/intent-extraction.js";
import { runFlag } from "./phases/flag.js";
import { runHypothesize } from "./phases/hypothesize.js";
import { buildGraphFromHypotheses } from "./orchestrator/build-graph.js";
import { deriveGraphVerdict, type GraphVerdictReport } from "./orchestrator/verdict.js";
import { runOrchestrator } from "./orchestrator/orchestrator.js";
import type { HypothesisGraph } from "./graph/hypothesis-graph.js";
import { startAuditLog } from "./audit-log.js";
import { ArtifactStore } from "./evidence/artifact-store.js";
import type { EmitFn } from "./events.js";
import { setSessionPackagePath, setSessionCleanup } from "./events.js";
import { withTimeout } from "./util.js";
import { AuditIncompleteError } from "./errors.js";

// ---------------------------------------------------------------------------
// Legacy file_verdict SSE adapter (kept for frontend code-viewer compat)
// ---------------------------------------------------------------------------

const SEVERITY_TO_SCORE: Record<HypothesisSeverity, number> = {
  low: 3,
  medium: 6,
  high: 8,
  critical: 10,
};

const EMPTY_COUNTS: GraphVerdictReport["counts"] = {
  total: 0,
  open: 0,
  inProgress: 0,
  confirmed: 0,
  refuted: 0,
  deferred: 0,
};

/**
 * Reconstruct per-file FileVerdict records from the triage output so the
 * existing `file_verdict` SSE event and frontend code-viewer continue to work.
 */
function emitLegacyFileVerdicts(
  fileSummaries: FileSummary[],
  hypotheses: Hypothesis[],
  emit?: EmitFn,
): void {
  const hypsByFile = new Map<string, Hypothesis[]>();
  for (const h of hypotheses) {
    for (const f of h.focusFiles) {
      const bucket = hypsByFile.get(f) ?? [];
      bucket.push(h);
      hypsByFile.set(f, bucket);
    }
  }

  for (const summary of fileSummaries) {
    const hyps = hypsByFile.get(summary.file) ?? [];
    const maxSeverity = hyps.reduce<HypothesisSeverity>(
      (m, h) => (SEVERITY_TO_SCORE[h.severity] > SEVERITY_TO_SCORE[m] ? h.severity : m),
      "low",
    );
    const riskContribution = hyps.length === 0 ? 0 : SEVERITY_TO_SCORE[maxSeverity];
    const suspiciousPatterns = hyps.map((h) => h.description);
    const suspiciousLines =
      hyps
        .flatMap((h) => h.focusLines.filter((fl) => fl.file === summary.file).map((fl) => fl.range))
        .join(",") || undefined;

    const verdict: FileVerdict = {
      file: summary.file,
      capabilities: summary.capabilities,
      suspiciousPatterns,
      suspiciousLines,
      summary: summary.summary,
      riskContribution,
    };
    emit?.("file_verdict", { verdict });
  }
}

async function timedPhase<T>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number,
  inputSummary: Record<string, unknown>,
  outputSummary: (result: T) => Record<string, unknown>,
  emit?: EmitFn,
): Promise<{ result: T; log: PhaseLog }> {
  emit?.("phase_started", { phase: name });
  const start = Date.now();
  const result = await withTimeout(fn(), timeoutMs, name);
  const durationMs = Date.now() - start;
  const log: PhaseLog = {
    phase: name,
    durationMs,
    input: inputSummary,
    output: outputSummary(result),
  };
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${name}] completed in ${durationMs}ms`);
  console.log(`${"─".repeat(60)}`);
  console.log(`[${name}] INPUT:`);
  console.log(JSON.stringify(log.input, null, 2));
  console.log(`[${name}] OUTPUT:`);
  console.log(JSON.stringify(log.output, null, 2));
  console.log(`${"=".repeat(60)}\n`);
  emit?.("phase_completed", { phase: name, durationMs });
  return { result, log };
}

/** Assemble the shipped report from a derived graph verdict. */
function buildReport(
  graphVerdict: GraphVerdictReport,
  graph: HypothesisGraph,
  fileSummaries: FileSummary[],
  trace: PhaseLog[],
  dealbreaker: DealBreaker | null = null,
): AuditReport {
  return {
    schemaVersion: 2,
    verdict: graphVerdict.verdict,
    rationale: graphVerdict.rationale,
    counts: graphVerdict.counts,
    confirmedHypIds: graphVerdict.confirmedHypIds,
    hypotheses: graph.all(),
    fileSummaries,
    dealbreaker,
    trace,
  };
}

function emitVerdict(emit: EmitFn | undefined, report: AuditReport): void {
  emit?.("verdict_reached", {
    verdict: report.verdict,
    rationale: report.rationale,
    counts: report.counts,
    confirmedCount: report.counts.confirmed,
  });
}

export interface AuditResult {
  report: AuditReport;
  packagePath: string;
  cleanup: () => void;
}

export async function runAudit(packageName: string, emit?: EmitFn, auditId?: string, version?: string): Promise<AuditResult> {
  console.log(`[pipeline] starting audit for ${packageName}${version ? `@${version}` : ""}`);
  const log = startAuditLog(packageName);
  const artifactStore = new ArtifactStore(log.runDir);
  const trace: PhaseLog[] = [];

  emit?.("audit_started", { packageName });

  // Resolve — download and unpack the package into a working directory.
  const { result: resolved, log: resolveLog } = await timedPhase(
    "resolve",
    () => resolvePackage(packageName, version),
    2 * 60_000,
    { packageName, version },
    (r) => ({ path: r.path, needsCleanup: r.needsCleanup }),
    emit,
  );
  trace.push(resolveLog);
  log.writeLog("resolve.json", resolved);

  // Store package path on session so file-serving endpoint works
  if (auditId) {
    setSessionPackagePath(auditId, resolved.path);
    setSessionCleanup(auditId, () => cleanupPackage(resolved));
  }

  try {
    // Inventory — classify files, parse the manifest, run structural checks.
    const { result: inventory, log: inventoryLog } = await timedPhase(
      "inventory",
      () => analyzeInventory(resolved.path),
      30_000,
      { packagePath: resolved.path },
      (inv) => ({
        fileCount: inv.files.length,
        sourceFiles: inv.files.filter((f) => SOURCE_FILE_TYPES.has(f.fileType)).length,
        flagCount: inv.flags.length,
        flags: inv.flags.map((f) => `[${f.severity}] ${f.check}: ${f.detail}`),
        hasDealbreaker: !!inv.dealbreaker,
        scripts: inv.scripts,
        metadata: inv.metadata,
        entryPoints: inv.entryPoints,
      }),
      emit,
    );
    trace.push(inventoryLog);
    log.writeLog("inventory.json", inventory);

    // Emit file list for frontend visualization
    emit?.("file_list", { files: inventory.files });

    // Emit inventory metadata (scripts, deps, entry points) for frontend
    emit?.("inventory_meta", {
      scripts: inventory.scripts,
      dependencies: inventory.dependencies,
      entryPoints: inventory.entryPoints,
      metadata: inventory.metadata,
    });

    // Scale phase timeouts on whichever signal is bigger: file count OR
    // total source size. A single 10MB obfuscated bundle (sourceFileCount=1)
    // is harder to analyze than 50 small files — without sizeScale it gets
    // scale=1× and times out the investigation phase. Both clamp at 4×.
    const sourceFiles = inventory.files.filter(
      (f) => SOURCE_FILE_TYPES.has(f.fileType) && !f.isBinary,
    );
    const sourceFileCount = sourceFiles.length;
    const totalSrcKB = sourceFiles.reduce((s, f) => s + f.sizeBytes / 1024, 0);
    const countScale = Math.min(4, 1 + Math.max(0, sourceFileCount - 20) * 0.025);
    const sizeScale = Math.min(4, 1 + Math.max(0, totalSrcKB - 200) / 500);
    const timeoutScale = Math.max(countScale, sizeScale);
    console.log(
      `[pipeline] ${sourceFileCount} source files / ${totalSrcKB.toFixed(0)}KB → ` +
        `count=${countScale.toFixed(2)}× size=${sizeScale.toFixed(2)}× → scale ${timeoutScale.toFixed(2)}×`,
    );

    // Dealbreaker -> immediate DANGEROUS. Structural short-circuit: an
    // unambiguous install-time threat blocks without the hypothesis graph.
    // This is the one non-dynamic blocker, by design.
    if (inventory.dealbreaker) {
      const dealbreaker: DealBreaker = {
        check: inventory.dealbreaker.check,
        detail: inventory.dealbreaker.detail,
      };
      const report: AuditReport = {
        schemaVersion: 2,
        verdict: "DANGEROUS",
        rationale: `Dealbreaker: ${dealbreaker.check} — ${dealbreaker.detail}`,
        counts: EMPTY_COUNTS,
        confirmedHypIds: [],
        hypotheses: [],
        fileSummaries: [],
        dealbreaker,
        trace,
      };
      log.writeLog("report.json", report);
      emitVerdict(emit, report);
      return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
    }

    // Intent extraction — derive the stated-purpose baseline FLAG uses to
    // reason about capability mismatch.
    const { result: intent, log: intentLog } = await timedPhase(
      "intent-extraction",
      () => extractIntent(resolved.path, inventory),
      60_000,
      { packageName: inventory.metadata.name, description: inventory.metadata.description },
      (i) => ({
        statedPurpose: i.statedPurpose,
        expectedCapabilities: i.expectedCapabilities,
        rationale: i.rationale,
      }),
      emit,
    );
    trace.push(intentLog);
    log.writeLog("intent.json", intent);
    emit?.("intent_extracted", {
      statedPurpose: intent.statedPurpose,
      expectedCapabilities: intent.expectedCapabilities,
    });

    // FLAG — cheap, high-recall per-file pass emits thin flags (file + lines +
    // why). Over-flagging is by design; precision comes in HYPOTHESIZE.
    const { result: flagOutput, log: flagLog } = await timedPhase(
      "flag",
      () => runFlag(resolved.path, inventory, intent, emit),
      5 * 60_000 * timeoutScale,
      {
        sourceFiles: inventory.files
          .filter((f) => SOURCE_FILE_TYPES.has(f.fileType) && !f.isBinary)
          .map((f) => ({ path: f.path, sizeBytes: f.sizeBytes })),
        flagCount: inventory.flags.length,
        packageName: inventory.metadata.name,
      },
      (t) => ({
        flagCount: t.flags.length,
        flags: t.flags.map((fl) => ({ file: fl.file, lines: fl.lines, why: fl.why })),
        fileSummaries: t.fileSummaries,
      }),
      emit,
    );
    trace.push(flagLog);
    log.writeLog("flag.json", flagOutput);

    // No flags → nothing suspected → SAFE. FLAG raises on any file it cannot
    // read, so an empty flag set means every file was analyzed and cleared.
    if (flagOutput.flags.length === 0) {
      const { graph } = buildGraphFromHypotheses(auditId ?? "audit_unknown", []);
      emitLegacyFileVerdicts(flagOutput.fileSummaries, [], emit);
      const graphVerdict = deriveGraphVerdict(graph);
      console.log(`[pipeline] no flags from FLAG — ${graphVerdict.verdict}`);
      const report = buildReport(graphVerdict, graph, flagOutput.fileSummaries, trace);
      log.writeLog("report.json", report);
      emitVerdict(emit, report);
      return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
    }

    // HYPOTHESIZE — arm each flag into a runnable hypothesis: a description, a
    // best-match label, and an experiment (tool calls from the shared registry).
    // It arms every flag or raises HypothesizeError; a raised suspicion the model
    // cannot turn into a test is an audit ERROR, never a hypothesis without a run.
    const { result: hypotheses, log: hypothesizeLog } = await timedPhase(
      "hypothesize",
      () =>
        runHypothesize(flagOutput.flags, {
          packagePath: resolved.path,
          intent,
          entryPoints: inventory.entryPoints,
          emit,
        }),
      5 * 60_000 * timeoutScale,
      { flagCount: flagOutput.flags.length },
      (hs) => ({
        hypothesisCount: hs.length,
        hypotheses: hs.map((x) => ({
          hypId: x.hypId,
          claim: x.claim.kind,
          severity: x.severity,
          description: x.description,
          toolCalls: x.experiment.map((c) => c.tool),
        })),
      }),
      emit,
    );
    trace.push(hypothesizeLog);
    log.writeLog("hypotheses.json", hypotheses);

    emitLegacyFileVerdicts(flagOutput.fileSummaries, hypotheses, emit);

    emit?.("triage_complete", {
      hypothesisCount: hypotheses.length,
      hypotheses: hypotheses.map((h) => ({
        hypId: h.hypId,
        claim: h.claim.kind,
        severity: h.severity,
        description: h.description,
      })),
    });

    // Build the hypothesis graph from the armed hypotheses. Jaro-Winkler dedup
    // folds near-duplicates (the same behavior flagged across files) into one node.
    const { graph, mergedCount, addedCount } = buildGraphFromHypotheses(
      auditId ?? "audit_unknown",
      hypotheses,
    );
    log.writeLog("graph.json", graph.serialize());
    console.log(
      `[pipeline] hypothesis graph: ${addedCount} unique node(s), ${mergedCount} merged`,
    );
    emit?.("graph_built", {
      nodeCount: graph.size,
      addedCount,
      mergedCount,
    });

    // Orchestrator — resolve every hypothesis by running its experiment under
    // observation and judging the timeline; the resolved graph yields the verdict.
    emit?.("phase_started", { phase: "orchestrator" });
    const orchStart = Date.now();
    const orchSummary = await runOrchestrator(graph, {
      packagePath: resolved.path,
      artifactStore,
      log,
      emit,
      statedPurpose: intent.statedPurpose,
      globalBudgetMs: 10 * 60_000 * timeoutScale,
    });
    const orchDuration = Date.now() - orchStart;
    emit?.("phase_completed", { phase: "orchestrator", durationMs: orchDuration });
    trace.push({
      phase: "orchestrator",
      durationMs: orchDuration,
      input: { hypotheses: graph.size },
      output: { ...orchSummary },
    });
    log.writeLog("graph-final.json", graph.serialize());

    // A CONFIRMED hypothesis is proven malice → DANGEROUS, and that wins over
    // everything (deriveGraphVerdict returns it below). Only when NOTHING is
    // confirmed does a DEFERRED node block the verdict: a suspicion whose run or
    // judge could not complete means we cannot clear the package as SAFE, so the
    // audit is a retryable ERROR — no verdict over an untested suspicion. But a
    // flaky run on an unrelated hypothesis must never suppress a proven threat.
    const confirmedCount = graph.filterByState("CONFIRMED").length;
    const deferred = graph.filterByState("DEFERRED");
    if (confirmedCount === 0 && deferred.length > 0) {
      throw new AuditIncompleteError(
        "orchestrator",
        `${deferred.length} hypothes${deferred.length === 1 ? "is" : "es"} could not be evaluated (and none confirmed): ` +
          deferred.slice(0, 5).map((h) => `${h.hypId} (${h.resolution?.reason ?? "?"})`).join("; "),
      );
    }

    // Verdict is the pure function of the resolved graph. Only a CONFIRMED
    // hypothesis (dynamic RunArtifact) → DANGEROUS; else SAFE.
    const graphVerdict = deriveGraphVerdict(graph);
    console.log(`[pipeline] verdict: ${graphVerdict.verdict} — ${graphVerdict.rationale}`);
    log.writeLog("graph-verdict.json", graphVerdict);

    const report = buildReport(graphVerdict, graph, flagOutput.fileSummaries, trace);
    log.writeLog("report.json", report);
    console.log(`[pipeline] full logs saved to ${log.runDir}`);

    emitVerdict(emit, report);

    return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
  } catch (err) {
    cleanupPackage(resolved);
    throw err;
  }
}
