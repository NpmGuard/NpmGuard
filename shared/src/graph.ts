import { z } from "zod";
import { EvidenceRef, ToolCall } from "./evidence.js";

// ---------------------------------------------------------------------------
// Claim taxonomy — what a hypothesis suspects
// (starter set from ARCHITECT_REVIEW_ENGINE.md Appendix A)
// ---------------------------------------------------------------------------

export const ClaimKind = z.enum([
  "env_exfil",
  "cred_theft",
  "binary_drop",
  "obfuscation",
  "persistence",
  "destructive",
  "propagation",
  "dos_loop",
  "clipboard_hijack",
  "dom_inject",
  "telemetry",
  "dns_exfil",
  "build_plugin_exfil",
]);
export const ClaimKindSchema = ClaimKind;
export type ClaimKind = z.infer<typeof ClaimKind>;

export const GatingModifier = z.enum([
  "time_gate",
  "geo_gate",
  "ci_gate",
  "inspector_gate",
  "docker_gate",
]);
export const GatingModifierSchema = GatingModifier;
export type GatingModifier = z.infer<typeof GatingModifier>;

export const Claim = z.object({
  kind: ClaimKind,
  gating: GatingModifier.nullable().default(null),
});
export const ClaimSchema = Claim;
export type Claim = z.infer<typeof Claim>;

// ---------------------------------------------------------------------------
// Hypothesis lifecycle + metadata
// ---------------------------------------------------------------------------

// A hypothesis is resolved only by running its experiment:
//   CONFIRMED — the judge cited dynamic proof the payload fired (→ DANGEROUS)
//   REFUTED   — the experiment ran and the judge found no malice (→ SAFE)
//   DEFERRED  — the run or judge could not complete (machinery broke → the audit
//               is an AuditIncompleteError, never a verdict)
// There is no "inconclusive": a run either fired, refuted, or could not be
// evaluated. OPEN/IN_PROGRESS are transient.
export const HypothesisState = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "CONFIRMED",
  "REFUTED",
  "DEFERRED",
]);
export const HypothesisStateSchema = HypothesisState;
export type HypothesisState = z.infer<typeof HypothesisState>;

export const HypothesisSeverity = z.enum(["low", "medium", "high", "critical"]);
export const HypothesisSeveritySchema = HypothesisSeverity;
export type HypothesisSeverity = z.infer<typeof HypothesisSeverity>;

export const FocusRange = z.object({
  file: z.string(),
  range: z.string(), // e.g. "42-58", "42", "12-30,55-80"
});
export const FocusRangeSchema = FocusRange;
export type FocusRange = z.infer<typeof FocusRange>;

export const HypothesisResolution = z.object({
  reason: z.string(),
  by: z.string(), // "worker:experimenter", "worker:code-reader", "orchestrator", "triage"
});
export const HypothesisResolutionSchema = HypothesisResolution;
export type HypothesisResolution = z.infer<typeof HypothesisResolution>;

export const Hypothesis = z.object({
  hypId: z.string(),
  description: z.string(),
  claim: Claim,
  focusFiles: z.array(z.string()).default([]),
  focusLines: z.array(FocusRange).default([]),
  // The experiment that makes the suspected payload fire: an ordered ToolCall[]
  // (shared tool registry, engine/npmguard/experiments.py) that plants bait,
  // defeats any spotted gate, and triggers the code once. HYPOTHESIZE composes
  // one for every flag or the audit errors — a suspicion is resolved by running
  // it, never by reading it; the orchestrator asserts it is present at dispatch.
  experiment: z.array(ToolCall).default([]),
  severity: HypothesisSeverity.default("medium"),
  parentHypId: z.string().nullable().default(null),
  childHypIds: z.array(z.string()).default([]),
  state: HypothesisState,
  createdBy: z.string(), // "triage", "worker:code-reader", "worker:experimenter", "orchestrator"
  evidenceRefs: z.array(EvidenceRef).default([]),
  createdAt: z.string(), // ISO timestamp
  resolvedAt: z.string().nullable().default(null),
  resolution: HypothesisResolution.nullable().default(null),
});
export const HypothesisSchema = Hypothesis;
export type Hypothesis = z.infer<typeof Hypothesis>;

// ---------------------------------------------------------------------------
// Persisted snapshot of a full graph — written alongside each audit
// ---------------------------------------------------------------------------

export const HypothesisGraphSnapshot = z.object({
  version: z.literal(1),
  auditId: z.string(),
  nodes: z.array(Hypothesis),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const HypothesisGraphSnapshotSchema = HypothesisGraphSnapshot;
export type HypothesisGraphSnapshot = z.infer<typeof HypothesisGraphSnapshot>;

// ---------------------------------------------------------------------------
// Per-state tally of a resolved graph — the shape carried on a graph verdict
// and on the shipped AuditReport so consumers can render the coverage picture.
// ---------------------------------------------------------------------------

export const HypothesisCounts = z.object({
  total: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  refuted: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
});
export const HypothesisCountsSchema = HypothesisCounts;
export type HypothesisCounts = z.infer<typeof HypothesisCounts>;
