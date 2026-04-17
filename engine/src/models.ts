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

export const NetworkCall = z.object({
  method: z.string(),
  url: z.string(),
  bodyPreview: z.string().default(""),
});
export type NetworkCall = z.infer<typeof NetworkCall>;

export const FsOperation = z.object({
  op: z.string(),
  path: z.string(),
  preview: z.string().default(""),
});
export type FsOperation = z.infer<typeof FsOperation>;

export const ProcessSpawn = z.object({
  cmd: z.string(),
  args: z.array(z.string()).default([]),
});
export type ProcessSpawn = z.infer<typeof ProcessSpawn>;

export const EvalCall = z.object({
  code: z.string(),
});
export type EvalCall = z.infer<typeof EvalCall>;

export const CryptoOp = z.object({
  method: z.string(),
  algo: z.string(),
});
export type CryptoOp = z.infer<typeof CryptoOp>;

export const TimerRecord = z.object({
  type: z.string(),
  ms: z.number(),
  source: z.string().default(""),
});
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
export type InstrumentationLog = z.infer<typeof InstrumentationLog>;

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
