import { config, SOURCE_FILE_TYPES } from "./config.js";
import { CapabilityEnum, Finding, Proof, type AuditReport, type FileVerdict, type PhaseLog } from "./models.js";
import type { ClaimKind, Hypothesis, HypothesisSeverity } from "@npmguard/shared";
import { resolvePackage, cleanupPackage } from "./phases/resolve.js";
import { analyzeInventory } from "./phases/inventory.js";
import { extractIntent, fallbackIntent, type PackageIntent } from "./phases/intent-extraction.js";
import { runTriage, type FileSummary } from "./phases/triage.js";
import { buildGraphFromHypotheses } from "./orchestrator/build-graph.js";
import { deriveGraphVerdict } from "./orchestrator/verdict.js";
import {
  correlateAfterInvestigation,
  correlateAfterVerify,
  proofCandidateFindingIndexes,
} from "./orchestrator/correlate.js";
import { runExperiment } from "./orchestrator/experimenter.js";
import { investigate, type InvestigationResult } from "./phases/investigate.js";
import { generateTests } from "./phases/test-gen.js";
import { verifyProofs } from "./phases/verify.js";
import { startAuditLog, type AuditLogger } from "./audit-log.js";
import { ArtifactStore } from "./evidence/artifact-store.js";
import type { EmitFn } from "./events.js";
import { setSessionPackagePath, setSessionCleanup } from "./events.js";

function hasRunArtifactEvidence(refs: readonly { kind: string; id: string }[]): boolean {
  return refs.some((ref) => ref.kind === "run" && ref.id.startsWith("run_"));
}

// ---------------------------------------------------------------------------
// Legacy file_verdict SSE adapter (kept for frontend code-viewer compat)
// ---------------------------------------------------------------------------

const SEVERITY_TO_SCORE: Record<HypothesisSeverity, number> = {
  low: 3,
  medium: 6,
  high: 8,
  critical: 10,
};

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

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isTimeoutError(err: unknown, phase: string): boolean {
  return err instanceof Error && err.message.startsWith(`${phase} timed out after `);
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateTriageTimeoutMs(sourceFileCount: number, timeoutScale: number): number {
  const selectedFileCount = Math.min(sourceFileCount, config.triageMaxFiles);
  const concurrency = Math.max(1, Math.floor(readPositiveNumber(process.env.NPMGUARD_TRIAGE_CONCURRENCY, 8)));
  const waves = Math.max(1, Math.ceil(selectedFileCount / concurrency));
  const perFileBudgetMs = config.llmTimeoutSeconds * 1000 + 10_000;
  const dynamicBudgetMs = waves * perFileBudgetMs + 60_000;
  return Math.max(5 * 60_000 * timeoutScale, dynamicBudgetMs);
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

const PARTIAL_CAPABILITY_BY_CLAIM: Record<ClaimKind, CapabilityEnum> = {
  env_exfil: "ENV_VARS",
  cred_theft: "CREDENTIAL_THEFT",
  binary_drop: "BINARY_DOWNLOAD",
  obfuscation: "OBFUSCATION",
  persistence: "FILESYSTEM",
  destructive: "FILESYSTEM",
  propagation: "WORM_PROPAGATION",
  dos_loop: "DOS_LOOP",
  clipboard_hijack: "CLIPBOARD_HIJACK",
  dom_inject: "DOM_INJECT",
  telemetry: "TELEMETRY_RAT",
  dns_exfil: "DNS_EXFIL",
  build_plugin_exfil: "BUILD_PLUGIN_EXFIL",
};

const PARTIAL_SEVERITY_SCORE: Record<HypothesisSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function buildPartialInvestigationResult(
  hypotheses: readonly Hypothesis[],
  reason: string,
): InvestigationResult {
  const strong = hypotheses.filter((h) => h.severity === "high" || h.severity === "critical");
  const selected = (strong.length > 0 ? strong : [...hypotheses])
    .sort((a, b) => PARTIAL_SEVERITY_SCORE[b.severity] - PARTIAL_SEVERITY_SCORE[a.severity])
    .slice(0, 8);

  const capabilities = new Set<CapabilityEnum>();
  const findings: Finding[] = selected.map((h) => {
    const cap = PARTIAL_CAPABILITY_BY_CLAIM[h.claim.kind];
    capabilities.add(cap);
    const focus = h.focusLines[0]
      ? `${h.focusLines[0].file}:${h.focusLines[0].range}`
      : h.focusFiles[0] ?? "";
    return {
      capability: cap,
      confidence: h.severity === "critical" || h.severity === "high" ? "LIKELY" : "SUSPECTED",
      fileLine: focus,
      problem: h.description,
      evidence:
        `${reason}. Preserved from triage hypothesis ${h.hypId} ` +
        `(${h.claim.kind}/${h.severity}) so the audit keeps a usable partial signal.`,
      reproductionStrategy: `Resume dynamic investigation from ${h.focusFiles.join(", ") || "the package entrypoint"}.`,
    };
  });

  const proofs = findings.map((finding) => ({
    capability: CapabilityEnum.parse(finding.capability),
    attackPathway: "",
    confidence: finding.confidence,
    fileLine: finding.fileLine,
    problem: finding.problem,
    evidence: finding.evidence.slice(0, 500),
    kind: "AI_STATIC" as const,
    contentHash: null,
    reproducible: false,
    reproductionCmd: null,
    testFile: null,
    testHash: null,
    testCode: null,
    verifyError: reason,
    reasoningHash: null,
    teeAttestationId: null,
  }));

  return {
    capabilities: [...capabilities],
    proofs,
    findings,
    toolCalls: [],
    agentText: reason,
  };
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

    // Dealbreaker -> immediate DANGEROUS
    if (inventory.dealbreaker) {
      // Mirror the structural proof 1:1 as a Finding so frontend finding-list
      // components (which iterate `findings`, not `proofs`) render the threat
      // instead of an empty "appears safe to install" panel under a DANGEROUS
      // header. Use a broad structural capability — a dealbreaker can originate
      // from any script (shell-pipe, missing install file, etc.), so a specific
      // label like LIFECYCLE_HOOK would over-claim.
      const finding = Finding.parse({
        capability: "OBFUSCATION",
        confidence: "CONFIRMED",
        fileLine: "",
        problem: inventory.dealbreaker.detail,
        evidence: `Dealbreaker: ${inventory.dealbreaker.check}`,
      });
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
        findings: [finding],
        trace,
        runtimeEvidence: null,
      };
      emit?.("finding_discovered", { finding });
      emit?.("verdict_reached", { verdict: report.verdict, capabilities: [], proofCount: report.proofs.length });
      return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
    }

    // Phase 1a: Intent extraction — derives the stated-purpose baseline
    // that MAP uses to reason about capability mismatch.
    const intentInput = { packageName: inventory.metadata.name, description: inventory.metadata.description };
    const summarizeIntent = (i: PackageIntent) => ({
      statedPurpose: i.statedPurpose,
      expectedCapabilities: i.expectedCapabilities,
      rationale: i.rationale,
    });
    let intent: PackageIntent;
    let intentLog: PhaseLog;
    try {
      const timed = await timedPhase(
        "intent-extraction",
        () => extractIntent(resolved.path, inventory),
        60_000,
        intentInput,
        summarizeIntent,
        emit,
      );
      intent = timed.result;
      intentLog = timed.log;
    } catch (err) {
      if (!isTimeoutError(err, "intent-extraction")) throw err;
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[intent] ${message}; using fallback intent`);
      intent = fallbackIntent(inventory);
      intentLog = {
        phase: "intent-extraction",
        durationMs: 60_000,
        input: intentInput,
        output: {
          ...summarizeIntent(intent),
          fallback: true,
          error: message,
        },
      };
      emit?.("phase_completed", { phase: "intent-extraction", durationMs: 60_000 });
    }
    trace.push(intentLog);
    log.writeLog("intent.json", intent);
    emit?.("intent_extracted", {
      statedPurpose: intent.statedPurpose,
      expectedCapabilities: intent.expectedCapabilities,
    });

    // Phase 1b: Triage — per-file MAP emits Hypothesis[] directly.
    const triageTimeoutMs = estimateTriageTimeoutMs(sourceFileCount, timeoutScale);
    const { result: triageOutput, log: triageLog } = await timedPhase(
      "triage",
      () => runTriage(resolved.path, inventory, intent, emit),
      triageTimeoutMs,
      {
        sourceFiles: inventory.files
          .filter((f) => SOURCE_FILE_TYPES.has(f.fileType) && !f.isBinary)
          .map((f) => ({ path: f.path, sizeBytes: f.sizeBytes })),
        flagCount: inventory.flags.length,
        packageName: inventory.metadata.name,
        timeoutMs: triageTimeoutMs,
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

    emitLegacyFileVerdicts(
      triageOutput.fileSummaries,
      triageOutput.hypotheses,
      emit,
    );

    emit?.("triage_complete", {
      hypothesisCount: triageOutput.hypotheses.length,
      hypotheses: triageOutput.hypotheses.map((h) => ({
        hypId: h.hypId,
        claim: h.claim.kind,
        severity: h.severity,
        description: h.description,
      })),
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
        triage: null,
        findings: [],
        trace,
        runtimeEvidence: null,
      };
      emit?.("verdict_reached", { verdict: "SAFE", capabilities: [], proofCount: 0 });
      return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
    }

    // Phase 1c: Investigation — agentic LLM with read tools, given the
    // triage hypotheses as a starting list of suspicious sites to verify.
    let investigationResult: InvestigationResult;
    let investigateLog: PhaseLog;
    const investigationTimeoutMs = 5 * 60_000 * timeoutScale;
    try {
      const timed = await timedPhase(
        "investigation",
        () => investigate(resolved.path, inventory, triageOutput.hypotheses, triageOutput.fileSummaries, emit, log),
        investigationTimeoutMs,
        {
          hypothesisCount: triageOutput.hypotheses.length,
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
      investigationResult = timed.result;
      investigateLog = timed.log;
    } catch (err) {
      if (!isTimeoutError(err, "investigation")) throw err;
      const durationMs = investigationTimeoutMs;
      const reason = err instanceof Error ? err.message : "investigation timed out";
      console.warn(`[pipeline] ${reason}; preserving partial triage-derived findings`);
      investigationResult = buildPartialInvestigationResult(triageOutput.hypotheses, `PARTIAL_TIMEOUT: ${reason}`);
      investigateLog = {
        phase: "investigation",
        durationMs,
        input: {
          hypothesisCount: triageOutput.hypotheses.length,
          packagePath: resolved.path,
        },
        output: {
          partial: true,
          reason,
          capabilityCount: investigationResult.capabilities.length,
          capabilities: investigationResult.capabilities,
          findingCount: investigationResult.findings.length,
          proofCount: investigationResult.proofs.length,
        },
      };
      emit?.("phase_completed", { phase: "investigation", durationMs });
      emit?.("agent_reasoning", {
        text: `Investigation timed out; preserving ${investigationResult.findings.length} triage-derived partial findings.`,
        step: -1,
      });
    }
    trace.push(investigateLog);
    log.writeLog("investigation.json", investigationResult);

    // Correlate investigation findings → hypothesis graph transitions
    const invCorrelation = correlateAfterInvestigation(graph, investigationResult);
    log.writeLog("correlation-investigate.json", invCorrelation);
    console.log(
      `[pipeline] investigation→graph: ${invCorrelation.matched.length} matched, ${invCorrelation.promoted.length} promoted, ${invCorrelation.unmatched.length} unmatched findings`,
    );
    const proofFindingIndexes = proofCandidateFindingIndexes(invCorrelation);
    const proofInvestigation: InvestigationResult = {
      ...investigationResult,
      findings: investigationResult.findings.filter((_, index) =>
        proofFindingIndexes.has(index),
      ),
      proofs: investigationResult.proofs.filter((proof) =>
        investigationResult.findings.some((finding, index) =>
          proofFindingIndexes.has(index) &&
          finding.fileLine === proof.fileLine &&
          finding.capability === (proof.capability ?? ""),
        ),
      ),
    };
    if (invCorrelation.unmatched.length > 0) {
      console.log(
        `[pipeline] skipping test-gen for ${invCorrelation.unmatched.length} unmatched investigation finding(s)`,
      );
    }

    // Phase 1d: Experimenter — run dynamic observation for IN_PROGRESS hypotheses.
    // This is the first use of Phase A's runUnderObservation in the live pipeline.
    const experimentHyps = [
      ...graph.filterByState("IN_PROGRESS"),
      ...graph.filterByState("CONFIRMED").filter((h) =>
        !hasRunArtifactEvidence(h.evidenceRefs),
      ),
    ];
    if (experimentHyps.length > 0) {
      const mainEntry = inventory.entryPoints.runtime[0] ?? "index.js";
      console.log(
        `[pipeline] experimenter: running dynamic observation for ${experimentHyps.length} hypothes${experimentHyps.length === 1 ? "is" : "es"} lacking run evidence`,
      );
      emit?.("phase_started", { phase: "experimenter" });
      const expStart = Date.now();
      // Per-hypothesis cap (90s) prevents one stuck experiment from burning
      // the whole budget; global cap (10min × scale) bounds the loop overall.
      const PER_HYP_MS = 90_000;
      const GLOBAL_BUDGET_MS = 10 * 60_000 * timeoutScale;

      for (const h of experimentHyps) {
        if (Date.now() - expStart > GLOBAL_BUDGET_MS) {
          console.warn(
            `[experimenter] global budget ${GLOBAL_BUDGET_MS}ms exceeded — skipping remaining ${experimentHyps.length - experimentHyps.indexOf(h)} hypothes${experimentHyps.length - experimentHyps.indexOf(h) === 1 ? "is" : "es"}`,
          );
          break;
        }
        try {
          const result = await withTimeout(
            runExperiment(h, resolved.path, mainEntry, inventory.entryPoints.install),
            PER_HYP_MS,
            `experiment:${h.hypId}`,
          );
          if (result) {
            const { contentHash: artifactContentHash, ...artifactWithoutHash } = result.artifact;
            const artifactHash = artifactStore.writeArtifact(artifactWithoutHash);
            if (artifactHash !== artifactContentHash) {
              console.warn(
                `[experimenter] artifact hash mismatch for ${result.artifact.runId}: ` +
                  `artifact=${artifactContentHash} store=${artifactHash}`,
              );
            }

            if (result.confirmed) {
              graph.addEvidence(h.hypId, [result.evidenceRef]);
              if (h.state !== "CONFIRMED") {
                graph.transition(h.hypId, {
                  to: "CONFIRMED",
                  by: "worker:experimenter",
                  evidenceRefs: [result.evidenceRef],
                });
              }
              emit?.("experiment_confirmed", { hypId: h.hypId, reason: result.reason });
            }
            log.writeLog(`experiment-${h.hypId}.json`, {
              hypId: h.hypId,
              confirmed: result.confirmed,
              reason: result.reason,
              runId: result.artifact.runId,
              artifactHash,
              evidenceRef: result.evidenceRef,
              wallMs: result.artifact.wallMs,
              eventCount: result.artifact.events.length,
              eventSummary: result.artifact.eventSummary,
              error: result.artifact.error,
            });
          }
        } catch (err) {
          console.error(
            `[experimenter] ${h.hypId} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      const expDuration = Date.now() - expStart;
      console.log(`[pipeline] experimenter completed in ${expDuration}ms`);
      emit?.("phase_completed", { phase: "experimenter", durationMs: expDuration });
      trace.push({ phase: "experimenter", durationMs: expDuration, input: { hypotheses: experimentHyps.length }, output: {} });
    }

    // Phase 1e: Test generation
    const { result: proofs, log: testGenLog } = await timedPhase(
      "test-gen",
      () => generateTests(proofInvestigation, resolved.path),
      5 * 60_000 * timeoutScale,
      { proofCount: proofInvestigation.proofs.length, findingCount: proofInvestigation.findings.length },
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
      () => verifyProofs(proofs, resolved.path, emit, proofInvestigation.findings),
      15 * 60_000 * timeoutScale,
      { proofCount: proofs.length, withTests: proofs.filter((x) => x.testFile).length },
      (p) => ({
        verifiedCount: p.length,
        confirmed: p.filter((x) => x.kind === "TEST_CONFIRMED").length,
        unconfirmed: p.filter((x) => x.kind === "TEST_UNCONFIRMED").length,
      }),
      emit,
    );
    trace.push(verifyLog);

    // Correlate verified proofs → hypothesis graph terminal transitions
    const verifyCorrelation = correlateAfterVerify(
      graph,
      verifiedProofs,
      proofInvestigation.findings,
    );
    log.writeLog("correlation-verify.json", verifyCorrelation);
    console.log(
      `[pipeline] verify→graph: ${verifyCorrelation.confirmed.length} confirmed, ${verifyCorrelation.inconclusive.length} inconclusive`,
    );

    // Persist final graph state
    log.writeLog("graph-final.json", graph.serialize());

    // Graph-derived verdict is authoritative. Until AuditReport/CLI/frontend
    // grow the richer 4-state vocabulary, keep the public 2-state mapping
    // conservative: only graph SAFE with no confirmed proof maps to SAFE.
    // SUSPECT/UNKNOWN become DANGEROUS so the CLI warns instead of silently
    // installing an under-investigated package.
    //
    const graphVerdict = deriveGraphVerdict(graph);
    const hasConfirmedProof = verifiedProofs.some((p) => p.kind === "TEST_CONFIRMED");
    const verdict =
      graphVerdict.verdict === "SAFE" && !hasConfirmedProof
        ? "SAFE"
        : "DANGEROUS";
    console.log(
      `[pipeline] graph verdict: ${graphVerdict.verdict} → report verdict: ${verdict} — ${graphVerdict.rationale}`,
    );
    log.writeLog("graph-verdict.json", graphVerdict);
    emit?.("graph_verdict", { ...graphVerdict });

    const report: AuditReport = {
      verdict,
      capabilities: investigationResult.capabilities,
      proofs: verifiedProofs,
      triage: null,
      findings: investigationResult.findings,
      trace,
      runtimeEvidence: null,
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
