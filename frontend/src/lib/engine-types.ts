/**
 * The audit HTTP response envelopes that have NO schema in `@npmguard/shared`
 * yet — and nothing else.
 *
 * Sources:
 *  - routes + response shapes: engine/npmguard/api.py, report_store.py
 *  - everything with a schema: `@npmguard/shared`, imported at the point of use
 *
 * MIGRATION (N-12) — what this file used to be, and why it is nearly empty:
 * it hand-restated the whole wire contract, because `getJson<T>()` is a cast and
 * a declared type that has never been confronted with a real response is a
 * guess. The fix is not to keep guessing carefully; it is to bind to the zod the
 * engine's Pydantic models are generated from and CHECK responses against it
 * (`lib/wire.ts`). Two hand-kept copies of one shape is a reachable state where
 * they disagree with nothing to catch it — and they did disagree, three times
 * over (below).
 *
 * The PANEL domain moved out first; the AUDIT/REPORT domain has now followed.
 * Import those types from `@npmguard/shared` directly — there is deliberately no
 * re-export here, because a re-export is an invitation to add "just one" more
 * hand-written shape beside it. The contract names differ from the old local
 * ones in three places, and the contract name wins: `Verdict` → `VerdictEnum`,
 * `AuditEvent` → `AuditEventUnion`, `AUDIT_EVENT_TYPES` → `EVENT_TYPES`.
 *
 * Deleted from here, with the shape that replaced each:
 *   Verdict                        → `VerdictEnum` (models.ts)
 *   ClaimKind, HypothesisSeverity, HypothesisState, HypothesisCounts,
 *   Claim, FocusRange, HypothesisResolution, Hypothesis
 *                                  → identical schemas in graph.ts, EXCEPT the
 *     hand-written `Claim.gating` was OPTIONAL (`gating?:`) while the schema says
 *     required-and-nullable. The schema is right: events.py dumps with
 *     exclude_none=False, so the field always arrives — as an explicit `null`.
 *     The optional version let a caller build a Claim the engine cannot emit and
 *     made a reader branch on undefined-vs-null for a distinction that has no
 *     producer.
 *   ToolCall, EvidenceRef          → identical schemas in evidence.ts
 *   FileSummary, FileRecord        → identical schemas in models.ts
 *   FileVerdict                    → same, EXCEPT `suspiciousLines` was optional
 *     where the schema says required-and-nullable. Same bug, same reason: every
 *     clean file sends `null` for it.
 *   PhaseLog, DealBreaker, AuditReport
 *                                  → identical schemas in backend.ts
 *   AuditEvent, AuditEventType, AUDIT_EVENT_TYPES, TriageHypothesis
 *                                  → `AuditEventUnion` / `AuditEventType` /
 *     `EVENT_TYPES` / `TriageHypothesis` (events.ts). The union is a zod
 *     DISCRIMINATED union, so `switch (event.type)` narrows on the contract's own
 *     discriminant, and the SSE boundary can now PARSE a frame instead of casting
 *     it (`lib/sse.ts`). EXCEPT: the hand-written `audit_error` declared
 *     `{error?: string | null; code?: string | null; retryable?: boolean | null}`
 *     while the schema declares all three REQUIRED and non-null. The schema is
 *     right — every emit site supplies them (service.py:184, :246, :338) and the
 *     generated Pydantic model types them `str`/`str`/`bool`, so a null-bearing
 *     audit_error is not an emissible frame. The permissive version bought a
 *     fallback branch that can never run, and a unit test that asserted the
 *     fold's behaviour on a frame the engine cannot produce.
 *   InventoryMeta                  → derived from `InventoryMetaEvent` where it is
 *     used, in `lib/audit-fold.ts`: it is that event with the SSE envelope
 *     stripped, so it is spelled as exactly that rather than restated.
 *   Capability                     → DELETED OUTRIGHT, not migrated. It had zero
 *     consumers anywhere in the app (`CapabilityEnum` in models.ts is the
 *     contract's own copy if one is ever needed). Findings carry capabilities as
 *     free strings, which is what every consumer actually reads.
 *
 * The two verdict domains are still two domains, and that has not changed: the
 * audit `VerdictEnum` is {SAFE, DANGEROUS} because a failed audit emits an
 * `audit_error` event, while the panel's `Outcome` is {SAFE, ERROR, DANGEROUS}
 * because a failure is exactly what a rollup must count. Do not widen either to
 * match the other, and do not treat them as aliases.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS LEFT, AND WHAT IT WOULD TAKE TO EMPTY THIS FILE
 * ---------------------------------------------------------------------------
 * The shapes below are the audit routes' HTTP envelopes. They are still hand-
 * written for one reason only: no schema for them exists in `shared/src/*.ts`,
 * and authoring one requires editing that package (which also regenerates the
 * engine's `contract/models.py` — `scripts/gen-contract.sh`). They cannot be
 * schematised from here, because `zod` is a dependency of `@npmguard/shared` and
 * NOT of this app; importing it here to declare a local schema would take an
 * undeclared dependency to gain a second source of truth.
 *
 * So these five envelopes are the remaining gap in "one contract, generated,
 * never hand-mirrored" for the audit domain. `/audit/:id/report` and
 * `/package/:name/report` are already CHECKED at the boundary despite this,
 * because the part of them that carries structure — the report — does have a
 * schema (`AuditReportSchema`); see `lib/api.ts`. The rest are flat scalars.
 */

import type { AuditReport, VerdictEnum } from "@npmguard/shared";

// ===== audit lifecycle =====

/** POST /audit/stream, POST /demo/start. */
export interface StartAuditResponse {
  auditId: string;
  packageName: string;
}

/** GET /package/:name/report (api.py) — no `assessment` field on dev. The
 * `report` is parsed against `AuditReportSchema` in `lib/api.ts`; only the two
 * envelope strings are unchecked. */
export interface PackageReportResponse {
  report: AuditReport;
  version: string;
  packageName: string;
}

/** GET /packages → { packages: PackageSummary[] } (report_store.list_reports). */
export interface PackageSummary {
  packageName: string;
  version: string;
  verdict: VerdictEnum;
  auditedAt: string; // ISO, e.g. "2026-07-01T12:00:00Z"
}

/** GET /resolve/:name — a dist-tag resolved to a concrete semver. */
export interface ResolveResponse {
  packageName: string;
  version: string;
}

// ===== payment / config =====

export interface CryptoConfig {
  chain: "base-sepolia";
  chainId: 84532;
  contract: string;
  auditFeeWei: string | null;
}

/** GET /config/public. */
export interface PublicConfig {
  paymentRequired: boolean;
  paymentEnabled: boolean;
  stripeEnabled: boolean;
  priceCents: number;
  crypto: CryptoConfig | null;
}

/** POST /checkout — Stripe Checkout redirect. */
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
