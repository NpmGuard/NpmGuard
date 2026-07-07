// Cross-process audit types — single source of truth lives in @npmguard/shared.
// Re-exported here so existing frontend imports from "./lib/types" keep working.
export type {
  FileRecord,
  FileVerdict,
  FocusArea,
  Finding,
  Proof,
  TriageResult,
  VerdictEnum,
  CapabilityEnum,
  Hypothesis,
  HypothesisCounts,
  HypothesisState,
  HypothesisSeverity,
  ClaimKind,
  EvidenceRef,
  Confidence,
  ProofKind,
  AttackPathway,
  InstrumentationLog,
  NetworkCall,
  FsOperation,
  ProcessSpawn,
  EvalCall,
  CryptoOp,
  TimerRecord,
  AuditEventUnion as SSEEvent,
  EmitFn,
  HypothesisEmittedEvent,
  HypothesisResolvedEvent,
  AuditStartedEvent,
  PhaseStartedEvent,
  PhaseCompletedEvent,
  FileListEvent,
  FileAnalyzingEvent,
  FileVerdictEvent,
  TriageCompleteEvent,
  TriageProgressEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentReasoningEvent,
  AgentThinkingEvent,
  FindingDiscoveredEvent,
  VerdictReachedEvent,
  InventoryMetaEvent,
  VerifyStartedEvent,
  VerifyTestResultEvent,
  AuditErrorEvent,
} from "@npmguard/shared";

import type {
  VerdictEnum,
  ClaimKind,
  HypothesisState,
  HypothesisSeverity,
  HypothesisCounts,
} from "@npmguard/shared";

// ---------------------------------------------------------------------------
// Engine v2 — 4-state verdict + hypothesis-graph display helpers
// ---------------------------------------------------------------------------

/** Lightweight hypothesis record built from the `hypothesis_emitted` /
 *  `hypothesis_resolved` SSE stream. The full `Hypothesis` shape only arrives
 *  with the fetched report; this is what the live activity feed renders. */
export interface LiveHypothesis {
  hypId: string;
  claim: ClaimKind;
  severity: HypothesisSeverity;
  file?: string;
  state: HypothesisState;
  by?: string;
  reason?: string;
}

export interface VerdictDisplay {
  label: string;
  color: string; // CSS custom property
  bg: string; // CSS custom property
  note: string; // one-line descriptor of what the verdict means
  /** UNKNOWN is a COVERAGE GAP — surface it loudly, never as a quiet pass. */
  isCoverageGap: boolean;
}

/** Map the 4-state verdict to a distinct, honest visual treatment.
 *  SAFE→green, DANGEROUS→red, SUSPECT→amber, UNKNOWN→amber + coverage-gap note. */
export function verdictDisplay(verdict: VerdictEnum | null | undefined): VerdictDisplay {
  switch (verdict) {
    case "SAFE":
      return { label: "SAFE", color: "var(--safe)", bg: "var(--safe-bg)", note: "No malicious behavior found", isCoverageGap: false };
    case "DANGEROUS":
      return { label: "DANGEROUS", color: "var(--danger)", bg: "var(--danger-bg)", note: "Confirmed malicious behavior", isCoverageGap: false };
    case "SUSPECT":
      return { label: "SUSPECT", color: "var(--suspected)", bg: "var(--suspected-bg)", note: "Suspicious hypotheses left unresolved", isCoverageGap: false };
    case "UNKNOWN":
      return { label: "UNKNOWN", color: "var(--warning)", bg: "var(--suspected-bg)", note: "Coverage gap — could not confirm or refute", isCoverageGap: true };
    default:
      return { label: "PENDING", color: "var(--text-muted)", bg: "var(--bg-secondary)", note: "Analysis in progress", isCoverageGap: false };
  }
}

export interface HypStateMeta {
  label: string;
  color: string;
  bg: string;
  order: number;
  /** Non-terminal / unproven states — coverage gaps that must stay visible. */
  isGap: boolean;
}

/** Per-state visual treatment + sort order (CONFIRMED first, REFUTED last). */
export const HYP_STATE_META: Record<HypothesisState, HypStateMeta> = {
  CONFIRMED: { label: "Confirmed", color: "var(--danger)", bg: "var(--danger-bg)", order: 0, isGap: false },
  IN_PROGRESS: { label: "In progress", color: "var(--investigating)", bg: "var(--investigating-bg)", order: 1, isGap: true },
  OPEN: { label: "Open", color: "var(--suspected)", bg: "var(--suspected-bg)", order: 2, isGap: true },
  INCONCLUSIVE: { label: "Inconclusive", color: "var(--warning)", bg: "var(--suspected-bg)", order: 3, isGap: true },
  DEFERRED: { label: "Deferred", color: "var(--text-muted)", bg: "var(--bg-tertiary)", order: 4, isGap: true },
  REFUTED: { label: "Refuted", color: "var(--safe)", bg: "var(--safe-bg)", order: 5, isGap: false },
};

const HYP_SEVERITY_COLOR: Record<HypothesisSeverity, string> = {
  critical: "var(--danger)",
  high: "var(--danger)",
  medium: "var(--suspected)",
  low: "var(--text-muted)",
};

export function hypSeverityColor(severity: HypothesisSeverity): string {
  return HYP_SEVERITY_COLOR[severity] ?? "var(--text-muted)";
}

/** "env_exfil" → "Env exfil" — human label for a claim kind. */
export function claimKindLabel(kind: ClaimKind | string): string {
  return String(kind)
    .split("_")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Compact per-state tally, e.g. "2 confirmed · 3 refuted · 1 inconclusive". */
export function countsSummary(counts: HypothesisCounts | null | undefined): string {
  if (!counts) return "";
  const parts: string[] = [];
  if (counts.confirmed) parts.push(`${counts.confirmed} confirmed`);
  if (counts.refuted) parts.push(`${counts.refuted} refuted`);
  if (counts.inconclusive) parts.push(`${counts.inconclusive} inconclusive`);
  if (counts.open) parts.push(`${counts.open} open`);
  if (counts.inProgress) parts.push(`${counts.inProgress} in progress`);
  if (counts.deferred) parts.push(`${counts.deferred} deferred`);
  if (parts.length === 0) return `${counts.total} hypothes${counts.total === 1 ? "is" : "es"}`;
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Frontend-only UI state types
// ---------------------------------------------------------------------------

export type FileStatus = "pending" | "analyzing" | "safe" | "suspicious" | "dangerous";

export type PhaseStatus = "pending" | "active" | "done";

export interface PhaseInfo {
  name: string;
  durationMs?: number;
  status: PhaseStatus;
}

export interface AgentStep {
  type: "tool_call" | "tool_result" | "reasoning";
  tool?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  text?: string;
  step: number;
  timestamp: string;
  injectionDetected?: boolean;
}

export interface PipelineLogEntry {
  kind: "phase" | "info" | "file-scan" | "file-flag" | "scripts";
  text: string;
  file?: string;
  risk?: number;
  timestamp: string;
  scripts?: Record<string, string>;
}

/** Inventory payload mirrored from the `inventory_meta` SSE event —
 *  held in the audit store as a piece of state. */
export interface InventoryMeta {
  scripts: Record<string, string>;
  dependencies: Record<string, Record<string, string>>;
  entryPoints: { install: string[]; runtime: string[]; bin: string[] };
  metadata: { name: string | null; version: string | null; description: string | null; license: string | null };
}

// ---------------------------------------------------------------------------
// Frontend-only constants and helpers
// ---------------------------------------------------------------------------

export const PHASE_ORDER = ["resolve", "inventory", "triage", "investigation", "test-gen", "verify"] as const;

export const LIFECYCLE_SCRIPTS: string[] = ["preinstall", "install", "postinstall", "prepare", "prepack"];

export const RISK_SUSPICIOUS_THRESHOLD = 3;
export const RISK_DANGEROUS_THRESHOLD = 5;

export function riskContributionToStatus(risk: number): FileStatus {
  if (risk >= RISK_DANGEROUS_THRESHOLD) return "dangerous";
  if (risk >= RISK_SUSPICIOUS_THRESHOLD) return "suspicious";
  return "safe";
}

export const AUDIT_PATH_RE = /^\/audit\/([0-9a-f-]{36})$/;

export const PHASE_LABELS: Record<string, string> = {
  resolve: "Resolving package",
  inventory: "Scanning package structure",
  triage: "Analyzing source files",
  investigation: "Starting deep investigation",
  "test-gen": "Generating exploit tests",
  verify: "Running verification",
};

/** Labels shown for quiet (non-agent) phases in the activity feed */
export const PHASE_WAIT_LABELS: Record<string, string> = {
  resolve: "Downloading and unpacking...",
  inventory: "Building file inventory...",
  triage: "Analyzing source files...",
  investigation: "Agent is investigating...",
  "test-gen": "Generating exploit tests...",
  verify: "Running verification in sandbox...",
};

/** Extract the file path from a "file:line" string. */
export function fileFromFileLine(fileLine: string): string | undefined {
  return fileLine.split(":")[0] || undefined;
}

/** Type-safe extraction of the `path` arg from a readFile tool call. */
export function readFileArg(args?: Record<string, unknown>): string | undefined {
  const path = args?.path;
  return typeof path === "string" ? path : undefined;
}

export function parseLineRanges(spec: string | null | undefined): Array<[number, number]> {
  if (!spec) return [];
  return spec
    .split(",")
    .map((range) => {
      const parts = range.trim().split("-").map(Number);
      if (parts.length === 1) return [parts[0], parts[0]] as [number, number];
      return [parts[0], parts[1]] as [number, number];
    })
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && a >= 1);
}
