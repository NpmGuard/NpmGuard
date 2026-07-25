import { z } from "zod";
import { HypothesisCountsSchema, HypothesisSeveritySchema, HypothesisStateSchema, ClaimKindSchema } from "./graph.js";
import { FileRecordSchema, FileVerdictSchema, VerdictSchema } from "./models.js";
import { PackageMetadataSchema } from "./backend.js";

export const BaseAuditEventSchema = z.object({
  auditId: z.string(),
  timestamp: z.string(),
  seq: z.number().int().nonnegative(),
});
export type BaseAuditEvent = z.infer<typeof BaseAuditEventSchema>;

export const AuditStartedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("audit_started"),
  packageName: z.string(),
});
export type AuditStartedEvent = z.infer<typeof AuditStartedEventSchema>;

export const AuditEnqueuedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("audit_enqueued"),
  queuePosition: z.number().int().nonnegative(),
});
export type AuditEnqueuedEvent = z.infer<typeof AuditEnqueuedEventSchema>;

export const PhaseStartedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("phase_started"),
  phase: z.string(),
});
export type PhaseStartedEvent = z.infer<typeof PhaseStartedEventSchema>;

export const PhaseCompletedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("phase_completed"),
  phase: z.string(),
  durationMs: z.number(),
});
export type PhaseCompletedEvent = z.infer<typeof PhaseCompletedEventSchema>;

export const FileListEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("file_list"),
  files: z.array(FileRecordSchema),
});
export type FileListEvent = z.infer<typeof FileListEventSchema>;

export const FileAnalyzingEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("file_analyzing"),
  file: z.string(),
});
export type FileAnalyzingEvent = z.infer<typeof FileAnalyzingEventSchema>;

export const FileVerdictEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("file_verdict"),
  verdict: FileVerdictSchema,
});
export type FileVerdictEvent = z.infer<typeof FileVerdictEventSchema>;

// Exported so contract-export.ts emits it as a named $def. While it was a
// bare const the exporter inlined it and datamodel-codegen named the generated
// class `Hypothes`.
export const TriageHypothesisSchema = z.object({
  hypId: z.string(),
  claim: ClaimKindSchema,
  severity: HypothesisSeveritySchema,
  description: z.string(),
});
export type TriageHypothesis = z.infer<typeof TriageHypothesisSchema>;

export const TriageCompleteEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("triage_complete"),
  hypothesisCount: z.number().int().nonnegative(),
  hypotheses: z.array(TriageHypothesisSchema),
});
export type TriageCompleteEvent = z.infer<typeof TriageCompleteEventSchema>;

export const TriageProgressEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("triage_progress"),
  current: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  file: z.string(),
});
export type TriageProgressEvent = z.infer<typeof TriageProgressEventSchema>;

export const HypothesisEmittedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("hypothesis_emitted"),
  hypId: z.string(),
  claim: ClaimKindSchema,
  severity: HypothesisSeveritySchema,
  file: z.string(),
});
export type HypothesisEmittedEvent = z.infer<typeof HypothesisEmittedEventSchema>;

export const HypothesisResolvedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("hypothesis_resolved"),
  hypId: z.string(),
  claim: ClaimKindSchema,
  severity: HypothesisSeveritySchema,
  state: HypothesisStateSchema,
  by: z.string(),
  reason: z.string(),
});
export type HypothesisResolvedEvent = z.infer<typeof HypothesisResolvedEventSchema>;

export const VerdictReachedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("verdict_reached"),
  verdict: VerdictSchema,
  rationale: z.string(),
  counts: HypothesisCountsSchema,
  confirmedCount: z.number().int().nonnegative(),
});
export type VerdictReachedEvent = z.infer<typeof VerdictReachedEventSchema>;

// The four npm dependency groups the engine actually emits (inventory.py). KEYED
// deliberately: while this was `z.record(z.record(z.string()))` the frontend read
// `dependencies["dependencies"]`/`["devDependencies"]` — never present — and the
// UI reported "0 prod · 0 dev" for every package. An unkeyed map cannot catch that.
export const DependencyGroupsSchema = z.object({
  prod: z.record(z.string()).default({}),
  dev: z.record(z.string()).default({}),
  optional: z.record(z.string()).default({}),
  peer: z.record(z.string()).default({}),
});
export type DependencyGroups = z.infer<typeof DependencyGroupsSchema>;

export const InventoryMetaEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("inventory_meta"),
  scripts: z.record(z.string()),
  dependencies: DependencyGroupsSchema,
  entryPoints: z.object({
    install: z.array(z.string()),
    runtime: z.array(z.string()),
    bin: z.array(z.string()),
  }),
  // The engine emits a full PackageMetadata (7 fields); an inline 4-field object
  // silently dropped homepage/keywords/repository.
  metadata: PackageMetadataSchema,
});
export type InventoryMetaEvent = z.infer<typeof InventoryMetaEventSchema>;

// ---------------------------------------------------------------------------
// Emitted by the engine but previously unschematised — present in every
// committed SSE skeleton (pipeline.py:193, :278, :359).
// ---------------------------------------------------------------------------

export const DependenciesProvisionedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("dependencies_provisioned"),
  installed: z.boolean(),
  packageCount: z.number().int().nonnegative(),
  skipped: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type DependenciesProvisionedEvent = z.infer<typeof DependenciesProvisionedEventSchema>;

export const IntentExtractedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("intent_extracted"),
  statedPurpose: z.string(),
  expectedCapabilities: z.array(z.string()).default([]),
});
export type IntentExtractedEvent = z.infer<typeof IntentExtractedEventSchema>;

export const GraphBuiltEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("graph_built"),
  nodeCount: z.number().int().nonnegative(),
  addedCount: z.number().int().nonnegative(),
  mergedCount: z.number().int().nonnegative(),
});
export type GraphBuiltEvent = z.infer<typeof GraphBuiltEventSchema>;

// All three fields are always supplied, non-null, by every emit site
// (service.py:184, :246, :315) — so they are required, not optional.
export const AuditErrorEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("audit_error"),
  error: z.string(),
  code: z.string(),
  retryable: z.boolean(),
});
export type AuditErrorEvent = z.infer<typeof AuditErrorEventSchema>;

// EXACTLY the 17 types the engine can emit. Verified against every emit site
// (AuditEmitter.emit, service.py's terminal append, and demo replay) and against
// the committed SSE skeletons. Seven previously-declared members
// (agent_thinking/agent_tool_call/agent_tool_result/agent_reasoning/
// finding_discovered/verify_started/verify_test_result) had ZERO emit sites and
// were deleted: an unreachable member costs a dead SSE listener, a dead fold arm,
// and a reader who must re-derive that it is dead.
export const AuditEventSchema = z.discriminatedUnion("type", [
  AuditStartedEventSchema,
  AuditEnqueuedEventSchema,
  PhaseStartedEventSchema,
  PhaseCompletedEventSchema,
  DependenciesProvisionedEventSchema,
  FileListEventSchema,
  InventoryMetaEventSchema,
  IntentExtractedEventSchema,
  FileAnalyzingEventSchema,
  TriageProgressEventSchema,
  HypothesisEmittedEventSchema,
  FileVerdictEventSchema,
  TriageCompleteEventSchema,
  GraphBuiltEventSchema,
  HypothesisResolvedEventSchema,
  VerdictReachedEventSchema,
  AuditErrorEventSchema,
]);
export type AuditEventUnion = z.infer<typeof AuditEventSchema>;

// Pipeline order — this drives per-name SSE listener registration, so a name
// here that the engine never emits is a permanently dead listener.
export const EVENT_TYPES = [
  "audit_enqueued",
  "audit_started",
  "phase_started",
  "phase_completed",
  "dependencies_provisioned",
  "file_list",
  "inventory_meta",
  "intent_extracted",
  "file_analyzing",
  "triage_progress",
  "hypothesis_emitted",
  "file_verdict",
  "triage_complete",
  "graph_built",
  "hypothesis_resolved",
  "verdict_reached",
  "audit_error",
] as const;

export type AuditEventType = (typeof EVENT_TYPES)[number];
export type EmitFn = (type: string, payload: Record<string, unknown>) => void;
