import { createHash } from "node:crypto";
import type {
  Hypothesis,
  ClaimKind,
  EvidenceRef,
} from "@npmguard/shared";
import type { HypothesisGraph } from "../graph/hypothesis-graph.js";
import type { InvestigationResult } from "../phases/investigate.js";
import type { Finding, Proof } from "../models.js";

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
  const caps = CLAIM_TO_CAPABILITIES[claim];
  return caps ? caps.includes(capability) : false;
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
  const matchesFile = hypothesis.focusFiles.includes(finding.file);
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
 * match scores above the minimum threshold (file must at least match).
 */
export function bestMatch(
  finding: Finding,
  hypotheses: readonly Hypothesis[],
  minScore = 1,
): { hypothesis: Hypothesis; score: CorrelationScore } | null {
  let best: { hypothesis: Hypothesis; score: CorrelationScore } | null = null;
  for (const h of hypotheses) {
    const score = scoreFindingHypothesis(finding, h);
    // File overlap is mandatory — claim-only matches across different files are noise
    if (score.fileScore === 0) continue;
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

// ---------------------------------------------------------------------------
// Stage 1: After investigation — findings → IN_PROGRESS transitions
// ---------------------------------------------------------------------------

export interface CorrelationResult {
  matched: Array<{ hypId: string; findingIndex: number; score: number }>;
  unmatched: number[];
}

/**
 * After investigation: correlate findings to hypotheses. Matched hypotheses
 * transition OPEN → IN_PROGRESS with the finding as evidence. Unmatched
 * hypotheses stay OPEN (the experimenter worker or manual review will handle them).
 */
export function correlateAfterInvestigation(
  graph: HypothesisGraph,
  investigation: InvestigationResult,
): CorrelationResult {
  const result: CorrelationResult = { matched: [], unmatched: [] };
  const openHyps = graph.filterByState("OPEN");

  if (openHyps.length === 0 || investigation.findings.length === 0) {
    return result;
  }

  const claimed = new Set<string>();

  investigation.findings.forEach((f, i) => {
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
      result.unmatched.push(i);
      console.log(
        `[correlate] finding[${i}] (${f.capability} @ ${f.fileLine}) → no match`,
      );
    }
  });

  return result;
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
