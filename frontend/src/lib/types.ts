/** Frontend-only domain types and constants (not part of the wire contract). */

export type FileStatus = "pending" | "analyzing" | "safe" | "suspicious" | "dangerous";

export type PhaseStatus = "pending" | "active" | "done";

export interface PhaseInfo {
  name: string;
  status: PhaseStatus;
  durationMs?: number;
}

export interface AgentStep {
  type: "tool_call" | "tool_result" | "reasoning";
  step: number;
  timestamp: string;
  tool?: string;
  args?: Record<string, unknown>;
  resultPreview?: string;
  text?: string;
  injectionDetected?: boolean;
}

export interface PipelineLogEntry {
  kind: "phase" | "info" | "file-scan" | "file-flag" | "scripts" | "hypothesis";
  text: string;
  timestamp: string;
  file?: string;
  risk?: number;
  scripts?: Record<string, string>;
}

/** Dev pipeline phases in order (engine/npmguard/pipeline.py `_timed_phase`
 * names + the manually-emitted "orchestrator"). */
export const PHASE_ORDER = [
  "resolve",
  "inventory",
  "intent-extraction",
  "flag",
  "hypothesize",
  "orchestrator",
] as const;

export const PHASE_LABELS: Record<string, string> = {
  resolve: "Resolving package",
  inventory: "Scanning package structure",
  "intent-extraction": "Reading the package's stated intent",
  flag: "Analyzing source files",
  hypothesize: "Forming & compiling hypotheses",
  orchestrator: "Running experiments in the sandbox",
};

export const PHASE_WAIT_LABELS: Record<string, string> = {
  resolve: "Downloading and unpacking…",
  inventory: "Building the file inventory…",
  "intent-extraction": "Reading what the package claims to do…",
  flag: "Reading source files for suspicious capability…",
  hypothesize: "Compiling falsifiable experiments…",
  orchestrator: "Executing experiments under the full oracle…",
};

export const LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare", "prepack"];

export const RISK_SUSPICIOUS_THRESHOLD = 3;
export const RISK_DANGEROUS_THRESHOLD = 5;

export function riskContributionToStatus(risk: number): FileStatus {
  if (risk >= RISK_DANGEROUS_THRESHOLD) return "dangerous";
  if (risk >= RISK_SUSPICIOUS_THRESHOLD) return "suspicious";
  return "safe";
}

/** "lib/index.js:42-67" → "lib/index.js" */
export function fileFromFileLine(fileLine: string): string {
  const first = fileLine.split(",")[0] ?? fileLine;
  const colon = first.lastIndexOf(":");
  return (colon > 0 ? first.slice(0, colon) : first).trim();
}

/** readFile tool args → path, when present and a string */
export function readFileArg(args: Record<string, unknown> | undefined): string | null {
  const path = args?.["path"];
  return typeof path === "string" ? path : null;
}

/** "12-14, 20" → [[12,14],[20,20]]; garbage segments are dropped. */
export function parseLineRanges(input: string | null | undefined): [number, number][] {
  if (!input) return [];
  const out: [number, number][] = [];
  for (const seg of input.split(",")) {
    const m = seg.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m || !m[1]) continue;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) out.push([start, end]);
  }
  return out;
}

/** "pkg@1.0.0" | "@scope/pkg@1.0.0" | "pkg" → {name, version}. Uses the last
 * "@" so scoped names survive. */
export function parsePackageInput(raw: string): { name: string; version: string | null } {
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf("@");
  if (at > 0) {
    return { name: trimmed.slice(0, at), version: trimmed.slice(at + 1) || null };
  }
  return { name: trimmed, version: null };
}
