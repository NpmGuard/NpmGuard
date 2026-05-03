import { config, SOURCE_FILE_TYPES } from "./config.js";
import { Proof, type AuditReport, type PhaseLog } from "./models.js";
import { resolvePackage, cleanupPackage } from "./phases/resolve.js";
import { analyzeInventory } from "./phases/inventory.js";
import { runTriage } from "./phases/triage.js";
import { investigate } from "./phases/investigate.js";
import { generateTests } from "./phases/test-gen.js";
import { verifyProofs } from "./phases/verify.js";
import { aggregateFromResultPreviews } from "./sandbox/parse-trace.js";
import { startAuditLog, type AuditLogger } from "./audit-log.js";
import type { EmitFn } from "./events.js";
import { setSessionPackagePath, setSessionCleanup } from "./events.js";

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
        runtimeEvidence: null,
      };
      emit?.("verdict_reached", { verdict: report.verdict, capabilities: [], proofCount: report.proofs.length });
      return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
    }

    // Phase 1a: Triage
    // Base timeout = 5 min so that an unusually slow LLM provider (rate
    // limit, model cold start, transient OpenRouter latency spike) doesn't
    // kill an audit that would otherwise complete. The map step runs all
    // source files in parallel, so the wall-clock cost grows with the
    // slowest single LLM call, not with the file count.
    const { result: triageOutput, log: triageLog } = await timedPhase(
      "triage",
      () => runTriage(resolved.path, inventory, emit),
      5 * 60_000 * timeoutScale,
      {
        sourceFiles: inventory.files
          .filter((f) => SOURCE_FILE_TYPES.has(f.fileType) && !f.isBinary)
          .map((f) => ({ path: f.path, sizeBytes: f.sizeBytes })),
        flagCount: inventory.flags.length,
        packageName: inventory.metadata.name,
      },
      (t) => ({
        riskScore: t.result.riskScore,
        riskSummary: t.result.riskSummary,
        focusAreas: t.result.focusAreas,
        fileVerdicts: t.fileVerdicts,
      }),
      emit,
    );
    trace.push(triageLog);
    log.writeLog("triage.json", triageOutput);
    const triage = triageOutput.result;

    // Emit triage complete for frontend
    emit?.("triage_complete", {
      riskScore: triage.riskScore,
      riskSummary: triage.riskSummary,
      focusAreas: triage.focusAreas,
    });

    if (triage.riskScore < config.triageRiskThreshold) {
      console.log(`[pipeline] low risk (${triage.riskScore}) — returning SAFE`);
      const report: AuditReport = {
        verdict: "SAFE",
        capabilities: [],
        proofs: [],
        triage,
        findings: [],
        trace,
        runtimeEvidence: null,
      };
      emit?.("verdict_reached", { verdict: "SAFE", capabilities: [], proofCount: 0 });
      return { report, packagePath: resolved.path, cleanup: () => cleanupPackage(resolved) };
    }

    // Phase 1b: Investigation
    // 15 min so MiniMax (slower, more thorough — typically 25-30 agent steps)
    // can complete on heavily-obfuscated targets like Shai-Hulud worm samples.
    const { result: investigationResult, log: investigateLog } = await timedPhase(
      "investigation",
      () => investigate(resolved.path, inventory, triage, triageOutput.fileVerdicts, emit, log),
      15 * 60_000 * timeoutScale,
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
    log.writeLog("test_gen.json", proofs.map((p) => ({
      capability: p.capability,
      fileLine: p.fileLine,
      problem: p.problem,
      kind: p.kind,
      testFile: p.testFile,
      testCode: p.testCode,
    })));

    // Phase 2: Proof verification (with retry loop — up to 3 attempts per failed test)
    const { result: verifiedProofs, log: verifyLog } = await timedPhase(
      "verify",
      () => verifyProofs(proofs, resolved.path, emit, investigationResult.findings),
      // 15 min so 3 retries × N findings can complete. v2 logs showed we hit
      // 480000ms with 4 findings + 3 retries each (a 2-stage worm).
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
    log.writeLog("verify.json", verifiedProofs.map((p) => ({
      capability: p.capability,
      fileLine: p.fileLine,
      problem: p.problem,
      kind: p.kind,
      testFile: p.testFile,
      testCode: p.testCode,
      verifyError: p.verifyError,
    })));

    const verdict = verifiedProofs.length > 0 ? "DANGEROUS" : "SAFE";
    console.log(`[pipeline] verdict: ${verdict} (${verifiedProofs.length} proofs)`);

    // Aggregate runtime evidence captured by the agent's sandbox tools
    // (requireAndTrace / runLifecycleHook / fastForwardTimers). These emit
    // INSTRUMENTATION_JS traces that land in each toolCall's resultPreview.
    const runtimeEvidence = aggregateFromResultPreviews(
      investigationResult.toolCalls.map((tc) => tc.resultPreview),
    );

    const report: AuditReport = {
      verdict,
      capabilities: investigationResult.capabilities,
      proofs: verifiedProofs,
      triage,
      findings: investigationResult.findings,
      trace,
      runtimeEvidence,
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
