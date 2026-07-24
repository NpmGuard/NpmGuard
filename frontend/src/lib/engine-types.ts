/**
 * Wire contract with the DEV / Python engine.
 *
 * Derived from EVIDENCE, not from @npmguard/shared:
 *  - types + typed event union: engine/npmguard/contract/models.py
 *    (generated from shared/contract/contract.schema.json)
 *  - the 3 UNTYPED-but-emitted events (dependencies_provisioned, graph_built,
 *    intent_extracted): their emit() call sites in engine/npmguard/pipeline.py
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
 */

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

export type Confidence = "SUSPECTED" | "LIKELY" | "CONFIRMED";

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

export interface Finding {
  capability: string; // CapabilityEnum value, may be comma-joined
  confidence: Confidence;
  fileLine: string; // e.g. "lib/index.js:42-67"
  problem: string;
  evidence: string;
  reproductionStrategy: string;
}

export interface InventoryMeta {
  scripts: Record<string, string>;
  dependencies: Record<string, Record<string, string>>;
  entryPoints: { install: string[]; runtime: string[]; bin: string[] };
  metadata: {
    name: string | null;
    version: string | null;
    description: string | null;
    license: string | null;
  };
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
    // UNTYPED-but-emitted (pipeline.py) — not in the schema's AuditEvent union.
    | {
        type: "dependencies_provisioned";
        installed: boolean;
        packageCount: number;
        skipped: string | null;
        error: string | null;
      }
    | { type: "file_list"; files: FileRecord[] }
    | ({ type: "inventory_meta" } & InventoryMeta)
    // UNTYPED-but-emitted (pipeline.py).
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
    // UNTYPED-but-emitted (pipeline.py).
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
    | { type: "agent_thinking"; step: number }
    | { type: "agent_tool_call"; tool: string; args: Record<string, unknown>; step: number }
    | {
        type: "agent_tool_result";
        tool: string;
        resultPreview: string;
        step: number;
        injectionDetected: boolean;
      }
    | { type: "agent_reasoning"; text: string; step: number }
    | { type: "finding_discovered"; finding: Finding }
    | { type: "verify_started"; totalTests: number }
    | {
        type: "verify_test_result";
        proofIndex: number;
        testFile: string;
        status: "confirmed" | "unconfirmed" | "infra_error";
        error?: string | null;
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
  "audit_started", "audit_enqueued", "phase_started", "phase_completed",
  "dependencies_provisioned", "file_list", "inventory_meta", "intent_extracted",
  "file_analyzing", "triage_progress", "hypothesis_emitted", "file_verdict",
  "triage_complete", "graph_built", "hypothesis_resolved", "agent_thinking",
  "agent_tool_call", "agent_tool_result", "agent_reasoning", "finding_discovered",
  "verify_started", "verify_test_result", "verdict_reached", "audit_error",
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
// The panel is a SEPARATE surface from the single-package audit above and it
// keeps the ORIGINAL 4-state verdict on the wire. Do NOT widen the audit
// `Verdict` (SAFE|DANGEROUS) — panel per-dep / rollup / scan shapes use
// `PanelVerdict` instead.
//
// 4→2-state reconciliation (see dashboard-port-plan §5): the wire stays
// 4-state for forward-compat, but the dev engine NEVER emits SUSPECT and only
// emits UNKNOWN as the pending/unaudited ROLLUP bucket. A per-dep verdict is
// therefore always one of SAFE | DANGEROUS | null (null = pending/queued/failed,
// carried by `jobState`). SUSPECT tone/UI paths are reserved-but-never-triggered.

/** Panel verdict enum — 4-state on the wire; dev emits only SAFE|DANGEROUS on
 * deps and UNKNOWN only as the pending rollup bucket. */
export type PanelVerdict = "SAFE" | "SUSPECT" | "DANGEROUS" | "UNKNOWN";

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
  verdict: PanelVerdict | null; // null while running
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

export interface Rollup {
  verdict: PanelVerdict | null;
  dangerous: number;
  suspect: number; // always 0 on dev (SUSPECT reserved/unused)
  unknown: number; // NULL/unaudited deps
  safe: number;
}

export interface DepDetail {
  name: string;
  version: string;
  direct: boolean;
  range: string | null;
  verdict: PanelVerdict | null; // null = pending/queued/failed, distinct from UNKNOWN
  verdictReason: string | null;
  evidenceCount: number;
  auditedAt: string | null;
  jobState: "queued" | "running" | "failed" | null;
}

export interface Alert {
  id: number;
  org: string;
  repoId: number | null;
  packageName: string;
  version: string;
  verdict: string;
  kind: "scan" | "watch";
  message: string;
  seen: boolean;
  createdAt: string;
}

export interface RepoDetailResponse {
  repo: PanelRepo;
  deps: DepDetail[];
  rollup: Rollup;
  scan: ScanSummary | null;
  alerts: Alert[];
}

/** /panel/scan/:scanId/events — UNNAMED SSE messages (use onmessage). */
export type ScanStreamMessage =
  | {
      type: "dep";
      name: string;
      version: string;
      verdict: PanelVerdict | null;
      verdictReason: string | null;
      evidenceCount: number;
      jobState: "queued" | "running" | "failed" | null;
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
  rollup: Rollup;
}

export interface PublicScanDep {
  name: string;
  version: string;
  direct: boolean;
  range: string | null;
  cached: boolean;
  verdict: PanelVerdict | null;
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
