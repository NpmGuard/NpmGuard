/**
 * Wire contract with the DEV / Python engine.
 *
 * Sources:
 *  - contract shapes: @npmguard/shared (the zod the engine's Pydantic models are
 *    generated from) — see the migration note below
 *  - SSE wire framing (named events, flattened payload): engine/npmguard/events.py
 *  - routes + response shapes: engine/npmguard/api.py, report_store.py
 *
 * IMPORTANT — this is the DEV contract. It differs from the old TS engine:
 *  - Verdict COLLAPSED to {SAFE, DANGEROUS}; failure is an `audit_error` event,
 *    never a verdict. No SUSPECT / UNKNOWN verdicts.
 *  - The report is schemaVersion 2: hypotheses[] + counts, NOT proofs[] /
 *    runtimeEvidence / top-level capabilities (those were the TS shape).
 *  - verdict_reached carries {verdict, rationale, counts, confirmedCount},
 *    NOT {capabilities, proofCount}.
 * If the engine contract changes, THIS file changes.
 *
 * MIGRATION IN PROGRESS (N-12): shapes that HAVE a zod schema are bound to
 * `@npmguard/shared` (the same source the engine's Pydantic models are generated
 * from) instead of hand-restated here. Two hand-kept copies of one shape is a
 * reachable state where they disagree with nothing to catch it. The whole PANEL
 * domain has now moved out — see the note directly below for what is left and why.
 */

import type { DependencyGroups, PackageMetadata } from "@npmguard/shared";

// ===========================================================================
// The GitHub panel domain is GONE from this file — goal G1.
// ===========================================================================
//
// Every panel wire shape now comes from `@npmguard/shared` (`shared/src/panel.ts`),
// the zod the engine's Pydantic models are generated from, and the API layer
// `safeParse`s each response against it (`lib/wire.ts`). Import panel types
// directly from the package; there is deliberately no re-export here, because a
// re-export is an invitation to add "just one" hand-written shape beside it.
//
// Deleted from here, with the shape that replaced each:
//   SessionUser, Installation, OrgsResponse   → identical schemas in panel.ts
//   UsageBucket, PlanLimits, AccountEntitlements, BillingResponse, CapResource
//                                              → same, EXCEPT the hand-written
//     `price.currency` was `string` while the schema says `string | null`. The
//     schema is right: `repo_subscription_price` reads the field off the Stripe
//     object with a `None` default, so a price without a currency is emissible
//     and the hand-written type would have crashed `formatCents` on it.
//   CapExceededBody                            → `CapExceeded` (same fields; the
//     name now matches the contract, and it is PARSED rather than sniffed).
//
// The two verdict domains are still two domains, and that has not changed: the
// audit `Verdict` below is {SAFE, DANGEROUS} because a failed audit emits an
// `audit_error` event, while the panel's `Outcome` is {SAFE, ERROR, DANGEROUS}
// because a failure is exactly what a rollup must count. Do not widen either to
// match the other, and do not treat them as aliases.
//
// What REMAINS hand-written below is the audit-core / report side. It has schemas
// too (`AuditReportSchema`, `AuditEventSchema`, …), so it should follow — but its
// consumers are `components/audit/**` and `components/report/**`, and migrating
// the flattened `AuditEvent` union is its own falsification pass over
// `audit-fold.ts`. Deliberately not bundled into the panel rework.

// ===== enums =====

export type Verdict = "SAFE" | "DANGEROUS";

/** CapabilityEnum (models.py Proof.capability). Findings carry these as free
 * strings (possibly comma-joined); kept as a union for label/known-value use. */
export type Capability =
  | "NETWORK" | "DATA_EXFILTRATION" | "DNS_EXFIL" | "DOM_INJECT"
  | "FILESYSTEM" | "BINARY_DOWNLOAD" | "PROCESS_SPAWN"
  | "ENV_VARS" | "CREDENTIAL_THEFT"
  | "EVAL" | "OBFUSCATION" | "ENCRYPTED_PAYLOAD"
  | "DOS_LOOP" | "ANTI_AI_PROMPT" | "GEO_GATING" | "LIFECYCLE_HOOK"
  | "WORM_PROPAGATION" | "CLIPBOARD_HIJACK" | "TELEMETRY_RAT"
  | "BUILD_PLUGIN_EXFIL" | "NPM_TOKEN_ABUSE";

export type ClaimKind =
  | "env_exfil" | "cred_theft" | "binary_drop" | "obfuscation" | "persistence"
  | "destructive" | "propagation" | "dos_loop" | "clipboard_hijack"
  | "dom_inject" | "telemetry" | "dns_exfil" | "build_plugin_exfil";

export type HypothesisSeverity = "low" | "medium" | "high" | "critical";

export type HypothesisState = "OPEN" | "IN_PROGRESS" | "CONFIRMED" | "REFUTED" | "DEFERRED";

// ===== report (schemaVersion 2 — models.py AuditReport) =====

export interface HypothesisCounts {
  total: number;
  open: number;
  inProgress: number;
  confirmed: number;
  refuted: number;
  deferred: number;
}

export interface DealBreaker {
  check: string;
  detail: string;
}

export interface FileSummary {
  file: string;
  summary: string;
  capabilities: string[];
}

export interface Claim {
  kind: ClaimKind;
  gating?: "time_gate" | "geo_gate" | "ci_gate" | "inspector_gate" | "docker_gate" | null;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface FocusRange {
  file: string;
  range: string;
}

export interface EvidenceRef {
  kind: "run" | "static" | "diff";
  id: string;
  hash: string;
}

export interface HypothesisResolution {
  reason: string;
  by: string;
}

/** A full hypothesis node in the report graph (models.py Hypothesis). */
export interface Hypothesis {
  hypId: string;
  description: string;
  claim: Claim;
  focusFiles: string[];
  focusLines: FocusRange[];
  experiment: ToolCall[];
  severity: HypothesisSeverity;
  parentHypId: string | null;
  childHypIds: string[];
  state: HypothesisState;
  createdBy: string;
  evidenceRefs: EvidenceRef[];
  createdAt: string;
  resolvedAt: string | null;
  resolution: HypothesisResolution | null;
}

export interface PhaseLog {
  phase: string;
  durationMs: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
}

export interface AuditReport {
  schemaVersion: 2;
  verdict: Verdict;
  rationale: string;
  counts: HypothesisCounts;
  confirmedHypIds: string[];
  hypotheses: Hypothesis[];
  fileSummaries: FileSummary[];
  dealbreaker: DealBreaker | null;
  trace: PhaseLog[];
}

// ===== inventory / triage shapes carried by the stream =====

export interface FileRecord {
  path: string;
  fileType: string;
  sizeBytes: number;
  permissions: string;
  isBinary: boolean;
  binaryType: string | null;
}

export interface FileVerdict {
  file: string;
  capabilities: string[];
  suspiciousPatterns: string[];
  suspiciousLines?: string | null; // "12-14, 20"
  summary: string;
  riskContribution: number; // 0-10
}

export interface InventoryMeta {
  scripts: Record<string, string>;
  // KEYED from the contract, not Record<string, …>: an unkeyed map let the fold
  // read `dependencies`/`devDependencies` (never emitted) and report 0 · 0
  // dependencies for every package, with no type error.
  dependencies: DependencyGroups;
  entryPoints: { install: string[]; runtime: string[]; bin: string[] };
  // The engine emits all 7 PackageMetadata fields; the old inline 4-field
  // literal silently dropped homepage/keywords/repository.
  metadata: PackageMetadata;
}

/** A hypothesis as it appears inline in the triage_complete stream event. */
export interface TriageHypothesis {
  hypId: string;
  claim: ClaimKind;
  severity: HypothesisSeverity;
  description: string;
}

// ===== audit SSE stream (/audit/:id/events — NAMED events) =====
//
// Wire framing (events.py): each frame is
//   id: <seq>\nevent: <type>\ndata: <json>\n\n
// where <json> is the event payload FLATTENED with {type, auditId, timestamp,
// seq}. Reconnect resumes from a cursor: native EventSource sends Last-Event-ID
// automatically; the engine also accepts ?since=<seq>. The fold dedups by seq.

interface BaseEvent {
  auditId: string;
  timestamp: string;
  seq: number;
}

export type AuditEvent = BaseEvent &
  (
    | { type: "audit_started"; packageName: string }
    | { type: "audit_enqueued"; queuePosition: number }
    | { type: "phase_started"; phase: string }
    | { type: "phase_completed"; phase: string; durationMs: number }
    | {
        type: "dependencies_provisioned";
        installed: boolean;
        packageCount: number;
        skipped: string | null;
        error: string | null;
      }
    | { type: "file_list"; files: FileRecord[] }
    | ({ type: "inventory_meta" } & InventoryMeta)
    | { type: "intent_extracted"; statedPurpose: string; expectedCapabilities: string[] }
    | { type: "file_analyzing"; file: string }
    | { type: "triage_progress"; current: number; total: number; file: string }
    | {
        type: "hypothesis_emitted";
        hypId: string;
        claim: ClaimKind;
        severity: HypothesisSeverity;
        file: string;
      }
    | { type: "file_verdict"; verdict: FileVerdict }
    | { type: "triage_complete"; hypothesisCount: number; hypotheses: TriageHypothesis[] }
    | { type: "graph_built"; nodeCount: number; addedCount: number; mergedCount: number }
    | {
        type: "hypothesis_resolved";
        hypId: string;
        claim: ClaimKind;
        severity: HypothesisSeverity;
        state: HypothesisState;
        by: string;
        reason: string;
      }
    | {
        type: "verdict_reached";
        verdict: Verdict;
        rationale: string;
        counts: HypothesisCounts;
        confirmedCount: number;
      }
    | { type: "audit_error"; error?: string | null; code?: string | null; retryable?: boolean | null }
  );

export type AuditEventType = AuditEvent["type"];

/** Every event type the audit stream can emit — the SSE client registers a
 * listener per name (the engine uses NAMED events; onmessage never fires). */
export const AUDIT_EVENT_TYPES = [
  "audit_enqueued", "audit_started", "phase_started", "phase_completed",
  "dependencies_provisioned", "file_list", "inventory_meta", "intent_extracted",
  "file_analyzing", "triage_progress", "hypothesis_emitted", "file_verdict",
  "triage_complete", "graph_built", "hypothesis_resolved", "verdict_reached",
  "audit_error",
] as const satisfies readonly AuditEventType[];

// ===== HTTP responses =====

export interface StartAuditResponse {
  auditId: string;
  packageName: string;
}

/** /package/:name/report (api.py) — no `assessment` field on dev. */
export interface PackageReportResponse {
  report: AuditReport;
  version: string;
  packageName: string;
}

/** /packages → { packages: PackageSummary[] } (report_store.list_reports). */
export interface PackageSummary {
  packageName: string;
  version: string;
  verdict: Verdict;
  auditedAt: string; // ISO, e.g. "2026-07-01T12:00:00Z"
}

// ===== payment / config =====

export interface CryptoConfig {
  chain: "base-sepolia";
  chainId: 84532;
  contract: string;
  auditFeeWei: string | null;
}

export interface PublicConfig {
  paymentRequired: boolean;
  paymentEnabled: boolean;
  stripeEnabled: boolean;
  priceCents: number;
  crypto: CryptoConfig | null;
}

export interface CheckoutResponse {
  url: string;
  sessionId: string;
}

/** GET /checkout/:id/status — `auditId` present once claimed. */
export interface CheckoutStatus {
  paid: boolean;
  packageName: string;
  version: string;
  auditId?: string;
}

export interface ResolveResponse {
  packageName: string;
  version: string;
}
