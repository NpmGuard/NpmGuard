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
  VerdictEnum,
} from "@npmguard/shared";

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

export function verdictTone(verdict: VerdictEnum): "safe" | "danger" {
  return verdict === "DANGEROUS" ? "danger" : "safe";
}

/* ── hypothesis colour: STATE decides, severity only modulates ──────────────
 *
 * A hypothesis severity is the severity of a CLAIM — "if this were true, it
 * would be critical". It is authored before anything is tested. Colouring the
 * row by severity alone therefore painted a REFUTED critical hypothesis in full
 * danger red, with a red CRITICAL tag: the investigation's own conclusion was
 * "this did not happen", and the UI shouted the opposite. On a package with 1
 * confirmed and 13 refuted hypotheses, that is thirteen red rows around the one
 * that matters.
 *
 * Red is reserved for a claim NpmGuard is MAKING about the package, so severity
 * gets to carry a hue only where the claim stands (CONFIRMED). Everywhere else
 * the severity tag is neutral — not hidden, because "we tested a critical claim"
 * is worth knowing, just not worth alarming about.
 *
 *   CONFIRMED  → the threat is real: `danger`
 *   DEFERRED   → could not be decided: `error` violet, and PROMINENT
 *   REFUTED    → tested, did not happen: neutral row, `safe` state stamp
 *   OPEN / IN_PROGRESS → the progress axis, which is never a verdict
 *
 * TWO CHANGES ON THE MOVE TO THE TOKEN LAYER, both forced by the design brief
 * rather than by taste:
 *
 * 1. There is no amber. The v3 semantic set is exactly {safe, danger, error,
 *    accent} (§2.2), so the old `--suspect` arm for a CONFIRMED-medium claim has
 *    no slot. It resolves to `danger`: a confirmed medium finding IS a finding,
 *    and severity keeps modulating the SEVERITY CHIP rather than the row hue.
 *    That is the same "state decides, severity modulates" rule, expressed in a
 *    palette that has one alarm colour instead of two.
 *
 * 2. DEFERRED stops being grey. Brief §3.3 is explicit that DEFERRED is "a
 *    first-class, prominent state ... styled as a real outcome in `error` hue,
 *    not as a greyed-out afterthought", because F-I5 says showing what the tool
 *    CANNOT prove is as persuasive as a catch. It also puts DEFERRED in the same
 *    violet slot as audit ERROR and as UI degradation, which is correct: all
 *    three mean *we don't know*, and that is exactly one fact.
 */

/** The tone a hypothesis carries, from its STATE alone. */
export type HypothesisTone = "danger" | "error" | "safe" | "progress";

export function hypothesisTone(state: HypothesisState): HypothesisTone {
  switch (state) {
    case "CONFIRMED":
      return "danger";
    case "DEFERRED":
      return "error";
    case "REFUTED":
      return "safe";
    case "OPEN":
    case "IN_PROGRESS":
      return "progress";
  }
}

/** The 3px left rule (§2.8) a hypothesis card wears, or `undefined`.
 *
 * Only the two states that mean something actionable earn a rule. REFUTED does
 * not: §0 rule 1 makes SAFE the quietest state, and a green-ruled card for every
 * disproved worry is thirteen rules around the one that matters — the same
 * mistake the old severity colouring made, in a different channel. */
export function hypothesisRule(state: HypothesisState): "danger" | "error" | undefined {
  const tone = hypothesisTone(state);
  return tone === "danger" || tone === "error" ? tone : undefined;
}

/** The severity chip's tone. Neutral unless the claim it qualifies STANDS —
 * severity modulates a real finding, it never manufactures one. */
export function hypothesisSeverityTone(
  state: HypothesisState,
  severity: string,
): "danger" | "neutral" {
  if (state !== "CONFIRMED") return "neutral";
  return severity === "critical" || severity === "high" ? "danger" : "neutral";
}

/** Severity-only order. Module-private: it is the right sort for a list that is
 * already ONE state (`confirmedHypotheses`), and the wrong one everywhere else —
 * see `byImportanceDesc`. */
function bySeverityDesc<T extends { severity: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
}

/* ── importance = the same two axes the colour rule reads ───────────────────
 *
 * Severity alone is the wrong sort for the same reason it was the wrong colour:
 * it ranks a claim nobody has tested. Sorting by it put thirteen refuted
 * CRITICALs above the one CONFIRMED finding, so the reader had to scroll past
 * every disproved worry to reach the actual threat.
 *
 * State first, severity within it. The rank mirrors `panel/tone.tsx`'s
 * `depPriority`, and the load-bearing line is the same one: something we could
 * NOT decide outranks something still being decided, because a DEFERRED
 * hypothesis needs a human and a live one resolves itself.
 */
const STATE_RANK: Record<HypothesisState, number> = {
  CONFIRMED: 0, // a real finding
  DEFERRED: 1, // could not be decided — needs a human
  IN_PROGRESS: 2, // being decided
  OPEN: 3, // not started
  REFUTED: 4, // tested, did not happen — the least urgent thing on the page
};

/** Most important first: CONFIRMED → DEFERRED → IN_PROGRESS → OPEN → REFUTED,
 * severity descending inside each. Stable for equal keys, so a re-render cannot
 * reshuffle rows the reader is looking at. */
export function byImportanceDesc<T extends { severity: string; state: HypothesisState }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      STATE_RANK[a.state] - STATE_RANK[b.state] ||
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0),
  );
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
