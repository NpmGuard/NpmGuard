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
export type ClaimKind = z.infer<typeof ClaimKind>;

export const GatingModifier = z.enum([
  "time_gate",
  "geo_gate",
  "ci_gate",
  "inspector_gate",
  "docker_gate",
]);
export type GatingModifier = z.infer<typeof GatingModifier>;

export const Claim = z.object({
  kind: ClaimKind,
  gating: GatingModifier.nullable().default(null),
});
export type Claim = z.infer<typeof Claim>;

// ---------------------------------------------------------------------------
// Hypothesis lifecycle + metadata
// ---------------------------------------------------------------------------

export const HypothesisState = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "CONFIRMED",
  "REFUTED",
  "INCONCLUSIVE",
  "DEFERRED",
]);
export type HypothesisState = z.infer<typeof HypothesisState>;

export const HypothesisSeverity = z.enum(["low", "medium", "high", "critical"]);
export type HypothesisSeverity = z.infer<typeof HypothesisSeverity>;

export const FocusRange = z.object({
  file: z.string(),
  range: z.string(), // e.g. "42-58", "42", "12-30,55-80"
});
export type FocusRange = z.infer<typeof FocusRange>;

export const HypothesisResolution = z.object({
  reason: z.string(),
  by: z.string(), // "worker:experimenter", "worker:code-reader", "orchestrator", "triage"
});
export type HypothesisResolution = z.infer<typeof HypothesisResolution>;

export const Hypothesis = z.object({
  hypId: z.string(),
  description: z.string(),
  claim: Claim,
  focusFiles: z.array(z.string()).default([]),
  focusLines: z.array(FocusRange).default([]),
  // The experiment that makes the suspected payload fire: an ordered ToolCall[]
  // (shared tool registry, engine/src/sandbox/tools.ts) that plants bait,
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
  inconclusive: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
});
export type HypothesisCounts = z.infer<typeof HypothesisCounts>;
