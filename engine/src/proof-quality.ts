import type { AuditReport, Finding, Proof } from "./models.js";

export interface ProofQualityAssessment {
  accepted: boolean;
  reason: string;
  signals: string[];
}

export type AuditClassification = "SAFE" | "SUSPECT" | "DANGEROUS" | "UNKNOWN";

export interface FindingQualityAssessment {
  accepted: boolean;
  reason: string;
  signals: string[];
}

export interface AuditAssessmentEvidence {
  source: "sandbox" | "inventory" | "analysis";
  capability: string | null;
  fileLine: string;
  reason: string;
  evidence: string;
}

export interface AuditAssessment {
  classification: AuditClassification;
  summary: string;
  evidence: AuditAssessmentEvidence[];
  rejectedSignalCount: number;
}

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

const EXPLICITLY_BENIGN_FINDING = [
  /\bno (?:suspicious|malicious|dangerous|unexpected) (?:behavior|behaviour|logic|pattern|activity|code)/i,
  /\bno (?:suspicious|malicious) (?:patterns?|behaviors?|behaviours?) (?:were|was|are|is) (?:identified|found|detected|observed)/i,
  /\bnot (?:inherently|itself) malicious\b/i,
  /\b(?:standard|common|normal|legitimate|expected|intended) (?:behavior|behaviour|pattern|functionality|operation|implementation|use|usage|mechanism|bundle|package structure)\b/i,
  /\bconsistent with (?:the )?package(?:'s)? (?:purpose|functionality)\b/i,
  /\bpart of (?:the )?expected\b/i,
  /\bconsidered (?:standard|normal|low-risk|safe)\b/i,
  /\bdoes not (?:indicate|show|demonstrate|perform|exhibit) (?:any )?(?:malicious|suspicious|dangerous)\b/i,
];

const META_ANALYSIS_ONLY = [
  /\btriage emitted this\b/i,
  /\bmodel summary describes\b/i,
  /\binvestigation agent did not\b/i,
  /\bstatic signal alone\b/i,
  /\bfallback from investigation agent text\b/i,
];

const TEST_ONLY_LOCATION =
  /(?:^|[/\\])(?:test|tests|__tests__|fixtures?|integration_tests)(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]sx?(?::|$)/i;

const SECRET_TARGET =
  /\b(?:credential|secret|token|api[_ -]?key|private[_ -]?key|seed phrase|mnemonic|npm_token|process\.env|environment variable|cookie|session)\b/i;
const SECRET_EXFILTRATION_OUTCOME =
  /\b(?:exfiltrat|steal|harvest|leak)\w*\b|\b(?:upload|send|transmit|post)\w*\b[\s\S]{0,120}\b(?:attacker|remote|external|unknown|dns|http|endpoint)\b/i;
const EXECUTION_SINK =
  /\b(?:child_process|execFile|execSync|spawnSync|spawn|exec|eval|new Function|vm\.run|shell|powershell|curl|wget)\b/i;
const UNTRUSTED_SOURCE =
  /\b(?:attacker[- ]controlled|user[- ]controlled|untrusted|remote|downloaded|external input|package metadata|registry response)\b/i;
const SOURCE_TO_SINK_FLOW =
  /\b(?:reaches|flows? (?:in)?to|passed (?:in)?to|used by|interpolated into)\b/i;
const DOWNLOAD_EXECUTE_OUTCOME =
  /\b(?:download(?:s|ed|ing)?|fetch(?:es|ed|ing)?)\b[\s\S]{0,180}\b(?:execut(?:e|es|ed|ing)|spawn|shell|chmod|write)\b|\b(?:curl|wget)\b[\s\S]{0,120}\b(?:bash|sh|powershell)\b/i;
const DESTRUCTIVE_OUTCOME =
  /\b(?:wipe|wiper|rm\s+-rf)\b|\b(?:delete|remove|unlink|rmdir|overwrite|destroy|encrypt)\w*\b[\s\S]{0,100}\b(?:directories|directory|filesystem|home directory|workspace|project files|user files)\b/i;
const HIJACK_OUTCOME =
  /\b(?:clipboard|wallet address|transaction|recipient|dom|innerHTML|document\.write)\b[\s\S]{0,140}\b(?:hijack|replace|inject|drain|attacker|phish|steal)\w*/i;
const DOS_OUTCOME =
  /\b(?:redos|denial of service|infinite loop|resource exhaustion|event loop block|memory exhaustion|cpu exhaustion)\b/i;
const PERSISTENCE_OUTCOME =
  /\b(?:persistence|startup|autorun|cron|launch agent|scheduled task|shell profile)\b/i;
const PROPAGATION_OUTCOME =
  /\b(?:npm publish|pnpm publish|yarn publish|worm propagation|self-propagat|infect(?:s|ed|ing)? other package)\b/i;
const OBFUSCATED_EXECUTION_OUTCOME =
  /\b(?:encrypted payload|base64 payload|atob|decrypt|decode)\w*\b[\s\S]{0,160}\b(?:eval|exec|spawn|new Function|child_process)\b|\b(?:eval|exec|spawn|new Function|child_process)\b[\s\S]{0,160}\b(?:encrypted payload|base64 payload|atob|decrypt|decode)\w*/i;
const CONCRETE_RUNTIME_OBSERVATION =
  /\b(?:observed|captured|intercepted|recorded|wrote|deleted|spawned|requested|connected|timed out)\b/i;
const CALLER_MANUFACTURES_ATTACK =
  /\b(?:send|provide|supply|pass|configure|set)\w*\b[\s\S]{0,100}\b(?:malicious|attacker-controlled|untrusted|crafted|pathological|complex)\b[\s\S]{0,100}\b(?:url|command|code|path|script|configuration|config|input|regex|regexp|regular expression|pattern|settings)\b/i;
const COUNTERFACTUAL_EXTERNAL_COMPROMISE =
  /\bif\b[\s\S]{0,140}\b(?:repository|server|source|dependency|configuration|config|url)\b[\s\S]{0,100}\b(?:compromised|controlled by (?:an )?attacker|malicious)\b/i;

const CAPABILITIES_BY_SIGNAL: Record<string, Set<string>> = {
  "secret-to-outbound-sink": new Set([
    "CREDENTIAL_THEFT",
    "DATA_EXFILTRATION",
    "DNS_EXFIL",
    "ENV_VARS",
    "NETWORK",
    "NPM_TOKEN_ABUSE",
    "TELEMETRY_RAT",
  ]),
  "untrusted-code-execution": new Set([
    "ARBITRARY_CODE_EXECUTION",
    "BINARY_DOWNLOAD",
    "BUILD_PLUGIN_EXFIL",
    "ENCRYPTED_PAYLOAD",
    "EVAL",
    "LIFECYCLE_HOOK",
    "OBFUSCATION",
    "PROCESS_SPAWN",
    "WORM_PROPAGATION",
  ]),
  "download-execute-chain": new Set([
    "ARBITRARY_CODE_EXECUTION",
    "BINARY_DOWNLOAD",
    "BUILD_PLUGIN_EXFIL",
    "ENCRYPTED_PAYLOAD",
    "EVAL",
    "LIFECYCLE_HOOK",
    "OBFUSCATION",
    "PROCESS_SPAWN",
    "WORM_PROPAGATION",
  ]),
  "destructive-filesystem-impact": new Set([
    "FILESYSTEM",
    "GEO_GATING",
    "WORM_PROPAGATION",
  ]),
  "victim-value-hijacked": new Set([
    "CLIPBOARD_HIJACK",
    "DOM_INJECT",
  ]),
  "dos-risk-path": new Set(["DOS_LOOP"]),
  "persistence-impact": new Set(["FILESYSTEM", "LIFECYCLE_HOOK", "PERSISTENCE"]),
  "supply-chain-propagation": new Set([
    "LIFECYCLE_HOOK",
    "NPM_TOKEN_ABUSE",
    "WORM_PROPAGATION",
  ]),
  "obfuscated-execution": new Set([
    "ARBITRARY_CODE_EXECUTION",
    "BINARY_DOWNLOAD",
    "ENCRYPTED_PAYLOAD",
    "EVAL",
    "LIFECYCLE_HOOK",
    "OBFUSCATION",
    "PROCESS_SPAWN",
  ]),
};

function rejected(reason: string, signals: string[] = []): ProofQualityAssessment {
  return { accepted: false, reason, signals };
}

function rejectedFinding(
  reason: string,
  signals: string[] = [],
): FindingQualityAssessment {
  return { accepted: false, reason, signals };
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function conciseEvidence(value: string, fallback: string): string {
  const normalized = normalizedText(value || fallback);
  return normalized.length <= 280 ? normalized : `${normalized.slice(0, 277)}...`;
}

function humanCapability(capability: string | null | undefined): string {
  const normalized = (capability ?? "security issue").trim();
  return normalized
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

const SECURITY_SIGNAL_LABELS: Record<string, string> = {
  "secret-to-outbound-sink": "sensitive data reaches an outbound channel",
  "untrusted-code-execution": "untrusted input reaches a code-execution sink",
  "download-execute-chain": "a remote payload is downloaded and executed",
  "destructive-filesystem-impact": "files or directories can be destructively modified",
  "victim-value-hijacked": "a victim-controlled value can be replaced or injected",
  "reproducible-dos-impact": "a denial-of-service condition is reproducible",
  "dos-risk-path": "user-controlled input may trigger excessive processing",
  "persistence-impact": "the package attempts to persist on the host",
  "supply-chain-propagation": "the package can propagate through package publishing",
  "obfuscated-execution": "obfuscated or encoded content reaches an execution sink",
  "runtime-security-impact": "runtime instrumentation observed a concrete security impact",
  "canary-crossed-sink": "the planted canary crossed a security boundary",
  "dangerous-process-chain": "a dangerous process chain was executed",
  "download-write-execute-chain": "a payload was downloaded, written, and executed",
};

function securitySignalSummary(signals: string[]): string {
  const labels = signals.map((signal) => SECURITY_SIGNAL_LABELS[signal] ?? signal);
  return labels.join("; ");
}

function capabilitySupportsSignal(capability: string, signal: string): boolean {
  const allowed = CAPABILITIES_BY_SIGNAL[signal];
  if (!allowed) return true;
  const capabilities = capability
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return capabilities.some((value) => allowed.has(value));
}

/**
 * Admission gate for LLM investigation findings.
 *
 * A capability is not suspicious by itself: wallets use localStorage, build
 * tools load modules, and CLIs spawn processes. A finding is reportable only
 * when its evidence describes a concrete source-to-impact path. Explicitly
 * benign, meta-analysis-only, and test-fixture observations are discarded.
 */
export function assessFindingQuality(finding: Finding): FindingQualityAssessment {
  const problem = normalizedText(finding.problem);
  const evidence = normalizedText(finding.evidence);
  const strategy = normalizedText(finding.reproductionStrategy);
  const text = `${problem} ${evidence} ${strategy}`.trim();

  if (!problem && !evidence) {
    return rejectedFinding("finding has no concrete problem or evidence");
  }

  if (EXPLICITLY_BENIGN_FINDING.some((pattern) => pattern.test(text))) {
    return rejectedFinding("finding explicitly describes expected or benign behavior");
  }

  if (META_ANALYSIS_ONLY.some((pattern) => pattern.test(text))) {
    return rejectedFinding("finding repeats model or triage metadata instead of package evidence");
  }

  if (TEST_ONLY_LOCATION.test(finding.fileLine)) {
    return rejectedFinding("finding is confined to package tests or fixtures");
  }

  if (
    CALLER_MANUFACTURES_ATTACK.test(strategy) &&
    !CONCRETE_RUNTIME_OBSERVATION.test(evidence)
  ) {
    return rejectedFinding(
      "reproduction requires the caller to manufacture the malicious input",
    );
  }

  if (
    COUNTERFACTUAL_EXTERNAL_COMPROMISE.test(text) &&
    !CONCRETE_RUNTIME_OBSERVATION.test(evidence)
  ) {
    return rejectedFinding(
      "finding assumes an external service or caller is already compromised",
    );
  }

  const signals: string[] = [];
  if (
    SECRET_TARGET.test(text) &&
    SECRET_EXFILTRATION_OUTCOME.test(text) &&
    capabilitySupportsSignal(finding.capability, "secret-to-outbound-sink")
  ) {
    signals.push("secret-to-outbound-sink");
  }
  if (
    EXECUTION_SINK.test(text) &&
    UNTRUSTED_SOURCE.test(text) &&
    SOURCE_TO_SINK_FLOW.test(text) &&
    capabilitySupportsSignal(finding.capability, "untrusted-code-execution")
  ) {
    signals.push("untrusted-code-execution");
  }
  if (
    DOWNLOAD_EXECUTE_OUTCOME.test(text) &&
    capabilitySupportsSignal(finding.capability, "download-execute-chain")
  ) {
    signals.push("download-execute-chain");
  }
  if (
    DESTRUCTIVE_OUTCOME.test(text) &&
    capabilitySupportsSignal(finding.capability, "destructive-filesystem-impact")
  ) {
    signals.push("destructive-filesystem-impact");
  }
  if (
    HIJACK_OUTCOME.test(text) &&
    capabilitySupportsSignal(finding.capability, "victim-value-hijacked")
  ) {
    signals.push("victim-value-hijacked");
  }
  if (
    DOS_OUTCOME.test(text) &&
    capabilitySupportsSignal(finding.capability, "dos-risk-path")
  ) {
    signals.push("dos-risk-path");
  }
  if (
    PERSISTENCE_OUTCOME.test(text) &&
    capabilitySupportsSignal(finding.capability, "persistence-impact")
  ) {
    signals.push("persistence-impact");
  }
  if (
    PROPAGATION_OUTCOME.test(text) &&
    capabilitySupportsSignal(finding.capability, "supply-chain-propagation")
  ) {
    signals.push("supply-chain-propagation");
  }
  if (
    OBFUSCATED_EXECUTION_OUTCOME.test(text) &&
    capabilitySupportsSignal(finding.capability, "obfuscated-execution")
  ) {
    signals.push("obfuscated-execution");
  }
  if (
    finding.confidence === "CONFIRMED" &&
    CONCRETE_RUNTIME_OBSERVATION.test(evidence) &&
    signals.length > 0
  ) {
    signals.push("runtime-security-impact");
  }

  if (signals.length === 0) {
    return rejectedFinding(
      "finding names a capability but does not show a concrete source-to-impact path",
    );
  }

  return {
    accepted: true,
    reason: securitySignalSummary(signals),
    signals,
  };
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

function assessmentEvidenceFromProof(
  proof: Proof,
  source: AuditAssessmentEvidence["source"],
  reason: string,
): AuditAssessmentEvidence {
  return {
    source,
    capability: proof.capability,
    fileLine: proof.fileLine,
    reason,
    evidence: conciseEvidence(proof.evidence, proof.problem),
  };
}

function assessmentEvidenceFromFinding(
  finding: Finding,
  assessment: FindingQualityAssessment,
): AuditAssessmentEvidence {
  return {
    source: "analysis",
    capability: finding.capability,
    fileLine: finding.fileLine,
    reason: assessment.reason,
    evidence: conciseEvidence(finding.evidence, finding.problem),
  };
}

function structuralDealbreakerReason(proof: Proof): string {
  return proof.problem
    ? `Install-time shell execution confirmed: ${normalizedText(proof.problem)}`
    : "Install-time shell execution confirmed: downloaded content is piped directly into a shell.";
}

function confirmedProofReason(proof: Proof): string {
  const quality = assessGeneratedTestProofQuality(proof.testCode, proof.capability);
  const impact = securitySignalSummary(quality.signals);
  const location = proof.fileLine ? ` at ${proof.fileLine}` : "";
  return `Sandbox exploit reproduced${location}: ${impact || humanCapability(proof.capability)}.`;
}

function proofAsFinding(proof: Proof): Finding {
  return {
    capability: proof.capability ?? "UNKNOWN",
    confidence: proof.confidence,
    fileLine: proof.fileLine,
    problem: proof.problem,
    evidence: proof.evidence,
    reproductionStrategy: proof.reproductionCmd ?? "",
  };
}

/**
 * Rich, explainable classification used by repository scans and report APIs.
 *
 * DANGEROUS requires an admitted sandbox reproducer or the narrow deterministic
 * shell-pipe inventory rule. SUSPECT requires at least one actionable finding
 * with a concrete source-to-impact path. A persisted report represents a
 * completed audit, so when every emitted signal is rejected and no exploit was
 * reproduced the result is SAFE. UNKNOWN is reserved by scan callers for
 * packages with no completed report (missing, failed, or interrupted audits).
 */
export function assessAuditReport(
  report: Pick<AuditReport, "verdict" | "proofs" | "findings">,
): AuditAssessment {
  const structuralProofs = report.proofs.filter(isStructuralDealbreaker);
  const confirmedProofs = report.proofs.filter(isHighQualityConfirmedProof);

  if (structuralProofs.length > 0 || confirmedProofs.length > 0) {
    const evidence = [
      ...structuralProofs.map((proof) =>
        assessmentEvidenceFromProof(
          proof,
          "inventory",
          structuralDealbreakerReason(proof),
        ),
      ),
      ...confirmedProofs.map((proof) =>
        assessmentEvidenceFromProof(
          proof,
          "sandbox",
          confirmedProofReason(proof),
        ),
      ),
    ];
    const primary = evidence[0]!;
    return {
      classification: "DANGEROUS",
      summary: primary.reason,
      evidence,
      rejectedSignalCount: Math.max(
        0,
        report.findings.length + report.proofs.length - evidence.length,
      ),
    };
  }

  const findingAssessments = report.findings.map((finding) => ({
    finding,
    assessment: assessFindingQuality(finding),
  }));
  const acceptedFindings = findingAssessments.filter(({ assessment }) => assessment.accepted);

  const standaloneProofAssessments = report.proofs
    .filter((proof) => proof.kind === "AI_STATIC" || proof.kind === "AI_DYNAMIC")
    .map((proof) => ({
      proof,
      assessment: assessFindingQuality(proofAsFinding(proof)),
    }))
    .filter(({ assessment }) => assessment.accepted);

  if (acceptedFindings.length > 0 || standaloneProofAssessments.length > 0) {
    const evidence = [
      ...acceptedFindings.map(({ finding, assessment }) =>
        assessmentEvidenceFromFinding(finding, assessment),
      ),
      ...standaloneProofAssessments.map(({ proof, assessment }) =>
        assessmentEvidenceFromProof(proof, "analysis", assessment.reason),
      ),
    ];
    const primary = evidence[0]!;
    const location = primary.fileLine ? ` at ${primary.fileLine}` : "";
    return {
      classification: "SUSPECT",
      summary: `Potential ${humanCapability(primary.capability)}${location}: ${primary.reason}. Sandbox reproduction is still required.`,
      evidence,
      rejectedSignalCount:
        findingAssessments.filter(({ assessment }) => !assessment.accepted).length +
        report.proofs.length -
        standaloneProofAssessments.length,
    };
  }

  return {
    classification: "SAFE",
    summary:
      "Audit completed with no actionable security finding or admitted exploit proof. Weak or benign-looking signals were rejected.",
    evidence: [],
    rejectedSignalCount: report.findings.length + report.proofs.length,
  };
}

/**
 * Compatibility wrapper for callers that only need the four-state verdict.
 * AuditReport.verdict remains the legacy SAFE/DANGEROUS transport field until
 * every client supports the richer vocabulary.
 */
export function classifyAuditReport(
  report: Pick<AuditReport, "verdict" | "proofs" | "findings">,
): AuditClassification {
  return assessAuditReport(report).classification;
}
