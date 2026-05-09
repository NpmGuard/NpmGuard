import { config } from "../config.js";
import { CapabilityEnum, type Finding, type InstrumentationLog, type InvestigationInput, type InventoryReport, type Proof, type ToolCallRecord } from "../models.js";
import type { Hypothesis } from "@npmguard/shared";
import { DockerSandboxController } from "../sandbox/controller.js";
import { runInvestigationAgent } from "../investigation/agent.js";
import { requireAndTraceImpl, runLifecycleHookImpl } from "../investigation/tools-execute.js";
import { aggregateFromResultPreviews } from "../sandbox/parse-trace.js";
import { LIFECYCLE_SCRIPTS } from "../inventory/parse-manifest.js";
import type { EmitFn } from "../events.js";
import type { AuditLogger } from "../audit-log.js";
import type { FileSummary } from "./triage.js";

/**
 * Run the package once under instrumentation BEFORE the LLM agent starts.
 * Captures network/eval/fs/env/process events so the agent has runtime
 * evidence in its prompt — avoids the chunked-evalJs grind on obfuscated
 * bundles. Best-effort: failures are logged and observation is left null.
 */
async function collectEarlyObservation(
  sandbox: DockerSandboxController,
  mainEntry: string | null,
  lifecycleHooks: Record<string, string>,
): Promise<InstrumentationLog | null> {
  const previews: string[] = [];

  if (mainEntry) {
    try {
      console.log(`[investigate] early observation: require ${mainEntry}`);
      previews.push(await requireAndTraceImpl(sandbox, mainEntry));
    } catch (err) {
      console.warn(
        `[investigate] early observation: require ${mainEntry} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const hookName of Object.keys(lifecycleHooks)) {
    try {
      console.log(`[investigate] early observation: lifecycle ${hookName}`);
      previews.push(await runLifecycleHookImpl(sandbox, hookName, lifecycleHooks));
    } catch (err) {
      console.warn(
        `[investigate] early observation: lifecycle ${hookName} failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return aggregateFromResultPreviews(previews);
}

export interface InvestigationResult {
  capabilities: CapabilityEnum[];
  proofs: Proof[];
  findings: Finding[];
  toolCalls: ToolCallRecord[];
  agentText: string;
}

export async function investigate(
  packagePath: string,
  inventory: InventoryReport,
  hypotheses: Hypothesis[],
  fileSummaries: FileSummary[],
  emit?: EmitFn,
  log?: AuditLogger,
): Promise<InvestigationResult> {
  if (!config.investigationEnabled) {
    console.log("[investigate] skipped — investigation disabled");
    return { capabilities: [], proofs: [], findings: [], toolCalls: [], agentText: "" };
  }

  // Build investigation input
  const lifecycleHooks: Record<string, string> = {};
  for (const [key, value] of Object.entries(inventory.scripts)) {
    if (LIFECYCLE_SCRIPTS.has(key)) lifecycleHooks[key] = value;
  }

  // Collect capabilities across all files from triage
  const allCaps = new Set<string>();
  for (const fs of fileSummaries) {
    for (const cap of fs.capabilities) allCaps.add(cap);
  }

  const staticProofSummaries = hypotheses.flatMap((h) =>
    h.focusLines.map((fl) => `${fl.file}:${fl.range} [${h.claim.kind}/${h.severity}]: ${h.description}`),
  );

  // Start sandbox
  const sandbox = new DockerSandboxController(
    config.sandboxImage,
    `${config.sandboxMemoryMb}m`,
    config.sandboxCpus,
    config.sandboxNetwork,
  );

  try {
    await sandbox.start(packagePath);

    // Early observation: run main entry + lifecycle hooks under instrumentation
    // BEFORE the agent. Gives it runtime evidence to ground static analysis on
    // (esp. obfuscated packages where the agent otherwise grinds chunked-evalJs
    // through 10MB minified bundles to rediscover what the runtime already showed).
    const mainEntry = inventory.entryPoints.runtime[0] ?? null;
    const runtimeObservation = await collectEarlyObservation(sandbox, mainEntry, lifecycleHooks);
    if (runtimeObservation) {
      const counts = {
        network: runtimeObservation.networkCalls.length,
        eval: runtimeObservation.evalCalls.length,
        fs: runtimeObservation.fsOperations.length,
        env: runtimeObservation.envAccess.length,
        spawn: runtimeObservation.processSpawns.length,
        modules: runtimeObservation.modulesLoaded.length,
      };
      console.log(`[investigate] early observation captured: ${JSON.stringify(counts)}`);
      log?.writeLog("early-observation.json", runtimeObservation);
    } else {
      console.log("[investigate] early observation produced no events");
    }

    const input: InvestigationInput = {
      packagePath,
      packageName: inventory.metadata.name ?? "",
      version: inventory.metadata.version ?? "",
      description: inventory.metadata.description ?? "",
      flags: inventory.flags.map((f) => `[${f.severity}] ${f.check}: ${f.detail}`),
      staticCaps: [...allCaps],
      staticProofSummaries,
      runtimeObservation,
    };

    const output = await runInvestigationAgent(input, sandbox, lifecycleHooks, emit, log);

    // Emit findings for frontend visualization
    for (const finding of output.findings) {
      emit?.("finding_discovered", { finding });
    }

    // Convert findings to proofs
    const capabilities = new Set<CapabilityEnum>();
    const proofs: Proof[] = [];

    for (const finding of output.findings) {
      const capParsed = CapabilityEnum.safeParse(finding.capability);
      // Safety net: LLMs sometimes invent labels ("CRYPTO_THEFT", "SECRET_LEAK")
      // outside the strict enum. Without this, capability ends up null and the
      // verdict logic ignores otherwise-valid TEST_CONFIRMED proofs.
      let cap = capParsed.success ? capParsed.data : null;
      if (!cap && finding.capability) {
        const raw = finding.capability.toUpperCase();
        if (raw.includes("CREDENTIAL") || raw.includes("SECRET") || raw.includes("TOKEN")) cap = "CREDENTIAL_THEFT";
        else if (raw.includes("EXFIL") || raw.includes("EXPORT")) cap = "DATA_EXFILTRATION";
        else if (raw.includes("ENV")) cap = "ENV_VARS";
        else if (raw.includes("PROC") || raw.includes("SPAWN") || raw.includes("EXEC")) cap = "PROCESS_SPAWN";
        else if (raw.includes("FILE") || raw.includes("FS") || raw.includes("DISK")) cap = "FILESYSTEM";
        else if (raw.includes("EVAL") || raw.includes("FUNCTION_CONSTRUCTOR")) cap = "EVAL";
        else if (raw.includes("OBFUSC") || raw.includes("PACK") || raw.includes("MINIF")) cap = "OBFUSCATION";
        else if (raw.includes("LIFECYCLE") || raw.includes("POSTINSTALL") || raw.includes("PREINSTALL")) cap = "LIFECYCLE_HOOK";
        else if (raw.includes("NETWORK") || raw.includes("HTTP") || raw.includes("FETCH")) cap = "NETWORK";
        if (cap) console.log(`[investigate] normalized "${finding.capability}" → ${cap}`);
      }
      if (cap) capabilities.add(cap);

      proofs.push({
        capability: cap,
        attackPathway: "",
        confidence: finding.confidence,
        fileLine: finding.fileLine,
        problem: finding.problem,
        evidence: finding.evidence.slice(0, 500),
        kind: finding.confidence === "CONFIRMED" ? "AI_DYNAMIC" : "AI_STATIC",
        contentHash: null,
        reproducible: finding.confidence === "CONFIRMED",
        reproductionCmd: null,
        testFile: null,
        testHash: null,
        testCode: null,
        verifyError: null,
        reasoningHash: null,
        teeAttestationId: null,
      });
    }

    return {
      capabilities: [...capabilities],
      proofs,
      findings: output.findings,
      toolCalls: output.toolCalls,
      agentText: output.agentText,
    };
  } finally {
    await sandbox.stop();
  }
}
