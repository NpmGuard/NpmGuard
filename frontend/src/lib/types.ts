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
  Confidence,
  ProofKind,
  AttackPathway,
  AuditEventUnion as SSEEvent,
  EmitFn,
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

import type { Finding, Proof } from "@npmguard/shared";

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

/** Shared proof-verification counts used by VerdictBanner and CompletionItem. */
export function computeProofStats(findings: Finding[], proofs: Proof[]) {
  const verified = findings.filter((_, i) => proofs[i]?.kind === "TEST_CONFIRMED").length;
  const observed = findings.filter((_, i) => proofs[i]?.kind === "AI_DYNAMIC").length;
  const dealbreaker = proofs.find(
    (p) => p.kind === "STRUCTURAL" && p.evidence?.startsWith("Dealbreaker:"),
  );
  return { verified, observed, rest: findings.length - verified - observed, dealbreaker };
}

export function parseLineRanges(spec: string | null): Array<[number, number]> {
  if (!spec) return [];
  return spec.split(",").map((range) => {
    const parts = range.trim().split("-").map(Number);
    if (parts.length === 1) return [parts[0], parts[0]] as [number, number];
    return [parts[0], parts[1]] as [number, number];
  });
}
