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
import { CLAIM_TO_CAPABILITIES, normalizeCapabilityLabel } from "../orchestrator/correlate.js";

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

const BENIGN_FINDING_PATTERNS = [
  /\bnot (?:a )?security (?:issue|risk|problem)\b/,
  /\bnot security[- ]sensitive\b/,
  /\bperformance concern,? not security\b/,
  /\btype(?:s)? only\b/,
  /\btype-only\b/,
  /\bstandard typescript declaration\b/,
  /\blegitimate (?:library )?(?:feature|use|usage|behavior|code|documentation)\b/,
  /\bintentional feature detection\b/,
  /\bcontrolled and gated\b/,
  /\bsafe recursive traversal\b/,
  /\bzero (?:http|https|network|fetch)\b/,
];

const ABSENCE_PROBLEM_PATTERN =
  /^(?:no|none)\b.*\b(?:present|observed|detected|mechanisms?|operations?|calls?|requests?|hooks?|network|credential|theft|obfuscation|payloads?|eval|filesystem|spawn|exfiltration)\b/;

const BENIGN_SUMMARY_PATTERNS = [
  /\bno malicious behavior\b/,
  /\bno suspicious behavior\b/,
  /\bno evidence of (?:malicious|suspicious)\b/,
  /\bfalse positives?\b/,
  /\bbenign\b/,
  /\bsafe\b/,
];

const MALICIOUS_SUMMARY_PATTERNS = [
  /\bconfirmed malicious\b/,
  /\bmalicious\b/,
  /\bmalware\b/,
  /\btrojan\b/,
  /\bcredential theft\b/,
  /\bsteals?\b.*\b(?:credentials?|secrets?|tokens?|environment variables?)\b/,
  /\bexfiltrat(?:e|es|ion|ing)\b/,
  /\bself-propagat(?:e|es|ion|ing)\b/,
  /\bworm\b/,
  /\bshai-hulud\b/,
];

export function isBenignFinding(finding: Finding): boolean {
  const problem = finding.problem.trim().toLowerCase();
  const text = [
    finding.problem,
    finding.evidence,
    finding.reproductionStrategy,
  ].join(" ").toLowerCase();

  if (finding.capability === "CLEAN") return true;
  if (ABSENCE_PROBLEM_PATTERN.test(problem)) return true;
  return BENIGN_FINDING_PATTERNS.some((pattern) => pattern.test(text));
}

export function filterActionableFindings(findings: Finding[]): Finding[] {
  return findings.filter((finding) => !isBenignFinding(finding));
}

export function isBenignInvestigationSummary(summary: string): boolean {
  const text = summary.trim().toLowerCase();
  return BENIGN_SUMMARY_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildAgentTextFallbackFinding(
  summary: string,
  agentText: string,
  hypotheses: readonly Hypothesis[],
): Finding | null {
  const text = `${summary}\n${agentText}`.trim();
  const lower = text.toLowerCase();
  if (!text || isBenignInvestigationSummary(text)) return null;
  if (!MALICIOUS_SUMMARY_PATTERNS.some((pattern) => pattern.test(lower))) return null;

  const cap = normalizeCapabilityLabel("UNKNOWN", text) ?? "OBFUSCATION";
  const focus = hypotheses.find((h) => h.severity === "critical" || h.severity === "high") ?? hypotheses[0];
  const fileLine = focus?.focusLines[0]
    ? `${focus.focusLines[0].file}:${focus.focusLines[0].range}`
    : focus?.focusFiles[0] ?? "";
  const confidence = /\bconfirmed malicious\b|\bconfirmed\b.*\bmalicious\b/.test(lower)
    ? "CONFIRMED"
    : "LIKELY";

  return {
    capability: cap,
    confidence,
    fileLine,
    problem: summary || text.slice(0, 240),
    evidence: text.slice(0, 500),
    reproductionStrategy: "Fallback from investigation agent text after structured extraction returned zero findings.",
  };
}

export function normalizeInvestigationFinding(
  finding: Finding,
  summary: string,
  agentText: string,
  hypotheses: readonly Hypothesis[],
): Finding {
  const context = [
    finding.problem,
    finding.evidence,
    finding.reproductionStrategy,
    summary,
    agentText,
  ].join("\n");
  const capability = normalizeCapabilityLabel(finding.capability, context);
  if (!capability) return finding;

  const focus = hypotheses.find((h) => h.severity === "critical" || h.severity === "high") ?? hypotheses[0];
  const fallbackFileLine = focus?.focusLines[0]
    ? `${focus.focusLines[0].file}:${focus.focusLines[0].range}`
    : focus?.focusFiles[0] ?? "";
  const fileLine = finding.fileLine && !/^\d+$/.test(finding.fileLine.trim())
    ? finding.fileLine
    : fallbackFileLine;

  return {
    ...finding,
    capability,
    fileLine,
    problem: finding.problem || summary || finding.reproductionStrategy.slice(0, 240),
    evidence: finding.evidence || finding.reproductionStrategy || summary.slice(0, 500),
  };
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

    // Fallback for "agent emitted 0 findings despite strong triage signals":
    // observed in bench v9.2c on mahesa-mangut14 (4 high hypotheses, 0 findings
    // → false SAFE) and gate-evm-tools-test (10MB obfuscated bundle, 0 findings
    // → false SAFE). When the agent extracts nothing, fall back to the triage
    // hypotheses themselves so the pipeline doesn't silently drop the signal.
    // Only high/critical severity to avoid promoting noisy medium hypotheses.
    const filteredFindings = filterActionableFindings(output.findings);
    if (filteredFindings.length !== output.findings.length) {
      console.warn(
        `[investigate] filtered ${output.findings.length - filteredFindings.length} benign/non-actionable ${output.findings.length - filteredFindings.length === 1 ? "finding" : "findings"} from investigation output`,
      );
    }

    let agentFindings = filteredFindings.map((finding) =>
      normalizeInvestigationFinding(finding, output.summary, output.agentText, hypotheses),
    );
    if (
      output.findings.length === 0 &&
      agentFindings.length === 0 &&
      !isBenignInvestigationSummary(output.summary)
    ) {
      const strongHyps = hypotheses.filter(
        (h) => h.severity === "high" || h.severity === "critical",
      );
      if (strongHyps.length > 0) {
        console.warn(
          `[investigate] agent extracted 0 findings; falling back to ${strongHyps.length} ${strongHyps.length === 1 ? "hypothesis" : "hypotheses"} from triage`,
        );
        agentFindings = strongHyps.map((h) => ({
          capability: CLAIM_TO_CAPABILITIES[h.claim.kind]?.[0] ?? "OBFUSCATION",
          confidence: "LIKELY" as const,
          fileLine: h.focusLines[0]
            ? `${h.focusLines[0].file}:${h.focusLines[0].range}`
            : h.focusFiles[0] ?? "",
          problem: h.description,
          evidence: `Triage emitted this ${h.severity} hypothesis (claim=${h.claim.kind}). Investigation agent did not extract corroborating findings, but the static signal alone is strong enough to flag.`,
          reproductionStrategy: `Static-signal proof. Inspect the focus file(s): ${h.focusFiles.join(", ")}`,
        }));
      } else {
        const fallback = buildAgentTextFallbackFinding(output.summary, output.agentText, hypotheses);
        if (fallback) {
          console.warn("[investigate] agent extracted 0 findings; falling back to malicious investigation summary");
          agentFindings = [fallback];
        }
      }
    } else if (output.findings.length === 0 && isBenignInvestigationSummary(output.summary)) {
      console.log("[investigate] agent found no actionable findings and summary refutes the triage signal; skipping static fallback");
    }

    // Emit findings for frontend visualization
    for (const finding of agentFindings) {
      emit?.("finding_discovered", { finding });
    }

    // Convert findings to proofs
    const capabilities = new Set<CapabilityEnum>();
    const proofs: Proof[] = [];

    for (const finding of agentFindings) {
      // Safety net: LLMs sometimes invent labels ("CRYPTO_THEFT", "SECRET_LEAK")
      // outside the strict enum. Without this, capability ends up null and the
      // verdict logic ignores otherwise-valid TEST_CONFIRMED proofs.
      const cap = normalizeCapabilityLabel(
        finding.capability,
        `${finding.problem} ${finding.evidence} ${finding.reproductionStrategy} ${output.summary} ${output.agentText}`,
      ) as CapabilityEnum | null;
      if (cap && cap !== finding.capability) {
        console.log(`[investigate] normalized "${finding.capability}" → ${cap}`);
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
      findings: agentFindings,
      toolCalls: output.toolCalls,
      agentText: output.agentText,
    };
  } finally {
    await sandbox.stop();
  }
}
