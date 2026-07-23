import { z } from "zod";
import { HypothesisCountsSchema, HypothesisSeveritySchema, HypothesisStateSchema, ClaimKindSchema } from "./graph.js";
import { FileRecordSchema, FileVerdictSchema, FindingSchema, VerdictSchema } from "./models.js";

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

const TriageHypothesisSchema = z.object({
  hypId: z.string(),
  claim: ClaimKindSchema,
  severity: HypothesisSeveritySchema,
  description: z.string(),
});

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

export const AgentToolCallEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("agent_tool_call"),
  tool: z.string(),
  args: z.record(z.unknown()),
  step: z.number().int(),
});
export type AgentToolCallEvent = z.infer<typeof AgentToolCallEventSchema>;

export const AgentToolResultEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("agent_tool_result"),
  tool: z.string(),
  resultPreview: z.string(),
  step: z.number().int(),
  injectionDetected: z.boolean(),
});
export type AgentToolResultEvent = z.infer<typeof AgentToolResultEventSchema>;

export const AgentReasoningEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("agent_reasoning"),
  text: z.string(),
  step: z.number().int(),
});
export type AgentReasoningEvent = z.infer<typeof AgentReasoningEventSchema>;

export const AgentThinkingEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("agent_thinking"),
  step: z.number().int(),
});
export type AgentThinkingEvent = z.infer<typeof AgentThinkingEventSchema>;

export const FindingDiscoveredEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("finding_discovered"),
  finding: FindingSchema,
});
export type FindingDiscoveredEvent = z.infer<typeof FindingDiscoveredEventSchema>;

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

export const InventoryMetaEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("inventory_meta"),
  scripts: z.record(z.string()),
  dependencies: z.record(z.record(z.string())),
  entryPoints: z.object({
    install: z.array(z.string()),
    runtime: z.array(z.string()),
    bin: z.array(z.string()),
  }),
  metadata: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
    description: z.string().nullable(),
    license: z.string().nullable(),
  }),
});
export type InventoryMetaEvent = z.infer<typeof InventoryMetaEventSchema>;

export const VerifyStartedEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("verify_started"),
  totalTests: z.number().int().nonnegative(),
});
export type VerifyStartedEvent = z.infer<typeof VerifyStartedEventSchema>;

export const VerifyTestResultEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("verify_test_result"),
  proofIndex: z.number().int().nonnegative(),
  testFile: z.string(),
  status: z.enum(["confirmed", "unconfirmed", "infra_error"]),
  error: z.string().optional(),
});
export type VerifyTestResultEvent = z.infer<typeof VerifyTestResultEventSchema>;

export const AuditErrorEventSchema = BaseAuditEventSchema.extend({
  type: z.literal("audit_error"),
  error: z.string().optional(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type AuditErrorEvent = z.infer<typeof AuditErrorEventSchema>;

export const AuditEventSchema = z.discriminatedUnion("type", [
  AuditStartedEventSchema,
  AuditEnqueuedEventSchema,
  PhaseStartedEventSchema,
  PhaseCompletedEventSchema,
  FileListEventSchema,
  FileAnalyzingEventSchema,
  FileVerdictEventSchema,
  TriageCompleteEventSchema,
  TriageProgressEventSchema,
  AgentToolCallEventSchema,
  AgentToolResultEventSchema,
  AgentReasoningEventSchema,
  AgentThinkingEventSchema,
  FindingDiscoveredEventSchema,
  HypothesisEmittedEventSchema,
  HypothesisResolvedEventSchema,
  VerdictReachedEventSchema,
  InventoryMetaEventSchema,
  VerifyStartedEventSchema,
  VerifyTestResultEventSchema,
  AuditErrorEventSchema,
]);
export type AuditEventUnion = z.infer<typeof AuditEventSchema>;

export const EVENT_TYPES = [
  "audit_started",
  "audit_enqueued",
  "phase_started",
  "phase_completed",
  "file_list",
  "file_analyzing",
  "file_verdict",
  "triage_complete",
  "triage_progress",
  "agent_tool_call",
  "agent_tool_result",
  "agent_reasoning",
  "agent_thinking",
  "finding_discovered",
  "hypothesis_emitted",
  "hypothesis_resolved",
  "verdict_reached",
  "inventory_meta",
  "verify_started",
  "verify_test_result",
  "audit_error",
] as const;

export type AuditEventType = (typeof EVENT_TYPES)[number];
export type EmitFn = (type: string, payload: Record<string, unknown>) => void;
