/**
 * Pure helpers over the schemaVersion-2 AuditReport (dev / Python engine).
 * The report is hypotheses + counts — there are no `proofs[]`. A DANGEROUS
 * verdict is backed by CONFIRMED hypotheses; SAFE means everything REFUTED (or
 * nothing to prove).
 */

import type {
  AuditReport,
  ClaimKind,
  Hypothesis,
  HypothesisState,
  Verdict,
} from "./engine-types.ts";

export const CLAIM_LABELS: Record<ClaimKind, string> = {
  env_exfil: "Environment exfiltration",
  cred_theft: "Credential theft",
  binary_drop: "Binary drop",
  obfuscation: "Obfuscation",
  persistence: "Persistence",
  destructive: "Destructive action",
  propagation: "Self-propagation",
  dos_loop: "Denial-of-service loop",
  clipboard_hijack: "Clipboard hijack",
  dom_inject: "DOM injection",
  telemetry: "Covert telemetry",
  dns_exfil: "DNS exfiltration",
  build_plugin_exfil: "Build-plugin exfiltration",
};

export const STATE_LABELS: Record<HypothesisState, string> = {
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  CONFIRMED: "Confirmed",
  REFUTED: "Refuted",
  DEFERRED: "Deferred",
};

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function claimLabel(claim: ClaimKind | string): string {
  return CLAIM_LABELS[claim as ClaimKind] ?? claim;
}

export function verdictTone(verdict: Verdict): "safe" | "danger" {
  return verdict === "DANGEROUS" ? "danger" : "safe";
}

export function bySeverityDesc<T extends { severity: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
}

export function hypothesesInState(report: AuditReport, state: HypothesisState): Hypothesis[] {
  return report.hypotheses.filter((h) => h.state === state);
}

/** The CONFIRMED hypotheses — the evidence that produced a DANGEROUS verdict,
 * most severe first. */
export function confirmedHypotheses(report: AuditReport): Hypothesis[] {
  const confirmed = new Set(report.confirmedHypIds);
  const list = report.hypotheses.filter((h) => h.state === "CONFIRMED" || confirmed.has(h.hypId));
  return bySeverityDesc(list);
}

/** Distinct capabilities observed across the analyzed files (fileSummaries). */
export function capabilitiesFromReport(report: AuditReport): string[] {
  const seen = new Set<string>();
  for (const summary of report.fileSummaries) {
    for (const cap of summary.capabilities ?? []) if (cap) seen.add(cap);
  }
  return [...seen];
}

/** Files that carried at least one capability, most-capable first — the ones
 * worth surfacing in a SAFE report ("here's what we looked at"). */
export function notableFiles(report: AuditReport): AuditReport["fileSummaries"] {
  return report.fileSummaries
    .filter((f) => (f.capabilities?.length ?? 0) > 0)
    .sort((a, b) => (b.capabilities?.length ?? 0) - (a.capabilities?.length ?? 0));
}

export function totalTraceMs(report: AuditReport): number {
  return report.trace.reduce((sum, phase) => sum + (phase.durationMs || 0), 0);
}

/** A one-line, honest headline for the verdict. Never fabricates counts. */
export function verdictHeadline(report: AuditReport): string {
  if (report.verdict === "DANGEROUS") {
    if (report.dealbreaker) return report.dealbreaker.check;
    const n = report.confirmedHypIds.length || confirmedHypotheses(report).length;
    return n > 0
      ? `${n} confirmed threat${n === 1 ? "" : "s"}`
      : "Confirmed malicious behavior";
  }
  return "No known threats";
}
