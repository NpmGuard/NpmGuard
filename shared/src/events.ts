import { z } from "zod";
import {
  ClaimKindSchema,
  FocusRangeSchema,
  HypothesisCountsSchema,
  HypothesisSeveritySchema,
  HypothesisStateSchema,
} from "./graph.js";
import { FileRecordSchema, FileVerdictSchema, VerdictSchema } from "./models.js";
import { PackageMetadataSchema } from "./backend.js";
import {
  BudgetSchema,
  DisplayObservationSchema,
  EvidenceRefSchema,
  ObserveFlagsSchema,
  RunDisplaySchema,
  ToolCallSchema,
  TriggerSchema,
} from "./evidence.js";

// The replay vocabulary this contract describes. Format 2 added the experiment,
// sandbox and judgment boundaries that make an audit stream a causal record
// rather than a progress log.
//
// It is stamped on `audit_started` and it is a HARD cut, not a negotiation: a
// stream below it carries no experiment events, so there is nothing for a rich
// replay to fold and nothing to infer them from. A consumer reads the number and
// either folds the stream or says it cannot — it never reconstructs.
export const REPLAY_FORMAT = 2;

export const BaseAuditEventSchema = z.object({
  auditId: z.string(),
  timestamp: z.string(),
  seq: z.number().int().nonnegative(),
});
export type BaseAuditEvent = z.infer<typeof BaseAuditEventSchema>;

// `replayVersion` DEFAULTS rather than pins, and the difference is the whole
// hard-cut mechanism. A durable log written by an older engine still parses —
// it is a real frame that really happened, and failing it would turn every
// archived audit into a contract violation. It folds as version 1, which no rich
// replay accepts, so the stream lands on the unsupported-replay state instead of
// being animated out of data it does not carry.
export const AuditStartedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("audit_started"),
  packageName: z.string(),
  replayVersion: z.number().int().positive().default(1),
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

// A suspicion, as the stream states it. Every field is already on the engine's
// `Hypothesis` — this event used to project four of them and drop the rest,
// which is why the old UI could say "cred_theft in setup.js" and nothing about
// WHICH lines were suspected.
//
// `focusLines` is required and non-empty in practice: an evidence graph draws
// each hypothesis edge from a highlighted source range, so a hypothesis with no
// range has nowhere to come from. That is a PRODUCER defect — the schema carries
// the field and the consumer reports the gap; neither invents a line number.
// (The single-file `file` field is gone: it was `focusFiles[0]` restated, and two
// spellings of one fact drift.)
export const HypothesisEmittedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("hypothesis_emitted"),
  hypId: z.string(),
  claim: ClaimKindSchema,
  severity: HypothesisSeveritySchema,
  description: z.string(),
  focusFiles: z.array(z.string()).default([]),
  focusLines: z.array(FocusRangeSchema).default([]),
});
export type HypothesisEmittedEvent = z.infer<typeof HypothesisEmittedEventSchema>;

// The terminal state of one hypothesis, WITH the proof it rests on.
//
// `citedObservations` is not a duplicate of `sandbox_completed.observations`: the
// judge had not run when that frame was emitted, so a cited row may have fallen
// outside its display bound. Carrying the cited rows here is what makes
// "a confirmed verdict points back at the exact events" total rather than
// usually-true. The frontend merges by `eventId`.
//
// `runId` is null exactly when no run backs the state — a hypothesis deferred
// before dispatch (budget exhausted) has no experiment to point at.
export const HypothesisResolvedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("hypothesis_resolved"),
  hypId: z.string(),
  claim: ClaimKindSchema,
  severity: HypothesisSeveritySchema,
  state: HypothesisStateSchema,
  by: z.string(),
  reason: z.string(),
  evidenceRefs: z.array(EvidenceRefSchema).default([]),
  citedEventIds: z.array(z.string()).default([]),
  citedObservations: z.array(DisplayObservationSchema).default([]),
  runId: z.string().nullable().default(null),
});
export type HypothesisResolvedEvent = z.infer<typeof HypothesisResolvedEventSchema>;

// ---------------------------------------------------------------------------
// Experiment boundaries — the four frames that make the investigation legible.
//
// They expose the shape of work the orchestrator ALREADY does, one frame per
// boundary, so a viewer sees a hypothesis become a plan, a plan become a run,
// and a run become a judgment. They decide nothing: removing all four leaves
// every verdict byte-identical.
//
// Order per hypothesis is fixed (experiment → sandbox_started → sandbox_completed
// → judgment_started → hypothesis_resolved) and a hypothesis that never reaches
// dispatch emits none of them.
// ---------------------------------------------------------------------------

export const ExperimentStartedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("experiment_started"),
  hypId: z.string(),
  runId: z.string(),
  // The ordered tool calls the hypothesis armed, with engine-minted canary
  // values replaced by a label. These are the ENGINE's and the model's strings,
  // never the package's.
  experiment: z.array(ToolCallSchema).default([]),
  trigger: TriggerSchema,
});
export type ExperimentStartedEvent = z.infer<typeof ExperimentStartedEventSchema>;

export const SandboxStartedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("sandbox_started"),
  hypId: z.string(),
  runId: z.string(),
  observe: ObserveFlagsSchema,
  budget: BudgetSchema,
});
export type SandboxStartedEvent = z.infer<typeof SandboxStartedEventSchema>;

export const SandboxCompletedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("sandbox_completed"),
  hypId: z.string(),
  run: RunDisplaySchema,
});
export type SandboxCompletedEvent = z.infer<typeof SandboxCompletedEventSchema>;

// Emitted before the judge model call. It is the only frame that can honestly
// say "the evidence is now being weighed" — a viewer otherwise sees a completed
// run sit still for the length of a model round-trip with nothing to read.
export const JudgmentStartedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("judgment_started"),
  hypId: z.string(),
  runId: z.string(),
});
export type JudgmentStartedEvent = z.infer<typeof JudgmentStartedEventSchema>;

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
// Emitted by pipeline.py, and present in every committed SSE skeleton.
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

// A hypothesis that was announced while `hypothesize` armed it, then folded into
// an existing node because the two ask the same question of the same run. It
// never runs, so it never resolves.
//
// The pairing is what keeps that from reading as a lost suspicion: without it a
// consumer watches a hypothesis appear and stay open for ever, which is exactly
// what a dropped one looks like. `into` is the node whose run answers both.
export const HypothesisMergeSchema = z.object({
  hypId: z.string(),
  into: z.string(),
});
export type HypothesisMerge = z.infer<typeof HypothesisMergeSchema>;

export const GraphBuiltEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("graph_built"),
  nodeCount: z.number().int().nonnegative(),
  addedCount: z.number().int().nonnegative(),
  mergedCount: z.number().int().nonnegative(),
  merges: z.array(HypothesisMergeSchema).default([]),
});
export type GraphBuiltEvent = z.infer<typeof GraphBuiltEventSchema>;

// All three fields are always supplied, non-null, by every emit site in
// service.py — so they are required, not optional.
export const AuditErrorEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("audit_error"),
  error: z.string(),
  code: z.string(),
  retryable: z.boolean(),
});
export type AuditErrorEvent = z.infer<typeof AuditErrorEventSchema>;

// EXACTLY the types the engine can emit. Verified against every emit site
// (AuditEmitter.emit, service.py's terminal append, and demo replay) and against
// the committed SSE skeletons. A member with no emit site does not belong here:
// it costs a dead SSE listener, a dead fold arm, and a reader who has to
// re-derive that it is dead.
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
  ExperimentStartedEventSchema,
  SandboxStartedEventSchema,
  SandboxCompletedEventSchema,
  JudgmentStartedEventSchema,
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
  "experiment_started",
  "sandbox_started",
  "sandbox_completed",
  "judgment_started",
  "hypothesis_resolved",
  "verdict_reached",
  "audit_error",
] as const;

export type AuditEventType = (typeof EVENT_TYPES)[number];

// The per-hypothesis frames, in the order the orchestrator emits them. The
// engine asserts it against its own emit sequence and the frontend fold uses it
// to know an experiment chain is complete; stating it once keeps the two from
// disagreeing about what a finished investigation looks like.
export const HYPOTHESIS_EVENT_ORDER = [
  "hypothesis_emitted",
  "experiment_started",
  "sandbox_started",
  "sandbox_completed",
  "judgment_started",
  "hypothesis_resolved",
] as const;
export type EmitFn = (type: string, payload: Record<string, unknown>) => void;
