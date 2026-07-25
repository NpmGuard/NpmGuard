/**
 * The audit HTTP response envelopes that have NO schema in `@npmguard/shared`
 * yet — and nothing else.
 *
 * Sources:
 *  - routes + response shapes: engine/npmguard/api.py, report_store.py
 *  - everything with a schema: `@npmguard/shared`, imported at the point of use
 *
 * THE RULE: import contract types from `@npmguard/shared` directly. There is
 * deliberately no re-export here, because a re-export is an invitation to add
 * "just one" more hand-written shape beside it. `getJson<T>()` is a cast, and a
 * declared type that has never been confronted with a real response is a guess;
 * two hand-kept copies of one shape is a reachable state where they disagree
 * with nothing to catch it. The fix is to bind to the zod the engine's Pydantic
 * models are generated from and CHECK responses against it (`lib/wire.ts`).
 *
 * The failure that keeps recurring when a shape IS restated by hand: the
 * hand-written copy declares a field OPTIONAL where the schema says
 * required-and-nullable. events.py dumps with `exclude_none=False`, so the field
 * always arrives — as an explicit `null`. The optional version lets a caller
 * build a value the engine cannot emit, and makes readers branch on
 * undefined-vs-null for a distinction with no producer.
 *
 * The two verdict domains are two domains: the audit `VerdictEnum` is
 * {SAFE, DANGEROUS} because a failed audit emits an `audit_error` event, while
 * the panel's `Outcome` is {SAFE, ERROR, DANGEROUS} because a failure is exactly
 * what a rollup must count. Do not widen either to match the other, and do not
 * treat them as aliases.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS LEFT, AND WHAT IT WOULD TAKE TO EMPTY THIS FILE
 * ---------------------------------------------------------------------------
 * The shapes below are the audit routes' HTTP envelopes, hand-written for one
 * reason: no schema for them exists in `shared/src/*.ts`, and authoring one
 * requires editing that package (which also regenerates the engine's
 * `contract/models.py` — `scripts/gen-contract.sh`). They cannot be schematised
 * from here, because `zod` is a dependency of `@npmguard/shared` and NOT of this
 * app; importing it to declare a local schema would take an undeclared
 * dependency to gain a second source of truth.
 *
 * `/audit/:id/report` and `/package/:name/report` are CHECKED at the boundary
 * despite this, because the part of them that carries structure — the report —
 * does have a schema (`AuditReportSchema`); see `lib/api.ts`. The rest are flat
 * scalars.
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
