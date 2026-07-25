import { z } from "zod";
import { AuditReportSchema } from "./backend.js";
import { VerdictSchema } from "./models.js";

/**
 * The audit surface's HTTP envelopes — the last shapes that were hand-mirrored.
 *
 * The audit *payloads* (report, events, hypotheses) have been contract-owned for
 * a while; what stayed hand-written on both sides was the thin envelope each
 * route wraps them in — `{auditId, packageName}`, `{report, version,
 * packageName}`, the public config. They were small enough to look harmless and
 * that is exactly why they survived: two copies of a five-field object drift as
 * silently as two copies of a fifty-field one, and neither side could catch it,
 * because a hand-written TypeScript interface is a claim about a response that
 * nothing ever confronts with a real one.
 *
 * Every shape here is read off the route that produces it (`engine/npmguard/api.py`),
 * and the engine now *constructs* its responses from the generated models rather
 * than from dict literals, so there is one author for each.
 *
 * WIRE nullability rule as in panel.ts / replay.ts: `.nullable()`, never
 * `.optional()`. Responses are dumped with `exclude_none=False`, so an absent
 * value arrives as an explicit `null` and a missing KEY is drift that must fail.
 */

// ---------------------------------------------------------------------------
// Audit lifecycle
// ---------------------------------------------------------------------------

// POST /audit/stream, POST /demo/start. `packageName` is echoed rather than
// assumed by the caller because the three admission paths disagree about who
// names the package: a crypto-paid run takes it from the VERIFIED on-chain
// payment (api.py:381), not from the request body, so the field is the engine
// telling the client what it actually paid to audit.
export const StartAuditResponseSchema = z.object({
  auditId: z.string(),
  packageName: z.string(),
});
export type StartAuditResponse = z.infer<typeof StartAuditResponseSchema>;

// POST /audit with a CRE api-key — 202, the audit runs in the background and the
// caller follows it on the event stream. Distinct from the 200 this route
// returns to an ordinary caller, which is the finished report itself; `status`
// is the discriminant that says which of the two arrived.
export const AuditAcceptedResponseSchema = z.object({
  status: z.literal("accepted"),
  auditId: z.string(),
  packageName: z.string(),
  // Echoed from the request, where it is optional — null means "whatever
  // `latest` resolves to", which the audit itself resolves.
  version: z.string().nullable(),
  queuePosition: z.number().int().nonnegative(),
});
export type AuditAcceptedResponse = z.infer<typeof AuditAcceptedResponseSchema>;

// GET /resolve/:name — a dist-tag ("latest") resolved to a concrete semver.
// Must be called BEFORE /audit/stream: the engine rejects non-semver there.
export const ResolveResponseSchema = z.object({
  packageName: z.string(),
  version: z.string(),
});
export type ResolveResponse = z.infer<typeof ResolveResponseSchema>;

// GET /demo/packages — the committed recordings this engine can replay. An
// empty list must render honestly (a package input), never a fake dropdown.
export const DemoPackagesResponseSchema = z.object({
  packages: z.array(z.string()),
});
export type DemoPackagesResponse = z.infer<typeof DemoPackagesResponseSchema>;

// ---------------------------------------------------------------------------
// Stored reports
// ---------------------------------------------------------------------------

// One row of GET /packages (report_store.list_reports). Non-null throughout:
// `_readable` has already screened every row for a v2 body with an in-domain
// verdict, and `version` falls back to the file stem, so a summary that reached
// a client is one whose report can be opened.
export const PackageSummarySchema = z.object({
  packageName: z.string(),
  version: z.string(),
  // The audit-core Verdict (SAFE|DANGEROUS). An audit that could not conclude
  // has no stored report and so has no row here — there is no ERROR case.
  verdict: VerdictSchema,
  // ISO-8601 UTC, e.g. "2026-07-01T12:00:00Z" — the report file's mtime.
  auditedAt: z.string(),
});
export type PackageSummary = z.infer<typeof PackageSummarySchema>;

// GET /packages — newest first.
export const PackageIndexResponseSchema = z.object({
  packages: z.array(PackageSummarySchema),
});
export type PackageIndexResponse = z.infer<typeof PackageIndexResponseSchema>;

// GET /package/:name/report. `version` is the version the store RESOLVED, which
// is not necessarily the one asked for (the query param is optional and the
// store answers with its newest), so it labels the page and must be read back
// rather than echoed from the request.
export const PackageReportResponseSchema = z.object({
  report: AuditReportSchema,
  version: z.string(),
  packageName: z.string(),
});
export type PackageReportResponse = z.infer<typeof PackageReportResponseSchema>;

// ---------------------------------------------------------------------------
// Payment + public config
// ---------------------------------------------------------------------------

// The on-chain half of GET /config/public.
//
// INVARIANT: this object exists ⟺ the client can build a payment transaction.
// Nothing in it is nullable, and that is the whole design — "we cannot take a
// crypto payment right now" is spelled by the PARENT being null, once, instead
// of by three fields that each might be missing.
//
// Both would-be nulls are unreachable at the emit site (api.py):
//  - `contract`: the block is emitted only inside `is_chain_configured()`, which
//    IS "a contract address is set" (payments.py:37-58).
//  - `auditFeeWei`: `read_audit_fee()` returns None only for an unconfigured
//    chain — already excluded — and a failed RPC read raises, which the route
//    answers with `crypto: null`.
// The hand-written copy this replaces declared `auditFeeWei` nullable and bought
// two frontend branches (a "—" fee label and a "fee unknown" notice) for a
// response the engine cannot send.
export const CryptoConfigSchema = z.object({
  chain: z.literal("base-sepolia"),
  chainId: z.literal(84532),
  contract: z.string(),
  // A decimal string, because a wei value overflows a JS number.
  auditFeeWei: z.string(),
});
export type CryptoConfig = z.infer<typeof CryptoConfigSchema>;

// GET /config/public — everything the client is allowed to know about payment.
// Never a source of prices or addresses in client code; always read from here.
export const PublicConfigSchema = z.object({
  paymentRequired: z.boolean(),
  paymentEnabled: z.boolean(),
  stripeEnabled: z.boolean(),
  priceCents: z.number().int(),
  // Null when no chain is configured on this engine.
  crypto: CryptoConfigSchema.nullable(),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;

// POST /checkout — a Stripe Checkout session to redirect to.
export const CheckoutResponseSchema = z.object({
  url: z.string(),
  sessionId: z.string(),
});
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;

// GET /checkout/:id/status — polled on return from Stripe.
export const CheckoutStatusSchema = z.object({
  paid: z.boolean(),
  packageName: z.string(),
  version: z.string(),
  // The audit this payment has been claimed into, or null if it has not been
  // claimed yet. Nullable rather than optional: the two branches that answer
  // this route (a stored claim vs. a fresh Stripe verification) used to disagree
  // about whether the key existed at all, which made "not claimed yet" and "this
  // engine version does not report claims" the same observation on the wire.
  auditId: z.string().nullable(),
});
export type CheckoutStatus = z.infer<typeof CheckoutStatusSchema>;
