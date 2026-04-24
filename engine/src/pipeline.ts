import { SOURCE_FILE_TYPES } from "./config.js";
import { Proof, type AuditReport, type FileVerdict, type PhaseLog, type TriageResult } from "./models.js";
import type { Hypothesis, HypothesisSeverity } from "@npmguard/shared";
import { resolvePackage, cleanupPackage } from "./phases/resolve.js";
import { analyzeInventory } from "./phases/inventory.js";
import { extractIntent } from "./phases/intent-extraction.js";
import { runTriage, type FileSummary } from "./phases/triage.js";
import { buildGraphFromHypotheses } from "./orchestrator/build-graph.js";
import { deriveGraphVerdict } from "./orchestrator/verdict.js";
import { investigate } from "./phases/investigate.js";
import { generateTests } from "./phases/test-gen.js";
import { verifyProofs } from "./phases/verify.js";
import { startAuditLog, type AuditLogger } from "./audit-log.js";
import type { EmitFn } from "./events.js";
import { setSessionPackagePath, setSessionCleanup } from "./events.js";

// ---------------------------------------------------------------------------
// Legacy-shape adapters (transitional — Phase B orchestrator will replace)
// ---------------------------------------------------------------------------

const SEVERITY_TO_SCORE: Record<HypothesisSeverity, number> = {
  low: 3,
  medium: 6,
  high: 8,
  critical: 10,
};

/**
 * The old pipeline gates investigation on a 0-10 riskScore. The new triage
 * emits Hypothesis[] directly. For the interim, collapse the hypothesis
 * list into a synthetic TriageResult so investigate/test-gen/verify can
 * keep running. This adapter goes away when the orchestrator lands.
 */
function synthesizeTriageResult(hypotheses: Hypothesis[]): TriageResult {
  if (hypotheses.length === 0) {
    return { riskScore: 0, riskSummary: "No hypotheses emitted during triage.", focusAreas: [] };
  }

  const maxScore = hypotheses.reduce(
    (m, h) => Math.max(m, SEVERITY_TO_SCORE[h.severity]),
    0,
  );

  const top = hypotheses.slice(0, 3).map((h) => h.description).join(" | ");
  const riskSummary = `${hypotheses.length} hypothes${hypotheses.length === 1 ? "is" : "es"} from triage: ${top}`;

  const focusAreas = hypotheses.flatMap((h) =>
    h.focusLines.map((fl) => ({
      file: fl.file,
      lines: fl.range,
      reason: h.description,
    })),
  );

  return { riskScore: maxScore, riskSummary, focusAreas };
}

/**
 * Reconstruct per-file FileVerdict records from the new triage output so
 * the existing `file_verdict` SSE event and frontend code-viewer continue
 * to work. Phase B will replace the SSE vocabulary with hypothesis events.
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
        .join(",") || null;

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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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

export interface AuditResult {
  report: AuditReport;
  packagePath: string;
  cleanup: () => void;
}

export async function runAudit(packageName: string, emit?: EmitFn, auditId?: string, version?: string): Promise<AuditResult> {
  console.log(`[pipeline] starting audit for ${packageName}${version ? `@${version}` : ""}`);
  const log = startAuditLog(packageName);
  const trace: PhaseLog[] = [];

  emit?.("audit_started", { packageName });

  // Phase 0a: Resolve package
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
    // Phase 0b: Inventory
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

    // Scale phase timeouts by file count: base timeout for ≤20 files,
    // +50% per 20 extra files, clamped at 4× base.
    const sourceFileCount = inventory.files.filter(
      (f) => SOURCE_FILE_TYPES.has(f.fileType) && !f.isBinary,
    ).length;
    const timeoutScale = Math.min(
      4,
      1 + Math.max(0, sourceFileCount - 20) * 0.025,
    );
    console.log(
      `[pipeline] ${sourceFileCount} source files → timeout scale ${timeoutScale.toFixed(2)}×`,
    );

    // Dealbreaker -> immediate DANGEROUS
    if (inventory.dealbreaker) {
      const report: AuditReport = {
        verdict: "DANGEROUS",
        capabilities: [],
        proofs: [Proof.parse({
          confidence: "CONFIRMED",
          fileLine: "",
          problem: inventory.dealbreaker.detail,
          evidence: `Dealbreaker: ${inventory.dealbreaker.check}`,
          kind: "STRUCTURAL",
          reproducible: true,
        })],
        triage: null,
        findings: [],
        trace,
      };
      emit?.("verdict_reached", { verdict: report.verdict, capabilities: [], proofCount: report.proofs.length });
      return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
    }

    // Phase 1a: Intent extraction — derives the stated-purpose baseline
    // that MAP uses to reason about capability mismatch.
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

    // Phase 1b: Triage — per-file MAP emits Hypothesis[] directly.
    const { result: triageOutput, log: triageLog } = await timedPhase(
      "triage",
      () => runTriage(resolved.path, inventory, intent, emit),
      2 * 60_000 * timeoutScale,
      {
        sourceFiles: inventory.files
          .filter((f) => SOURCE_FILE_TYPES.has(f.fileType) && !f.isBinary)
          .map((f) => ({ path: f.path, sizeBytes: f.sizeBytes })),
        flagCount: inventory.flags.length,
        packageName: inventory.metadata.name,
      },
      (t) => ({
        hypothesisCount: t.hypotheses.length,
        hypotheses: t.hypotheses.map((h) => ({
          hypId: h.hypId,
          claim: h.claim.kind,
          severity: h.severity,
          description: h.description,
          focusLines: h.focusLines,
        })),
        fileSummaries: t.fileSummaries,
      }),
      emit,
    );
    trace.push(triageLog);
    log.writeLog("triage.json", triageOutput);

    const triage = synthesizeTriageResult(triageOutput.hypotheses);
    emitLegacyFileVerdicts(
      triageOutput.fileSummaries,
      triageOutput.hypotheses,
      emit,
    );

    emit?.("triage_complete", {
      riskScore: triage.riskScore,
      riskSummary: triage.riskSummary,
      focusAreas: triage.focusAreas,
    });

    // Phase 1c: Build hypothesis graph from triage output. Jaro-Winkler dedup
    // folds near-duplicate hypotheses emitted across files into a single node.
    // No workers yet — every node stays OPEN until Phase B orchestration.
    const { graph, mergedCount, addedCount } = buildGraphFromHypotheses(
      auditId ?? "audit_unknown",
      triageOutput.hypotheses,
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

    if (triageOutput.hypotheses.length === 0) {
      console.log(`[pipeline] no hypotheses from triage — returning SAFE`);
      const report: AuditReport = {
        verdict: "SAFE",
        capabilities: [],
        proofs: [],
        triage,
        findings: [],
        trace,
      };
      emit?.("verdict_reached", { verdict: "SAFE", capabilities: [], proofCount: 0 });
      return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
    }

    // Phase 1c: Investigation (transitional — will be split into worker
    // agents dispatched from the hypothesis graph in Phase B).
    const { result: investigationResult, log: investigateLog } = await timedPhase(
      "investigation",
      () => investigate(resolved.path, inventory, triage, triageOutput.fileSummaries, emit, log),
      5 * 60_000 * timeoutScale,
      {
        riskScore: triage.riskScore,
        focusAreas: triage.focusAreas,
        packagePath: resolved.path,
      },
      (inv) => ({
        capabilityCount: inv.capabilities.length,
        capabilities: inv.capabilities,
        findingCount: inv.findings.length,
        findings: inv.findings.map((f) => ({
          capability: f.capability,
          confidence: f.confidence,
          fileLine: f.fileLine,
          problem: f.problem,
        })),
        proofCount: inv.proofs.length,
        toolCalls: inv.toolCalls.map((tc) => ({
          tool: tc.tool,
          args: tc.args,
          resultPreview: tc.resultPreview,
          timestamp: tc.timestamp,
          injectionDetected: tc.injectionDetected,
        })),
        agentText: inv.agentText.slice(0, 2000),
      }),
      emit,
    );
    trace.push(investigateLog);
    log.writeLog("investigation.json", investigationResult);

    // Phase 1c: Test generation
    const { result: proofs, log: testGenLog } = await timedPhase(
      "test-gen",
      () => generateTests(investigationResult, resolved.path),
      5 * 60_000 * timeoutScale,
      { proofCount: investigationResult.proofs.length, findingCount: investigationResult.findings.length },
      (p) => ({
        proofCount: p.length,
        withTests: p.filter((x) => x.testFile).length,
      }),
      emit,
    );
    trace.push(testGenLog);

    // Phase 2: Proof verification (with retry loop — up to 3 attempts per failed test)
    const { result: verifiedProofs, log: verifyLog } = await timedPhase(
      "verify",
      () => verifyProofs(proofs, resolved.path, emit, investigationResult.findings),
      8 * 60_000 * timeoutScale,
      { proofCount: proofs.length, withTests: proofs.filter((x) => x.testFile).length },
      (p) => ({
        verifiedCount: p.length,
        confirmed: p.filter((x) => x.kind === "TEST_CONFIRMED").length,
        unconfirmed: p.filter((x) => x.kind === "TEST_UNCONFIRMED").length,
      }),
      emit,
    );
    trace.push(verifyLog);

    const verdict = verifiedProofs.length > 0 ? "DANGEROUS" : "SAFE";
    console.log(`[pipeline] verdict: ${verdict} (${verifiedProofs.length} proofs)`);

    // Graph-derived verdict is logged for observability; it will replace the
    // 2-state AuditReport.verdict once worker dispatch lands and the graph
    // actually contains terminal states (currently every node stays OPEN).
    const graphVerdict = deriveGraphVerdict(graph);
    console.log(
      `[pipeline] graph verdict: ${graphVerdict.verdict} — ${graphVerdict.rationale}`,
    );
    log.writeLog("graph-verdict.json", graphVerdict);
    emit?.("graph_verdict", { ...graphVerdict });

    const report: AuditReport = {
      verdict,
      capabilities: investigationResult.capabilities,
      proofs: verifiedProofs,
      triage,
      findings: investigationResult.findings,
      trace,
    };
    log.writeLog("report.json", report);
    console.log(`[pipeline] full logs saved to ${log.runDir}`);

    emit?.("verdict_reached", {
      verdict: report.verdict,
      capabilities: report.capabilities,
      proofCount: report.proofs.length,
    });

    return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
  } catch (err) {
    cleanupPackage(resolved);
    throw err;
  }
}
