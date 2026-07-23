import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums — cross-process audit vocabulary
// ---------------------------------------------------------------------------

// The verdict of a COMPLETED audit. DANGEROUS ⟺ a CONFIRMED hypothesis (cited
// dynamic proof) and blocks an install; SAFE ⟺ every suspicion ran and showed no
// malice (presumption of innocence). An audit that cannot complete is not a
// verdict — it is a retryable AuditIncompleteError, so "we couldn't check" can
// never leak out as a result.
export const VerdictEnum = z.enum(["SAFE", "DANGEROUS"]);
export const VerdictSchema = VerdictEnum;
export type VerdictEnum = z.infer<typeof VerdictEnum>;

export const CapabilityEnum = z.enum([
  // Network / exfiltration
  "NETWORK",
  "DATA_EXFILTRATION",
  "DNS_EXFIL",
  "DOM_INJECT",
  // Filesystem / OS
  "FILESYSTEM",
  "BINARY_DOWNLOAD",
  "PROCESS_SPAWN",
  // Credential & environment theft
  "ENV_VARS",
  "CREDENTIAL_THEFT",
  // Code execution tricks
  "EVAL",
  "OBFUSCATION",
  "ENCRYPTED_PAYLOAD",
  // Availability
  "DOS_LOOP",
  // Anti-analysis
  "ANTI_AI_PROMPT",
  "GEO_GATING",
  // Lifecycle abuse
  "LIFECYCLE_HOOK",
  // Supply-chain propagation
  "WORM_PROPAGATION",
  "CLIPBOARD_HIJACK",
  "TELEMETRY_RAT",
  "BUILD_PLUGIN_EXFIL",
  "NPM_TOKEN_ABUSE",
]);
export const CapabilitySchema = CapabilityEnum;
export type CapabilityEnum = z.infer<typeof CapabilityEnum>;

export const Confidence = z.enum(["SUSPECTED", "LIKELY", "CONFIRMED"]);
export const ConfidenceSchema = Confidence;
export type Confidence = z.infer<typeof Confidence>;

export const ProofKind = z.enum([
  "STRUCTURAL",
  "AI_STATIC",
  "AI_DYNAMIC",
  "TEST_CONFIRMED",
  "TEST_UNCONFIRMED",
]);
export const ProofKindSchema = ProofKind;
export type ProofKind = z.infer<typeof ProofKind>;

export const AttackPathway = z.enum([
  "DEP_INJECT_ENCRYPTED",
  "LIFECYCLE_BINARY_DROP",
  "MAINTAINER_SABOTAGE",
  "GEO_GATED_WIPER",
  "WORM_PROPAGATION",
  "ACCOUNT_TAKEOVER_CRYPTO",
  "CDN_DOM_DRAINER",
  "MULTI_STAGE_DNS",
  "TELEMETRY_RAT",
  "BUILD_PLUGIN_EXFIL",
]);
export const AttackPathwaySchema = AttackPathway;
export type AttackPathway = z.infer<typeof AttackPathway>;

export const Severity = z.enum(["info", "warn", "critical"]);
export const SeveritySchema = Severity;
export type Severity = z.infer<typeof Severity>;

// ---------------------------------------------------------------------------
// Cross-process data models — sent over SSE or HTTP to non-engine consumers
// ---------------------------------------------------------------------------

export const FocusArea = z.object({
  file: z.string(),
  // .optional() (not .nullable) so the JSON Schema sent to LLMs is `type: "string"`
  // instead of `type: ["string","null"]` — MiniMax rejects union types.
  lines: z.string().optional(),
  reason: z.string(),
});
export const FocusAreaSchema = FocusArea;
export type FocusArea = z.infer<typeof FocusArea>;

export const TriageResult = z.object({
  riskScore: z.number().int().min(0).max(10),
  riskSummary: z.string(),
  focusAreas: z.array(FocusArea).default([]),
});
export const TriageResultSchema = TriageResult;
export type TriageResult = z.infer<typeof TriageResult>;

export const FileVerdict = z.object({
  file: z.string(),
  capabilities: z.array(z.string()).default([]),
  suspiciousPatterns: z.array(z.string()).default([]),
  // .optional() (not .nullable) — MiniMax rejects union types like ["string","null"].
  suspiciousLines: z.string().optional(),
  summary: z.string(),
  riskContribution: z.number().int().min(0).max(10),
});
export const FileVerdictSchema = FileVerdict;
export type FileVerdict = z.infer<typeof FileVerdict>;

// One-line per-file summary emitted by triage MAP. Carried on the report so
// the frontend code-viewer can label files without re-deriving from hypotheses.
export const FileSummary = z.object({
  file: z.string(),
  summary: z.string().default(""),
  capabilities: z.array(z.string()).default([]),
});
export const FileSummarySchema = FileSummary;
export type FileSummary = z.infer<typeof FileSummary>;

export const Finding = z.object({
  // Defaults are friendly to non-deterministic LLM outputs (MiniMax sometimes
  // omits a field). The triage/investigation outputs are still meaningful even
  // when one descriptive field is empty — better than failing the whole audit.
  capability: z.string().default("UNKNOWN").describe("CapabilityEnum value, e.g. 'NETWORK'"),
  confidence: Confidence.default("SUSPECTED"),
  fileLine: z.string().default("").describe("e.g. 'lib/index.js:42-67'"),
  problem: z.string().default("").describe("Human-readable description of the threat"),
  evidence: z.string().default("").describe("Concrete data or observation"),
  reproductionStrategy: z.string().default("").describe("How to prove this in a reproducible test"),
});
export const FindingSchema = Finding;
export type Finding = z.infer<typeof Finding>;

export const Proof = z.object({
  capability: CapabilityEnum.nullable().default(null),
  attackPathway: z.string().default(""),
  confidence: Confidence.default("SUSPECTED"),

  fileLine: z.string(),
  problem: z.string(),
  evidence: z.string(),

  kind: ProofKind.default("STRUCTURAL"),
  contentHash: z.string().nullable().default(null),

  reproducible: z.boolean().default(false),
  reproductionCmd: z.string().nullable().default(null),

  testFile: z.string().nullable().default(null),
  testHash: z.string().nullable().default(null),
  testCode: z.string().nullable().default(null),
  verifyError: z.string().nullable().default(null),

  reasoningHash: z.string().nullable().default(null),
  teeAttestationId: z.string().nullable().default(null),
});
export const ProofSchema = Proof;
export type Proof = z.infer<typeof Proof>;

export const FileRecord = z.object({
  path: z.string(),
  fileType: z.string(),
  sizeBytes: z.number(),
  permissions: z.string(),
  isBinary: z.boolean(),
  binaryType: z.string().nullable().default(null),
});
export const FileRecordSchema = FileRecord;
export type FileRecord = z.infer<typeof FileRecord>;

// ---------------------------------------------------------------------------
// Instrumentation — runtime observations captured during sandbox execution.
// Aggregated and exposed at AuditReport level so UI consumers can render
// "what the package actually did" alongside static findings.
// ---------------------------------------------------------------------------

export const NetworkCall = z.object({
  method: z.string(),
  url: z.string(),
  bodyPreview: z.string().default(""),
});
export const NetworkCallSchema = NetworkCall;
export type NetworkCall = z.infer<typeof NetworkCall>;

export const FsOperation = z.object({
  op: z.string(),
  path: z.string(),
  preview: z.string().default(""),
});
export const FsOperationSchema = FsOperation;
export type FsOperation = z.infer<typeof FsOperation>;

export const ProcessSpawn = z.object({
  cmd: z.string(),
  args: z.array(z.string()).default([]),
});
export const ProcessSpawnSchema = ProcessSpawn;
export type ProcessSpawn = z.infer<typeof ProcessSpawn>;

export const EvalCall = z.object({
  code: z.string(),
});
export const EvalCallSchema = EvalCall;
export type EvalCall = z.infer<typeof EvalCall>;

export const CryptoOp = z.object({
  method: z.string(),
  algo: z.string(),
});
export const CryptoOpSchema = CryptoOp;
export type CryptoOp = z.infer<typeof CryptoOp>;

export const TimerRecord = z.object({
  type: z.string(),
  ms: z.number(),
  source: z.string().default(""),
});
export const TimerRecordSchema = TimerRecord;
export type TimerRecord = z.infer<typeof TimerRecord>;

export const InstrumentationLog = z.object({
  modulesLoaded: z.array(z.string()).default([]),
  networkCalls: z.array(NetworkCall).default([]),
  fsOperations: z.array(FsOperation).default([]),
  envAccess: z.array(z.string()).default([]),
  processSpawns: z.array(ProcessSpawn).default([]),
  evalCalls: z.array(EvalCall).default([]),
  cryptoOps: z.array(CryptoOp).default([]),
  timers: z.array(TimerRecord).default([]),
});
export const InstrumentationLogSchema = InstrumentationLog;
export type InstrumentationLog = z.infer<typeof InstrumentationLog>;
