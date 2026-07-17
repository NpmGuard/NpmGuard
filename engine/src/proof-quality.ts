import type { AuditReport, Proof } from "./models.js";

export interface ProofQualityAssessment {
  accepted: boolean;
  reason: string;
  signals: string[];
}

export type AuditClassification = "SAFE" | "SUSPECT" | "DANGEROUS" | "UNKNOWN";

const NEGATIVE_TEST_INTENT =
  /\bit\s*\(\s*["'`][^"'`]*(?:does not|doesn't|without (?:exfiltrat|steal|spawn|read)|no (?:exfiltrat|credential|malicious))/i;

const TRIVIAL_ASSERTIONS = [
  /expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/i,
  /expect\s*\([^)]*\)\s*\.\s*toBeDefined\s*\(\s*\)/i,
  /expect\s*\([^)]*\)\s*\.\s*not\s*\.\s*toHaveBeenCalled/i,
  /expect\s*\([^)]*\)\s*\.\s*toBeNull\s*\(\s*\)/i,
  /expect\s*\([^)]*\)\s*\.\s*toBeUndefined\s*\(\s*\)/i,
];

const MANUFACTURED_ATTACK_PATTERNS = [
  /\b(?:maliciousPath|attackerDir|attackerUrl|attackerEndpoint)\b/i,
  /\bapiBaseUrl\s*:\s*["'`]https?:\/\/(?:attacker|evil)\b/i,
  /\b(?:url|endpoint)\s*:\s*["'`]https?:\/\/(?:attacker|evil)\b/i,
  /["'`]\s*;\s*(?:curl|wget|npm|npx|bash|sh|powershell)\b/i,
  /["'`]\s*\|\s*(?:bash|sh|powershell)\b/i,
];

const CONDITIONAL_ASSERTION =
  /\bif\s*\([^)]*\)\s*\{[\s\S]{0,600}?\bexpect\s*\(/i;

const CANARY_ASSERTION =
  /expect\s*\([\s\S]{0,350}?\)\s*\.\s*(?:toContain|toMatch|toEqual|toStrictEqual)\s*\([\s\S]{0,220}?NPMGUARD_CANARY/i;

const RISKY_SPAWN_ASSERTION =
  /expect\s*\([\s\S]{0,240}?(?:spawnLog|spawnArgs|capturedCmds|commands|execSpy)[\s\S]{0,120}?\)\s*\.\s*(?:toContain|toMatch|toEqual|toStrictEqual|toHaveBeenCalledWith)\s*\([\s\S]{0,260}?(?:curl[\s\S]{0,80}?(?:bash|sh)|wget[\s\S]{0,80}?(?:bash|sh)|npm\s+publish|pnpm\s+publish|powershell|Invoke-WebRequest|chmod\s+\+x)/i;

const DOS_TIMEOUT_ASSERTION =
  /expect\s*\(\s*(?:result|r)\.timedOut\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/i;

const DOS_IMPACT_ASSERTION =
  /expect\s*\(\s*(?:result|r)\.(?:killed|stdout(?:\.length)?)\s*\)\s*\.\s*(?:toBe|toContain|toMatch|toBeGreaterThan)\s*\(/i;

const HIJACK_ASSERTION =
  /expect\s*\([\s\S]{0,180}?(?:result|clipboard|address|document|html|tx|payload)[\s\S]{0,180}?\)\s*\.\s*toContain\s*\([\s\S]{0,120}?(?:ATTACKER|DRAINER|HIJACK|deadbeefdeadbeef)/i;

const DESTRUCTIVE_FS_ASSERTION =
  /expect\s*\([\s\S]{0,180}?(?:writeSpy|unlinkSpy|rmSpy|removeSpy)[\s\S]{0,100}?\)\s*\.\s*toHaveBeenCalledWith\s*\([\s\S]{0,220}?(?:stringContaining|recursive|force|❤|\\u2764)/i;

const DROPPER_ASSERTIONS = [
  /expect\s*\(\s*payloadRequested\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/i,
  /expect\s*\(\s*writeSpy\s*\)\s*\.\s*toHaveBeenCalledWith/i,
  /expect\s*\(\s*chmodSpy\s*\)\s*\.\s*toHaveBeenCalled/i,
];

function rejected(reason: string, signals: string[] = []): ProofQualityAssessment {
  return { accepted: false, reason, signals };
}

/**
 * Static admission gate for LLM-generated reproducers.
 *
 * A passing Vitest file only proves that its assertions passed. It does not
 * prove that the asserted behavior is malicious. This gate therefore requires
 * a positive, security-relevant outcome before verify is allowed to promote a
 * proof to TEST_CONFIRMED.
 */
export function assessGeneratedTestProofQuality(
  testCode: string | null | undefined,
  capability: string | null | undefined,
): ProofQualityAssessment {
  const code = testCode?.trim() ?? "";
  if (!code) return rejected("missing generated test code");

  if (!code.includes("runPackage(") && !code.includes("runInChildProcess(")) {
    return rejected("test does not execute the audited package");
  }

  if (code.includes("Object.keys(process.env)")) {
    return rejected("test reads the planted environment itself, making the assertion self-satisfying");
  }

  if (MANUFACTURED_ATTACK_PATTERNS.some((pattern) => pattern.test(code))) {
    return rejected("test manufactures an attacker-controlled input instead of observing package behavior");
  }

  const signals: string[] = [];
  if (CANARY_ASSERTION.test(code)) signals.push("canary-crossed-sink");

  if (RISKY_SPAWN_ASSERTION.test(code)) {
    signals.push("dangerous-process-chain");
  }

  if (DOS_TIMEOUT_ASSERTION.test(code) && DOS_IMPACT_ASSERTION.test(code)) {
    signals.push("reproducible-dos-impact");
  }

  if (HIJACK_ASSERTION.test(code)) {
    signals.push("victim-value-hijacked");
  }

  if (DESTRUCTIVE_FS_ASSERTION.test(code)) {
    signals.push("destructive-filesystem-impact");
  }

  if (DROPPER_ASSERTIONS.every((pattern) => pattern.test(code))) {
    signals.push("download-write-execute-chain");
  }

  const testCount = code.match(/\bit\s*\(/g)?.length ?? 0;
  if (testCount <= 1 && NEGATIVE_TEST_INTENT.test(code)) {
    return rejected("test title describes absence of malicious behavior", signals);
  }

  if (testCount <= 1 && CONDITIONAL_ASSERTION.test(code)) {
    return rejected("security assertion is conditional and can be skipped", signals);
  }

  const normalizedCapability = (capability ?? "").toUpperCase();
  const acceptedByCapability =
    normalizedCapability === "DOS_LOOP"
      ? signals.includes("reproducible-dos-impact")
      : normalizedCapability === "CLIPBOARD_HIJACK" || normalizedCapability === "DOM_INJECT"
        ? signals.includes("victim-value-hijacked") || signals.includes("canary-crossed-sink")
        : normalizedCapability === "PROCESS_SPAWN" ||
            normalizedCapability === "BINARY_DOWNLOAD" ||
            normalizedCapability === "LIFECYCLE_HOOK" ||
            normalizedCapability === "WORM_PROPAGATION"
          ? signals.includes("dangerous-process-chain") ||
            signals.includes("download-write-execute-chain") ||
            signals.includes("canary-crossed-sink")
          : normalizedCapability === "FILESYSTEM"
            ? signals.includes("destructive-filesystem-impact") ||
              signals.includes("download-write-execute-chain") ||
              signals.includes("canary-crossed-sink")
            : normalizedCapability === "OBFUSCATION" ||
                normalizedCapability === "ENCRYPTED_PAYLOAD" ||
                normalizedCapability === "EVAL"
              ? signals.includes("download-write-execute-chain") ||
                signals.includes("canary-crossed-sink")
              : signals.includes("canary-crossed-sink");

  if (!acceptedByCapability) {
    const trivial = TRIVIAL_ASSERTIONS.find((pattern) => pattern.test(code));
    return rejected(
      trivial
        ? "test only contains a benign, negative, or structural assertion"
        : `test has no positive security assertion for ${normalizedCapability || "UNKNOWN"}`,
      signals,
    );
  }

  return {
    accepted: true,
    reason: `accepted security proof: ${signals.join(", ")}`,
    signals,
  };
}

export function isHighQualityConfirmedProof(proof: Proof): boolean {
  if (proof.kind !== "TEST_CONFIRMED") return false;
  return assessGeneratedTestProofQuality(proof.testCode, proof.capability).accepted;
}

function isStructuralDealbreaker(proof: Proof): boolean {
  return (
    proof.kind === "STRUCTURAL" &&
    proof.confidence === "CONFIRMED" &&
    proof.reproducible === true &&
    /^Dealbreaker:\s*shell-pipe\b/i.test(proof.evidence)
  );
}

/**
 * Rich classification used by repository scans. AuditReport.verdict remains
 * the legacy SAFE/DANGEROUS transport field until every client supports the
 * four-state vocabulary.
 */
export function classifyAuditReport(
  report: Pick<AuditReport, "verdict" | "proofs" | "findings">,
): AuditClassification {
  if (report.proofs.some(isStructuralDealbreaker)) return "DANGEROUS";
  if (report.proofs.some(isHighQualityConfirmedProof)) return "DANGEROUS";

  if (report.verdict === "SAFE" && report.findings.length === 0) return "SAFE";

  if (report.findings.length > 0 || report.proofs.length > 0) {
    return "SUSPECT";
  }

  return report.verdict === "SAFE" ? "SAFE" : "UNKNOWN";
}
