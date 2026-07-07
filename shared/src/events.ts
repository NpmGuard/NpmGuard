import type { FileRecord, FileVerdict, Finding, VerdictEnum } from "./models.js";
import type { ClaimKind, HypothesisCounts, HypothesisSeverity, HypothesisState } from "./graph.js";

// ---------------------------------------------------------------------------
// Base — every SSE event carries these fields
// ---------------------------------------------------------------------------

export interface BaseAuditEvent {
  auditId: string;
  timestamp: string;
  /** Buffer index assigned when the event is pushed onto the session buffer.
   *  Stable, unique per session, monotonic. */
  seq: number;
}

// ---------------------------------------------------------------------------
// Individual event payloads — kept flat; each event's `type` narrows the union
// ---------------------------------------------------------------------------

export interface AuditStartedEvent extends BaseAuditEvent {
  type: "audit_started";
  packageName: string;
}

export interface PhaseStartedEvent extends BaseAuditEvent {
  type: "phase_started";
  phase: string;
}

export interface PhaseCompletedEvent extends BaseAuditEvent {
  type: "phase_completed";
  phase: string;
  durationMs: number;
}

export interface FileListEvent extends BaseAuditEvent {
  type: "file_list";
  files: FileRecord[];
}

export interface FileAnalyzingEvent extends BaseAuditEvent {
  type: "file_analyzing";
  file: string;
}

export interface FileVerdictEvent extends BaseAuditEvent {
  type: "file_verdict";
  verdict: FileVerdict;
}

export interface TriageCompleteEvent extends BaseAuditEvent {
  type: "triage_complete";
  hypothesisCount: number;
  hypotheses: Array<{
    hypId: string;
    claim: ClaimKind;
    severity: HypothesisSeverity;
    description: string;
  }>;
}

export interface TriageProgressEvent extends BaseAuditEvent {
  type: "triage_progress";
  current: number;
  total: number;
  file: string;
}

export interface AgentToolCallEvent extends BaseAuditEvent {
  type: "agent_tool_call";
  tool: string;
  args: Record<string, unknown>;
  step: number;
}

export interface AgentToolResultEvent extends BaseAuditEvent {
  type: "agent_tool_result";
  tool: string;
  resultPreview: string;
  step: number;
  injectionDetected: boolean;
}

export interface AgentReasoningEvent extends BaseAuditEvent {
  type: "agent_reasoning";
  text: string;
  step: number;
}

export interface AgentThinkingEvent extends BaseAuditEvent {
  type: "agent_thinking";
  step: number;
}

export interface FindingDiscoveredEvent extends BaseAuditEvent {
  type: "finding_discovered";
  finding: Finding;
}

export interface HypothesisEmittedEvent extends BaseAuditEvent {
  type: "hypothesis_emitted";
  hypId: string;
  claim: ClaimKind;
  severity: HypothesisSeverity;
  file: string;
}

export interface HypothesisResolvedEvent extends BaseAuditEvent {
  type: "hypothesis_resolved";
  hypId: string;
  claim: ClaimKind;
  severity: HypothesisSeverity;
  /** Terminal state the orchestrator moved the hypothesis into. */
  state: HypothesisState;
  /** Worker that resolved it: "worker:experimenter" | "worker:code-reader" | "orchestrator". */
  by: string;
  reason: string;
}

export interface VerdictReachedEvent extends BaseAuditEvent {
  type: "verdict_reached";
  verdict: VerdictEnum;
  /** One-line explanation suitable for a report header. */
  rationale: string;
  counts: HypothesisCounts;
  /** Number of CONFIRMED hypotheses (each backed by a RunArtifact). */
  confirmedCount: number;
}

export interface InventoryMetaEvent extends BaseAuditEvent {
  type: "inventory_meta";
  scripts: Record<string, string>;
  dependencies: Record<string, Record<string, string>>;
  entryPoints: { install: string[]; runtime: string[]; bin: string[] };
  metadata: {
    name: string | null;
    version: string | null;
    description: string | null;
    license: string | null;
  };
}

export interface VerifyStartedEvent extends BaseAuditEvent {
  type: "verify_started";
  totalTests: number;
}

export interface VerifyTestResultEvent extends BaseAuditEvent {
  type: "verify_test_result";
  proofIndex: number;
  testFile: string;
  status: "confirmed" | "unconfirmed" | "infra_error";
  error?: string;
}

export interface AuditErrorEvent extends BaseAuditEvent {
  type: "audit_error";
  error?: string;
  code?: string;
  retryable?: boolean;
}

// ---------------------------------------------------------------------------
// Discriminated union — consumers narrow on `type`
// ---------------------------------------------------------------------------

export type AuditEventUnion =
  | AuditStartedEvent
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | FileListEvent
  | FileAnalyzingEvent
  | FileVerdictEvent
  | TriageCompleteEvent
  | TriageProgressEvent
  | AgentToolCallEvent
  | AgentToolResultEvent
  | AgentReasoningEvent
  | AgentThinkingEvent
  | FindingDiscoveredEvent
  | HypothesisEmittedEvent
  | HypothesisResolvedEvent
  | VerdictReachedEvent
  | InventoryMetaEvent
  | VerifyStartedEvent
  | VerifyTestResultEvent
  | AuditErrorEvent;

/** Canonical list of SSE event-type names — useful for addEventListener wiring. */
export const EVENT_TYPES = [
  "audit_started",
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

// ---------------------------------------------------------------------------
// Emit signature — deliberately loose on the producer side so ad-hoc events
// (e.g., verify_attempt, verify_regenerating) can be emitted without a typed
// interface. Consumers narrow via AuditEventUnion.
// ---------------------------------------------------------------------------

export type EmitFn = (type: string, payload: Record<string, unknown>) => void;
