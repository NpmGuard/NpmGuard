import { z } from "zod";

// Shared cross-process types — single source of truth lives in @npmguard/shared.
// Re-exported so existing engine imports of `./models.js` continue to resolve.
export {
  // Enums
  VerdictEnum,
  CapabilityEnum,
  Confidence,
  ProofKind,
  AttackPathway,
  Severity,
  // Models
  FocusArea,
  TriageResult,
  FileVerdict,
  Finding,
  Proof,
  FileRecord,
  // Instrumentation
  NetworkCall,
  FsOperation,
  ProcessSpawn,
  EvalCall,
  CryptoOp,
  TimerRecord,
  InstrumentationLog,
} from "@npmguard/shared";

import {
  VerdictEnum,
  CapabilityEnum,
  Confidence,
  Severity,
  FocusArea,
  TriageResult,
  FileVerdict,
  Finding,
  Proof,
  FileRecord,
  InstrumentationLog,
} from "@npmguard/shared";

// ---------------------------------------------------------------------------
// Investigation — engine-internal, not sent over the wire
// ---------------------------------------------------------------------------

export const InvestigationInput = z.object({
  packagePath: z.string(),
  packageName: z.string().default(""),
  version: z.string().default(""),
  description: z.string().default(""),
  flags: z.array(z.string()).default([]),
  staticCaps: z.array(z.string()).default([]),
  staticProofSummaries: z.array(z.string()).default([]),
  // Populated before the agent runs by an early observation pass
  // (require + lifecycle hooks under instrumentation). Lets the agent see
  // runtime evidence (network, eval, fs, env) up front instead of grinding
  // chunked-evalJs against obfuscated bundles to discover the same facts.
  runtimeObservation: InstrumentationLog.nullable().default(null),
});
export type InvestigationInput = z.infer<typeof InvestigationInput>;

export const InvestigationOutput = z.object({
  findings: z.array(Finding).default([]),
  summary: z.string().default(""),
});
export type InvestigationOutput = z.infer<typeof InvestigationOutput>;

export const ToolCallRecord = z.object({
  tool: z.string(),
  args: z.record(z.unknown()),
  resultPreview: z.string().default(""),
  timestamp: z.string().default(() => new Date().toISOString()),
  injectionDetected: z.boolean().default(false),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecord>;

/** Extended output from the agent runner — includes tool call trace for observability. */
export const InvestigationAgentOutput = InvestigationOutput.extend({
  toolCalls: z.array(ToolCallRecord).default([]),
  agentText: z.string().default(""),
});
export type InvestigationAgentOutput = z.infer<typeof InvestigationAgentOutput>;

// ---------------------------------------------------------------------------
// Instrumentation — dynamic analysis observations, engine-internal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Report — sent to consumers via /audit/:id/report, but only a subset of its
// fields is referenced by the frontend (verdict, capabilities, proofs, findings).
// The `trace` (PhaseLog) field is engine-internal detail.
// ---------------------------------------------------------------------------

export const PhaseLog = z.object({
  phase: z.string(),
  durationMs: z.number(),
  input: z.record(z.unknown()).default({}),
  output: z.record(z.unknown()).default({}),
});
export type PhaseLog = z.infer<typeof PhaseLog>;

export const AuditReport = z.object({
  verdict: VerdictEnum,
  capabilities: z.array(CapabilityEnum).default([]),
  proofs: z.array(Proof).default([]),
  triage: TriageResult.nullable().default(null),
  findings: z.array(Finding).default([]),
  trace: z.array(PhaseLog).default([]),
  runtimeEvidence: InstrumentationLog.nullable().default(null),
});
export type AuditReport = z.infer<typeof AuditReport>;

export const ResolvedPackage = z.object({
  path: z.string(),
  needsCleanup: z.boolean().default(false),
  tmpdir: z.string().nullable().default(null),
});
export type ResolvedPackage = z.infer<typeof ResolvedPackage>;

// ---------------------------------------------------------------------------
// Inventory — engine-internal Phase 0 output
// ---------------------------------------------------------------------------

export const InventoryFlag = z.object({
  severity: Severity,
  check: z.string(),
  detail: z.string(),
  file: z.string().nullable().default(null),
});
export type InventoryFlag = z.infer<typeof InventoryFlag>;

export const DealBreaker = z.object({
  check: z.string(),
  detail: z.string(),
});
export type DealBreaker = z.infer<typeof DealBreaker>;

export const EntryPoints = z.object({
  install: z.array(z.string()),
  runtime: z.array(z.string()),
  bin: z.array(z.string()),
});
export type EntryPoints = z.infer<typeof EntryPoints>;

export const PackageMetadata = z.object({
  name: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  license: z.string().nullable().default(null),
  homepage: z.string().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  repository: z.unknown().default(null),
});
export type PackageMetadata = z.infer<typeof PackageMetadata>;

export const InventoryReport = z.object({
  metadata: PackageMetadata,
  scripts: z.record(z.string()),
  entryPoints: EntryPoints,
  dependencies: z.record(z.record(z.string())),
  files: z.array(FileRecord),
  flags: z.array(InventoryFlag),
  dealbreaker: DealBreaker.nullable().default(null),
});
export type InventoryReport = z.infer<typeof InventoryReport>;
