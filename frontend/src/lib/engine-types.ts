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
 * MIGRATION IN PROGRESS (N-12): shapes that HAVE a zod schema are being bound to
 * `@npmguard/shared` (the same source the engine's Pydantic models are generated
 * from) instead of hand-restated here. Two hand-kept copies of one shape is a
 * reachable state where they disagree with nothing to catch it. Anything still
 * declared by hand below is a shape with no schema yet.
 */

import type {
  AuditSetRollup,
  DependencyGroups,
  JobState,
  Outcome,
  PackageMetadata,
} from "@npmguard/shared";

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

// ===========================================================================
// GitHub repo panel wire contract
// ===========================================================================
//
// The panel is a SEPARATE surface from the single-package audit above, and its
// verdict domain is a DIFFERENT domain: `Outcome` (SAFE | ERROR | DANGEROUS,
// null until concluded) from the generated contract. Do NOT widen the audit
// `Verdict` (SAFE|DANGEROUS) to match it and do not treat them as aliases — an
// audit that fails emits an `audit_error` event, so ERROR is not a value the
// audit domain can hold, but it IS one the panel must roll up.
//
// Two axes (design §4.4): `outcome` says what we know, `jobState` / the rollup's
// `pending` count say how far along we are. The retired 4-state PanelVerdict
// conflated them — `UNKNOWN` meant both "not audited yet" and "audit failed", so
// no branch on it could be right; `SUSPECT` had no producer at all.
export type { AuditSetRollup, JobState, Outcome } from "@npmguard/shared";

// ===== auth / session =====

export interface SessionUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface Installation {
  id: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

export interface OrgsResponse {
  installations: Installation[];
  installUrl: string;
}

// ===== panel repos + scans =====

export interface ScanSummary {
  id: number;
  status: "running" | "done" | "failed";
  trigger: "manual" | "push" | "reconcile";
  total: number;
  cached: number;
  audited: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  // The rollup over the scan's OWN items; null until the scan is done.
  outcome: Outcome | null;
}

export interface PanelRepo {
  id: number;
  installationId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  protected: boolean;
  lastScan: ScanSummary | null;
}

export interface DepDetail {
  name: string;
  version: string;
  direct: boolean;
  range: string | null;
  // null ⟺ not concluded (a job is queued/running). A failed audit is ERROR, not
  // null — so a null here always resolves itself, and the UI can show a spinner
  // for null and a retry for ERROR.
  outcome: Outcome | null;
  verdictReason: string | null;
  evidenceCount: number;
  auditedAt: string | null;
  // A fact about the ATTEMPT, never the result: `failed` means a terminal failed
  // job exists, which is NOT the same as outcome ERROR (an item can be ERROR
  // with jobState null when its job row was never written).
  jobState: JobState | null;
}

export interface Alert {
  id: number;
  org: string;
  repoId: number | null;
  packageName: string;
  version: string;
  // Only DANGEROUS is ever raised (notify.py is the single writer and inserts
  // that literal). Narrowed from a bare `string`, which is what forced the tone
  // map to accept any string. The contract renames this to `outcome` alongside
  // `kind` → `origin`; both land together in R-1.
  verdict: "DANGEROUS";
  kind: "scan" | "watch";
  message: string;
  seen: boolean;
  createdAt: string;
}

export interface RepoDetailResponse {
  repo: PanelRepo;
  deps: DepDetail[];
  // The repo's posture over its CURRENT dep index, computed server-side. The
  // client consumes it — it must not recompute a second (divergent) answer from
  // `deps`, which is what it used to do while never reading this field.
  rollup: AuditSetRollup;
  scan: ScanSummary | null;
  alerts: Alert[];
}

/** /panel/scan/:scanId/events — UNNAMED SSE messages (use onmessage). */
export type ScanStreamMessage =
  | {
      type: "dep";
      name: string;
      version: string;
      outcome: Outcome | null;
      verdictReason: string | null;
      evidenceCount: number;
      jobState: JobState | null;
    }
  | { type: "progress"; status: string; total: number; cached: number; audited: number; failed: number }
  | { type: "done" };

// ===== public repo audits (progress by POLLING — no SSE) =====

export interface PublicScan {
  id: number;
  installationId: number;
  accountLogin: string;
  requestedBy: number;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  commitSha: string | null;
  lockfilePath: string;
  lockfileSha: string;
  status: "running" | "done";
  total: number;
  cached: number;
  audited: number;
  failed: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  rollup: AuditSetRollup;
}

export interface PublicScanDep {
  name: string;
  version: string;
  direct: boolean;
  range: string | null;
  cached: boolean;
  outcome: Outcome | null;
  reason: string | null;
  evidenceCount: number;
  auditedAt: string | null;
  active: boolean; // a job is queued/running for this dep
}

export interface PublicScanDetailResponse {
  scan: PublicScan;
  dependenciesTruncated: boolean;
  dependencies: PublicScanDep[];
}

// ===== quota / billing =====

export interface UsageBucket {
  used: number;
  limit: number;
  remaining: number | null; // null = unlimited (limit === 0)
}

export interface AccountEntitlements {
  installationId: number;
  accountLogin: string;
  plan: "free" | "pro";
  subscriptionStatus: string;
  protectedRepos: UsageBucket;
  publicRepoAudits: UsageBucket;
  monthlyAudits: UsageBucket;
}

export interface PlanLimits {
  protectedRepos: number;
  publicRepoAudits: number;
  monthlyAudits: number;
}

export interface BillingResponse {
  accounts: AccountEntitlements[];
  plans: { free: PlanLimits; pro: PlanLimits };
  checkoutEnabled: boolean;
  price: { amount: number | null; currency: string; interval: string | null } | null;
}

export type CapResource = "protected_repos" | "public_repo_audits" | "monthly_audits";

/** HTTP 402 body on scan/protect/public-repo endpoints — carries everything
 * needed to render the paywall without a second request. */
export interface CapExceededBody {
  error: string;
  cap: true;
  resource: CapResource;
  installationId: number;
  entitlements: AccountEntitlements;
}
