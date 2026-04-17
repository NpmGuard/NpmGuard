import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums — cross-process audit vocabulary
// ---------------------------------------------------------------------------

export const VerdictEnum = z.enum(["SAFE", "DANGEROUS"]);
export type VerdictEnum = z.infer<typeof VerdictEnum>;

export const CapabilityEnum = z.enum([
  // Network / exfiltration
  "NETWORK",
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
export type CapabilityEnum = z.infer<typeof CapabilityEnum>;

export const Confidence = z.enum(["SUSPECTED", "LIKELY", "CONFIRMED"]);
export type Confidence = z.infer<typeof Confidence>;

export const ProofKind = z.enum([
  "STRUCTURAL",
  "AI_STATIC",
  "AI_DYNAMIC",
  "TEST_CONFIRMED",
  "TEST_UNCONFIRMED",
]);
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
export type AttackPathway = z.infer<typeof AttackPathway>;

export const Severity = z.enum(["info", "warn", "critical"]);
export type Severity = z.infer<typeof Severity>;

// ---------------------------------------------------------------------------
// Cross-process data models — sent over SSE or HTTP to non-engine consumers
// ---------------------------------------------------------------------------

export const FocusArea = z.object({
  file: z.string(),
  lines: z.string().nullable().default(null),
  reason: z.string(),
});
export type FocusArea = z.infer<typeof FocusArea>;

export const TriageResult = z.object({
  riskScore: z.number().int().min(0).max(10),
  riskSummary: z.string(),
  focusAreas: z.array(FocusArea).default([]),
});
export type TriageResult = z.infer<typeof TriageResult>;

export const FileVerdict = z.object({
  file: z.string(),
  capabilities: z.array(z.string()).default([]),
  suspiciousPatterns: z.array(z.string()).default([]),
  suspiciousLines: z.string().nullable().default(null),
  summary: z.string(),
  riskContribution: z.number().int().min(0).max(10),
});
export type FileVerdict = z.infer<typeof FileVerdict>;

export const Finding = z.object({
  capability: z.string().describe("CapabilityEnum value, e.g. 'NETWORK'"),
  confidence: Confidence,
  fileLine: z.string().describe("e.g. 'lib/index.js:42-67'"),
  problem: z.string().describe("Human-readable description of the threat"),
  evidence: z.string().describe("Concrete data or observation"),
  reproductionStrategy: z.string().default("").describe("How to prove this in a reproducible test"),
});
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
export type Proof = z.infer<typeof Proof>;

export const FileRecord = z.object({
  path: z.string(),
  fileType: z.string(),
  sizeBytes: z.number(),
  permissions: z.string(),
  isBinary: z.boolean(),
  binaryType: z.string().nullable().default(null),
});
export type FileRecord = z.infer<typeof FileRecord>;
