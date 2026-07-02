import { createHash } from "node:crypto";
import type {
  Hypothesis,
  ClaimKind,
  EvidenceRef,
} from "@npmguard/shared";
import type { HypothesisGraph } from "../graph/hypothesis-graph.js";
import type { InvestigationResult } from "../phases/investigate.js";
import { CapabilityEnum, type Finding, type Proof } from "../models.js";

// ---------------------------------------------------------------------------
// Claim ↔ Capability mapping
// ---------------------------------------------------------------------------

/**
 * Maps ClaimKind → set of CapabilityEnum values that would indicate the
 * hypothesis is correct. One-to-many: env_exfil can be backed by ENV_VARS
 * or NPM_TOKEN_ABUSE evidence.
 */
export const CLAIM_TO_CAPABILITIES: Record<ClaimKind, readonly string[]> = {
  env_exfil: ["ENV_VARS", "NPM_TOKEN_ABUSE", "CREDENTIAL_THEFT", "NETWORK"],
  cred_theft: ["CREDENTIAL_THEFT", "ENV_VARS", "NPM_TOKEN_ABUSE"],
  binary_drop: ["BINARY_DOWNLOAD", "PROCESS_SPAWN", "FILESYSTEM"],
  obfuscation: ["OBFUSCATION", "ENCRYPTED_PAYLOAD", "EVAL"],
  persistence: ["LIFECYCLE_HOOK", "FILESYSTEM", "PROCESS_SPAWN"],
  destructive: ["FILESYSTEM", "PROCESS_SPAWN"],
  propagation: ["WORM_PROPAGATION", "NETWORK"],
  dos_loop: ["DOS_LOOP"],
  clipboard_hijack: ["CLIPBOARD_HIJACK"],
  dom_inject: ["DOM_INJECT"],
  telemetry: ["TELEMETRY_RAT", "NETWORK"],
  dns_exfil: ["DNS_EXFIL", "NETWORK"],
  build_plugin_exfil: ["BUILD_PLUGIN_EXFIL"],
};

export function claimMatchesCapability(
  claim: ClaimKind,
  capability: string,
): boolean {
  if (capability === "CLEAN") {
    return false;
  }

  const normalized = normalizeCapabilityLabel(capability);
  if (!normalized) {
    return false;
  }

  const caps = CLAIM_TO_CAPABILITIES[claim];
  return caps ? caps.includes(normalized) : false;
}

/**
 * LLMs often emit labels outside CapabilityEnum, or composite labels such as
 * "CREDENTIAL_THEFT / NETWORK". Normalize those labels before graph
 * correlation so otherwise good findings do not get dropped as UNKNOWN.
 */
export function normalizeCapabilityLabel(
  capability: string | null | undefined,
  context = "",
): string | null {
  const raw = `${capability ?? ""} ${context}`.toUpperCase();
  if (!raw.trim() || raw.includes("CLEAN")) return null;

  for (const token of raw.split(/[^A-Z0-9_]+/)) {
    const parsed = CapabilityEnum.safeParse(token);
    if (parsed.success) return parsed.data;
  }

  if (raw.includes("NPM_TOKEN") || raw.includes("NPMRC")) return "NPM_TOKEN_ABUSE";
  if (
    raw.includes("CREDENTIAL") ||
    raw.includes("SECRET") ||
    raw.includes("TOKEN") ||
    raw.includes("AUTH") ||
    raw.includes("TRUFFLEHOG")
  ) return "CREDENTIAL_THEFT";
  if (raw.includes("DNS") && raw.includes("EXFIL")) return "DNS_EXFIL";
  if (raw.includes("EXFIL") || raw.includes("EXPORT") || raw.includes("LEAK")) return "DATA_EXFILTRATION";
  if (raw.includes("ENV")) return "ENV_VARS";
  if (raw.includes("BINARY") || raw.includes("DOWNLOAD") || raw.includes("BUN.SH")) return "BINARY_DOWNLOAD";
  if (
    raw.includes("PROCESS") ||
    raw.includes("SPAWN") ||
    raw.includes("EXEC") ||
    raw.includes("POWERSHELL") ||
    raw.includes("BASH")
  ) return "PROCESS_SPAWN";
  if (raw.includes("FILE") || raw.includes("FS") || raw.includes("DISK") || raw.includes("PERSIST")) return "FILESYSTEM";
  if (raw.includes("EVAL") || raw.includes("FUNCTION_CONSTRUCTOR") || raw.includes("CODE_EXECUTION")) return "EVAL";
  if (raw.includes("OBFUSC") || raw.includes("ENCRYPT")) return "OBFUSCATION";
  if (raw.includes("LIFECYCLE") || raw.includes("POSTINSTALL") || raw.includes("PREINSTALL")) return "LIFECYCLE_HOOK";
  if (raw.includes("WORM") || raw.includes("PROPAGAT")) return "WORM_PROPAGATION";
  if (raw.includes("CLIPBOARD")) return "CLIPBOARD_HIJACK";
  if (raw.includes("DOM")) return "DOM_INJECT";
  if (raw.includes("TELEMETRY")) return "TELEMETRY_RAT";
  if (raw.includes("BUILD") && raw.includes("PLUGIN")) return "BUILD_PLUGIN_EXFIL";
  if (raw.includes("NETWORK") || raw.includes("HTTP") || raw.includes("FETCH")) return "NETWORK";

  return null;
}

// ---------------------------------------------------------------------------
// File-line overlap
// ---------------------------------------------------------------------------

export interface ParsedFileLine {
  file: string;
  startLine: number | null;
  endLine: number | null;
}

/**
 * Parse "lib/setup.js:42-67" or "lib/setup.js:42" or "lib/setup.js"
 * into structured { file, startLine, endLine }.
 */
export function parseFileLine(fileLine: string): ParsedFileLine {
  const colonIdx = fileLine.lastIndexOf(":");
  if (colonIdx === -1) {
    return { file: fileLine, startLine: null, endLine: null };
  }
  const file = fileLine.slice(0, colonIdx);
  const rest = fileLine.slice(colonIdx + 1);

  // Handle "42-67" or "42"
  const dashIdx = rest.indexOf("-");
  if (dashIdx === -1) {
    const n = parseInt(rest, 10);
    return { file, startLine: isNaN(n) ? null : n, endLine: isNaN(n) ? null : n };
  }
  const start = parseInt(rest.slice(0, dashIdx), 10);
  const end = parseInt(rest.slice(dashIdx + 1), 10);
  return {
    file,
    startLine: isNaN(start) ? null : start,
    endLine: isNaN(end) ? null : end,
  };
}

/**
 * Parse a hypothesis focusLine range string into start/end line numbers.
 * Handles "42-58", "42", and comma-separated ranges (takes first range).
 */
function parseRange(range: string): { start: number; end: number } | null {
  const first = range.split(",")[0] ?? "";
  const parts = first.trim().split("-");
  const start = parseInt(parts[0] ?? "", 10);
  const end = parts.length > 1 ? parseInt(parts[1] ?? "", 10) : start;
  if (isNaN(start) || isNaN(end)) return null;
  return { start, end };
}

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/**
 * Does the finding's fileLine reference overlap with the hypothesis?
 * Score: 0 = no overlap, 1 = same file, 2 = same file + overlapping lines.
 */
export function fileOverlapScore(
  finding: ParsedFileLine,
  hypothesis: Hypothesis,
): number {
  const matchesFile = hypothesis.focusFiles.some((focusFile) =>
    fileReferencesOverlap(finding.file, focusFile),
  );
  if (!matchesFile) return 0;

  if (finding.startLine === null || finding.endLine === null) return 1;

  for (const fl of hypothesis.focusLines) {
    if (fl.file !== finding.file) continue;
    const hRange = parseRange(fl.range);
    if (!hRange) continue;
    if (rangesOverlap({ start: finding.startLine, end: finding.endLine }, hRange)) {
      return 2;
    }
  }

  return 1; // same file, different lines
}

function fileReferencesOverlap(findingFile: string, focusFile: string): boolean {
  const finding = findingFile.replaceAll("\\", "/").replaceAll("`", "");
  const focus = focusFile.replaceAll("\\", "/").replaceAll("`", "");
  if (!finding || !focus) return false;
  if (finding === focus) return true;
  if (finding.endsWith(`/${focus}`) || focus.endsWith(`/${finding}`)) return true;
  return finding.includes(focus);
}

// ---------------------------------------------------------------------------
// Finding → Hypothesis scoring
// ---------------------------------------------------------------------------

export interface CorrelationScore {
  hypId: string;
  score: number;
  fileScore: number;
  claimScore: number;
}

/**
 * Score how well a finding matches a hypothesis.
 * Total = fileScore (0-2) + claimScore (0-3). Range [0, 5].
 */
export function scoreFindingHypothesis(
  finding: Finding,
  hypothesis: Hypothesis,
): CorrelationScore {
  const parsed = parseFileLine(finding.fileLine);
  const fileScore = fileOverlapScore(parsed, hypothesis);
  const claimScore = claimMatchesCapability(hypothesis.claim.kind, finding.capability) ? 3 : 0;
  return {
    hypId: hypothesis.hypId,
    score: fileScore + claimScore,
    fileScore,
    claimScore,
  };
}

/**
 * Find the best-matching hypothesis for a finding. Returns null if no
 * match scores above the minimum threshold. A finding must match both file
 * location and claim capability; file-only matches are often benign reviews
 * of a triage false positive.
 */
export function bestMatch(
  finding: Finding,
  hypotheses: readonly Hypothesis[],
  minScore = 4,
): { hypothesis: Hypothesis; score: CorrelationScore } | null {
  let best: { hypothesis: Hypothesis; score: CorrelationScore } | null = null;
  for (const h of hypotheses) {
    const score = scoreFindingHypothesis(finding, h);
    // File overlap and claim match are both mandatory: either alone is noise.
    if (score.fileScore === 0) continue;
    if (score.claimScore === 0) continue;
    if (score.score >= minScore && (!best || score.score > best.score.score)) {
      best = { hypothesis: h, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Evidence ref helpers
// ---------------------------------------------------------------------------

function findingRef(finding: Finding, index: number): EvidenceRef {
  const content = `${finding.fileLine}|${finding.capability}|${finding.problem}`;
  const hash = createHash("sha256").update(content).digest("hex");
  return { kind: "run", id: `finding_${index}`, hash };
}

function proofRef(proof: Proof, index: number): EvidenceRef {
  const hash =
    proof.contentHash ??
    proof.testHash ??
    createHash("sha256").update(`${proof.fileLine}|${proof.problem}`).digest("hex");
  return { kind: "run", id: `proof_${index}`, hash };
}

function investigationRef(hypothesis: Hypothesis, investigation: InvestigationResult): EvidenceRef {
  const content = `${hypothesis.hypId}|${hypothesis.description}|${investigation.agentText}`;
  const hash = createHash("sha256").update(content).digest("hex");
  return { kind: "run", id: `investigation_refuted_${hypothesis.hypId}`, hash };
}

// ---------------------------------------------------------------------------
// Stage 1: After investigation — findings → IN_PROGRESS transitions
// ---------------------------------------------------------------------------

export interface CorrelationResult {
  matched: Array<{ hypId: string; findingIndex: number; score: number }>;
  promoted: Array<{ hypId: string; findingIndex: number; capability: string }>;
  unmatched: number[];
}

/**
 * After investigation: correlate findings to hypotheses. Matched hypotheses
 * transition OPEN → IN_PROGRESS with the finding as evidence. Hypotheses that
 * the investigation does not support are refuted so benign capability findings
 * do not force expensive proof generation or public DANGEROUS verdicts.
 */
export function correlateAfterInvestigation(
  graph: HypothesisGraph,
  investigation: InvestigationResult,
): CorrelationResult {
  const result: CorrelationResult = { matched: [], promoted: [], unmatched: [] };
  const openHyps = graph.filterByState("OPEN");

  if (openHyps.length === 0) {
    return result;
  }

  const claimed = new Set<string>();

  investigation.findings.forEach((f, i) => {
    if (f.capability === "CLEAN") {
      result.unmatched.push(i);
      console.log(
        `[correlate] finding[${i}] (${f.capability} @ ${f.fileLine}) → no match (clean finding)`,
      );
      return;
    }

    const preexistingMatch = bestMatch(f, openHyps);
    const candidates = openHyps.filter((h) => !claimed.has(h.hypId));
    const match = bestMatch(f, candidates);

    if (match) {
      claimed.add(match.hypothesis.hypId);
      result.matched.push({
        hypId: match.hypothesis.hypId,
        findingIndex: i,
        score: match.score.score,
      });

      const ref = findingRef(f, i);
      graph.addEvidence(match.hypothesis.hypId, [ref]);

      // Agent-CONFIRMED findings come from the investigation tool traces
      // (runLifecycleHook, requireAndTrace) — that's real dynamic evidence,
      // not just an LLM opinion. Promote straight to CONFIRMED so verify
      // infra failures can't downgrade us to SAFE on a confirmed worm.
      // SUSPECTED / LIKELY findings stay IN_PROGRESS pending verify.
      graph.transition(match.hypothesis.hypId, {
        to: "IN_PROGRESS",
        by: "correlator:investigation",
      });
      if (f.confidence === "CONFIRMED") {
        graph.transition(match.hypothesis.hypId, {
          to: "CONFIRMED",
          by: "correlator:investigation",
        });
      }

      console.log(
        `[correlate] finding[${i}] (${f.capability} @ ${f.fileLine}, ${f.confidence}) → ${match.hypothesis.hypId} (score=${match.score.score})`,
      );
    } else {
      const promoted = preexistingMatch && claimed.has(preexistingMatch.hypothesis.hypId)
        ? null
        : promoteUnmatchedFinding(graph, f, i);
      if (promoted) {
        result.promoted.push({
          hypId: promoted.hypId,
          findingIndex: i,
          capability: promoted.capability,
        });
      }
      result.unmatched.push(i);
      console.log(
        `[correlate] finding[${i}] (${f.capability} @ ${f.fileLine}) → ${promoted ? `promoted ${promoted.hypId}` : "no match"}`,
      );
    }
  });

  for (const h of openHyps) {
    if (claimed.has(h.hypId)) continue;
    graph.transition(h.hypId, {
      to: "REFUTED",
      by: "correlator:investigation",
      reason: "Investigation completed without evidence matching this hypothesis.",
      evidenceRefs: [investigationRef(h, investigation)],
    });
    console.log(`[correlate] ${h.hypId} → REFUTED (no matching investigation finding)`);
  }

  return result;
}

function promoteUnmatchedFinding(
  graph: HypothesisGraph,
  finding: Finding,
  index: number,
): { hypId: string; capability: string } | null {
  const capability = normalizeCapabilityLabel(
    finding.capability,
    `${finding.problem} ${finding.evidence}`,
  );
  if (!capability || !shouldPromoteUnmatchedFinding(finding, capability)) {
    return null;
  }

  const parsed = parseFileLine(finding.fileLine);
  const focusFiles = parsed.file ? [parsed.file] : [];
  const focusLines =
    parsed.file && parsed.startLine !== null && parsed.endLine !== null
      ? [{ file: parsed.file, range: `${parsed.startLine}-${parsed.endLine}` }]
      : [];
  const hypId = uniqueInvestigationHypId(graph, index);
  const ref = findingRef(
    {
      ...finding,
      capability,
      problem: finding.problem || finding.evidence.slice(0, 160),
      fileLine: finding.fileLine || parsed.file,
    },
    index,
  );

  graph.add({
    hypId,
    description: finding.problem || finding.evidence.slice(0, 240),
    claim: { kind: claimForCapability(capability), gating: null },
    focusFiles,
    focusLines,
    severity: severityForFinding(finding, capability),
    parentHypId: null,
    childHypIds: [],
    state: "OPEN",
    createdBy: "correlator:investigation",
    evidenceRefs: [],
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolution: null,
  });

  if (finding.confidence === "CONFIRMED") {
    graph.transition(hypId, {
      to: "CONFIRMED",
      by: "correlator:investigation",
      evidenceRefs: [ref],
    });
  } else {
    graph.addEvidence(hypId, [ref]);
    graph.transition(hypId, {
      to: "IN_PROGRESS",
      by: "correlator:investigation",
    });
  }

  return { hypId, capability };
}

function uniqueInvestigationHypId(graph: HypothesisGraph, index: number): string {
  const base = `inv-${String(index + 1).padStart(4, "0")}`;
  let candidate = base;
  let suffix = 2;
  while (graph.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  return candidate;
}

function shouldPromoteUnmatchedFinding(finding: Finding, capability: string): boolean {
  if (finding.confidence === "CONFIRMED" || finding.confidence === "LIKELY") {
    return capability !== "NETWORK" && capability !== "FILESYSTEM";
  }
  return new Set([
    "CREDENTIAL_THEFT",
    "DATA_EXFILTRATION",
    "NPM_TOKEN_ABUSE",
    "DNS_EXFIL",
    "BUILD_PLUGIN_EXFIL",
    "WORM_PROPAGATION",
    "CLIPBOARD_HIJACK",
  ]).has(capability);
}

function claimForCapability(capability: string): ClaimKind {
  switch (capability) {
    case "ENV_VARS":
    case "DATA_EXFILTRATION":
    case "NPM_TOKEN_ABUSE":
      return "env_exfil";
    case "CREDENTIAL_THEFT":
      return "cred_theft";
    case "BINARY_DOWNLOAD":
    case "PROCESS_SPAWN":
      return "binary_drop";
    case "OBFUSCATION":
    case "ENCRYPTED_PAYLOAD":
    case "EVAL":
      return "obfuscation";
    case "FILESYSTEM":
    case "LIFECYCLE_HOOK":
      return "persistence";
    case "WORM_PROPAGATION":
      return "propagation";
    case "DOS_LOOP":
      return "dos_loop";
    case "CLIPBOARD_HIJACK":
      return "clipboard_hijack";
    case "DOM_INJECT":
      return "dom_inject";
    case "TELEMETRY_RAT":
      return "telemetry";
    case "DNS_EXFIL":
      return "dns_exfil";
    case "BUILD_PLUGIN_EXFIL":
      return "build_plugin_exfil";
    default:
      return "obfuscation";
  }
}

function severityForFinding(
  finding: Finding,
  capability: string,
): Hypothesis["severity"] {
  if (
    finding.confidence === "CONFIRMED" &&
    ["CREDENTIAL_THEFT", "DATA_EXFILTRATION", "NPM_TOKEN_ABUSE", "DNS_EXFIL"].includes(capability)
  ) return "critical";
  if (
    finding.confidence === "CONFIRMED" ||
    ["CREDENTIAL_THEFT", "DATA_EXFILTRATION", "NPM_TOKEN_ABUSE", "WORM_PROPAGATION"].includes(capability)
  ) return "high";
  return "medium";
}

// ---------------------------------------------------------------------------
// Stage 2: After verify — proofs → CONFIRMED/INCONCLUSIVE transitions
// ---------------------------------------------------------------------------

export interface VerifyCorrelationResult {
  confirmed: string[];
  inconclusive: string[];
}

/**
 * After verify: proofs with TEST_CONFIRMED kind transition matched hypotheses
 * from IN_PROGRESS → CONFIRMED. Remaining IN_PROGRESS hypotheses without a
 * confirmed proof go to INCONCLUSIVE — UNLESS the failures were all infra
 * (container_start_failed, npm_install_failed): in that case verify never
 * actually ran the tests, so claiming "we tested and couldn't confirm" would
 * be a lie. Leave hypotheses in their current state for retry.
 */
const INFRA_ERRORS = new Set([
  "container_start_failed",
  "npm_install_failed",
]);

function allFailuresWereInfra(proofs: readonly Proof[]): boolean {
  const testProofs = proofs.filter((p) => p.testFile !== null);
  if (testProofs.length === 0) return false;
  const unconfirmed = testProofs.filter((p) => p.kind !== "TEST_CONFIRMED");
  if (unconfirmed.length === 0) return false; // everything passed
  return unconfirmed.every((p) => p.verifyError !== null && INFRA_ERRORS.has(p.verifyError));
}

export function correlateAfterVerify(
  graph: HypothesisGraph,
  verifiedProofs: Proof[],
  findings: Finding[],
): VerifyCorrelationResult {
  const result: VerifyCorrelationResult = { confirmed: [], inconclusive: [] };

  const confirmedProofs = verifiedProofs.filter((p) => p.kind === "TEST_CONFIRMED");
  const infraFailed = allFailuresWereInfra(verifiedProofs);

  // Match confirmed proofs to IN_PROGRESS hypotheses
  const inProgressHyps = graph.filterByState("IN_PROGRESS");
  const claimed = new Set<string>();

  confirmedProofs.forEach((p, i) => {
    const matchingFinding = findings.find(
      (f) => f.fileLine === p.fileLine && f.capability === (p.capability ?? ""),
    );

    const candidates = inProgressHyps.filter((h) => !claimed.has(h.hypId));
    const toMatch: Finding = matchingFinding ?? {
      capability: p.capability ?? "",
      confidence: "CONFIRMED" as const,
      fileLine: p.fileLine,
      problem: p.problem,
      evidence: p.evidence,
      reproductionStrategy: "",
    };

    const match = bestMatch(toMatch, candidates);

    // Claim-match gate: bestMatch accepts a file-only match (claimScore 0), so a
    // proof of an UNRELATED capability could otherwise CONFIRM a hypothesis that
    // merely shares a file. Skip when the proof capability doesn't map to the
    // hypothesis claim — leave it IN_PROGRESS to fall through to INCONCLUSIVE.
    if (match && !claimMatchesCapability(match.hypothesis.claim.kind, toMatch.capability)) {
      return;
    }

    if (match) {
      claimed.add(match.hypothesis.hypId);
      const ref = proofRef(p, i);
      graph.transition(match.hypothesis.hypId, {
        to: "CONFIRMED",
        by: "correlator:verify",
        evidenceRefs: [ref],
      });
      result.confirmed.push(match.hypothesis.hypId);
      console.log(
        `[correlate] proof[${i}] (${p.capability} @ ${p.fileLine}) → CONFIRMED ${match.hypothesis.hypId}`,
      );
    }
  });

  if (infraFailed) {
    // Verify infra never ran the tests — leave hypotheses in their current
    // state. Don't downgrade IN_PROGRESS to INCONCLUSIVE; that would falsely
    // claim "we tested and couldn't confirm." OPEN hypotheses (no
    // investigation match) also stay OPEN — pipeline-level deriveGraphVerdict
    // will surface this as SUSPECT.
    console.log(
      `[correlate] verify infra failed (no tests ran) — preserving graph state`,
    );
    return result;
  }

  // Remaining IN_PROGRESS + OPEN hypotheses → INCONCLUSIVE
  const remaining = [
    ...graph.filterByState("IN_PROGRESS"),
    ...graph.filterByState("OPEN"),
  ];
  for (const h of remaining) {
    graph.transition(h.hypId, {
      to: "INCONCLUSIVE",
      by: "correlator:verify",
      reason: "Static investigation + test verification did not produce sufficient evidence to confirm or refute.",
    });
    result.inconclusive.push(h.hypId);
    console.log(`[correlate] ${h.hypId} → INCONCLUSIVE (no confirming proof)`);
  }

  return result;
}
