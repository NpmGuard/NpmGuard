import { z } from "zod";

// Shared cross-process types — single source of truth lives in @npmguard/shared.
// Re-exported so existing engine imports of `./models.js` continue to resolve.
// Cross-process types the engine re-exposes so internal modules can import from
// "./models.js". The retired v1 detection vocabulary (Finding, Proof, Confidence,
// ProofKind, AttackPathway, TriageResult, FocusArea) is intentionally NOT
// re-exported — the engine deals in Hypotheses now. Those still live in
// @npmguard/shared for the SSE event types + frontend.
export {
  // Enums
  VerdictEnum,
  CapabilityEnum,
  Severity,
  // Models
  FileVerdict,
  FileSummary,
  FileRecord,
  // Instrumentation
  NetworkCall,
  FsOperation,
  ProcessSpawn,
  EvalCall,
  CryptoOp,
  TimerRecord,
  InstrumentationLog,
} from "@npmguard/shared";

import {
  VerdictEnum,
  Severity,
  FileRecord,
  FileSummary,
  Hypothesis,
  HypothesisCounts,
} from "@npmguard/shared";

// ---------------------------------------------------------------------------
// Report — sent to consumers via /audit/:id/report. The hypothesis graph is
// the single truth-producing artifact: the report is a snapshot of its nodes
// (each a Hypothesis carrying its own state + evidence refs + resolution) plus
// the derived 4-state verdict. There is no separate Finding/Proof model — a
// finding IS a hypothesis with a state. The `trace` (PhaseLog) field is
// engine-internal detail.
// ---------------------------------------------------------------------------

export const PhaseLog = z.object({
  phase: z.string(),
  durationMs: z.number(),
  input: z.record(z.unknown()).default({}),
  output: z.record(z.unknown()).default({}),
});
export type PhaseLog = z.infer<typeof PhaseLog>;

/** A structural short-circuit — a finding so unambiguous it blocks without the
 *  graph (e.g. a `curl | sh` install hook). The one non-dynamic blocker, by
 *  design. */
export const DealBreaker = z.object({
  check: z.string(),
  detail: z.string(),
});
export type DealBreaker = z.infer<typeof DealBreaker>;

export const AuditReport = z.object({
  /** Bumped from the implicit v1 shape; 4-state verdict + hypothesis graph. */
  schemaVersion: z.literal(2).default(2),
  /** The authoritative `deriveGraphVerdict` output — only DANGEROUS blocks. */
  verdict: VerdictEnum,
  /** One-line explanation suitable for a report header. */
  rationale: z.string().default(""),
  /** Per-state tally of the resolved graph, for the coverage picture. */
  counts: HypothesisCounts,
  /** hypIds of CONFIRMED nodes — the ones justifying DANGEROUS. */
  confirmedHypIds: z.array(z.string()).default([]),
  /** The resolved graph nodes. Each carries claim, severity, state, evidence
   *  refs, and resolution — this is the full finding surface. */
  hypotheses: z.array(Hypothesis).default([]),
  /** Per-file one-liners from triage, for the code-viewer. */
  fileSummaries: z.array(FileSummary).default([]),
  /** Set only on the structural short-circuit path. */
  dealbreaker: DealBreaker.nullable().default(null),
  trace: z.array(PhaseLog).default([]),
});
export type AuditReport = z.infer<typeof AuditReport>;

export const ResolvedPackage = z.object({
  path: z.string(),
  needsCleanup: z.boolean().default(false),
  tmpdir: z.string().nullable().default(null),
});
export type ResolvedPackage = z.infer<typeof ResolvedPackage>;

// ---------------------------------------------------------------------------
// Inventory — engine-internal Phase 0 output
// ---------------------------------------------------------------------------

export const InventoryFlag = z.object({
  severity: Severity,
  check: z.string(),
  detail: z.string(),
  file: z.string().nullable().default(null),
});
export type InventoryFlag = z.infer<typeof InventoryFlag>;

export const EntryPoints = z.object({
  install: z.array(z.string()),
  runtime: z.array(z.string()),
  bin: z.array(z.string()),
});
export type EntryPoints = z.infer<typeof EntryPoints>;

export const PackageMetadata = z.object({
  name: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  license: z.string().nullable().default(null),
  homepage: z.string().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  repository: z.unknown().default(null),
});
export type PackageMetadata = z.infer<typeof PackageMetadata>;

export const InventoryReport = z.object({
  metadata: PackageMetadata,
  scripts: z.record(z.string()),
  entryPoints: EntryPoints,
  dependencies: z.record(z.record(z.string())),
  files: z.array(FileRecord),
  flags: z.array(InventoryFlag),
  dealbreaker: DealBreaker.nullable().default(null),
});
export type InventoryReport = z.infer<typeof InventoryReport>;
