import { z } from "zod";

/**
 * The GitHub-panel wire contract: a generalized `AuditSet`, the 3-state
 * `Outcome`, `verdictReason` + `jobState` everywhere, and a named body for
 * every error. This file is the authority — an engine divergence from it is a
 * failing boundary, not a judgement call.
 */

// INVARIANT: a WIRE schema expresses nullability as .nullable(), never
// .optional() — see the same invariant above FileVerdict in models.ts. events.py
// dumps with exclude_none=False, so every Optional engine field arrives as an
// explicit `null`, and .optional() accepts `undefined` but not `null`.
//
// Response fields therefore also carry NO `.default(null)`: the key is always
// present on the wire, so a missing key is drift and must fail validation.
// Request bodies do default, because a client legitimately omits a field.

// ---------------------------------------------------------------------------
// Session + installations
// ---------------------------------------------------------------------------

export const SessionUserSchema = z.object({
  id: z.number().int(),
  login: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

// GET /me. A signed-out caller gets 401 ApiError, never `{user: null}` — absence
// of a session is a status, not a payload.
export const SessionResponseSchema = z.object({
  user: SessionUserSchema,
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

// One GitHub App installation the signed-in user can access. The installation IS
// the billing account (F-E1), so quotas are per `id`, never per user.
export const InstallationSchema = z.object({
  id: z.number().int(),
  // The installation account can be a user / org / enterprise shape, so the
  // engine falls back login → slug → "unknown"; accountType defaults to
  // "Organization". Never null on the wire.
  accountLogin: z.string(),
  accountType: z.string(),
  suspended: z.boolean(),
});
export type Installation = z.infer<typeof InstallationSchema>;

export const OrgsResponseSchema = z.object({
  installations: z.array(InstallationSchema),
  // Where to send a user who has no installation yet — server-built, because it
  // encodes the App slug the client must not know.
  installUrl: z.string(),
});
export type OrgsResponse = z.infer<typeof OrgsResponseSchema>;

// ---------------------------------------------------------------------------
// The two-axis verdict model (design §4.4)
// ---------------------------------------------------------------------------

// Axis 2 — the OUTCOME of an audit attempt, meaningful only once concluded.
// DANGEROUS ⟺ ≥1 confirmed hypothesis or a dealbreaker; SAFE ⟺ concluded with
// nothing confirmed; ERROR ⟺ the audit could not conclude (crash / timeout /
// unresolvable) — "we tried and failed", which is never SAFE and never "not
// checked yet". `null` on the wire means nothing has concluded yet.
//
// DISTINCT from the audit-core Verdict (models.ts, SAFE|DANGEROUS) and not an
// alias for it: an audit that fails emits an `audit_error` event, so failure is
// not a value the audit domain can hold — but it IS one the panel must roll up.
//
// UNKNOWN is deliberately absent: it meant "not audited yet" (progress) and
// "audit failed" (outcome) under one name, so no branch on it could be correct.
export const OutcomeSchema = z.enum(["SAFE", "ERROR", "DANGEROUS"]);
export type Outcome = z.infer<typeof OutcomeSchema>;

// Rollup severity: a set's outcome is the max over its CONCLUDED items.
export const OUTCOME_SEVERITY = { SAFE: 0, ERROR: 1, DANGEROUS: 2 } as const;

// Axis 1 — progress for one (name, version): unaudited (null) → queued →
// running → concluded (null again, with an outcome). Never a verdict.
// `failed` is a job fact (this attempt died, retry is possible); the OUTCOME of
// a failed audit is ERROR. Do not read `failed` as an outcome.
export const JobStateSchema = z.enum(["queued", "running", "failed"]);
export type JobState = z.infer<typeof JobStateSchema>;

// ---------------------------------------------------------------------------
// AuditSet — one entity for "a set of (name, version) being audited" (R-1)
// ---------------------------------------------------------------------------

// `dep_tree` is designed-for, not built (R-7): it is listed so adding it later
// costs no wire change. `watchlist` is the registry watcher's own set.
export const AuditSetOriginSchema = z.enum([
  "repo_scan",
  "public_repo_scan",
  "dep_tree",
  "bench_run",
  "watchlist",
]);
export type AuditSetOrigin = z.infer<typeof AuditSetOriginSchema>;

// `publish` = the registry watcher saw a new version; `reconcile` = a re-sync of
// the dep index rather than a user- or push-driven scan.
export const AuditSetTriggerSchema = z.enum(["manual", "push", "reconcile", "publish"]);
export type AuditSetTrigger = z.infer<typeof AuditSetTriggerSchema>;

// Progress of the SET (not of any audit), and DERIVED on the wire rather than
// stored: the engine keeps only `finishedAt`, and `status` is "done" iff it is
// set. That is what makes the invariant below unrepresentable-if-violated
// instead of merely asserted.
//
// There is deliberately no `failed` status, and no `AuditSet.error`: every way a
// set can go wrong already resolves into its rollup. A refused budget or a
// missing lockfile raises BEFORE any row exists (no set at all); a lost enqueue
// batch leaves items with no verdict and no live job, i.e. outcome ERROR; a
// crashed engine leaves the set `running` until the boot sweep finalizes it,
// again as ERROR. A reserved-but-unproduced status is the class this contract
// exists to delete.
export const AuditSetStatusSchema = z.enum(["running", "done"]);
export type AuditSetStatus = z.infer<typeof AuditSetStatusSchema>;

// The single counters object over a set's items. Two objects counting the same
// items, neither summing to anything checkable, is how a bucket like `unknown`
// comes to mean three different facts.
//
// INVARIANT: safe + dangerous + error + pending == total. Every item is in
// exactly one of those four states, which is what makes an `unknown` bucket
// impossible to reintroduce. `cached` is orthogonal — a subset of the concluded
// three — and is excluded from the sum.
// INVARIANT: `outcome` is the max severity (DANGEROUS > ERROR > SAFE) over
// CONCLUDED items only, null when none has concluded. `pending` never
// contributes, so a half-finished set is "SAFE so far, N pending" — never
// "unknown".
export const AuditSetRollupSchema = z.object({
  outcome: OutcomeSchema.nullable(),
  total: z.number().int().nonnegative(),
  safe: z.number().int().nonnegative(),
  dangerous: z.number().int().nonnegative(),
  // Audits that could not conclude (§4.4 ERROR). A repo where 12 of 40 audits
  // crashed is not a green repo, and this is the counter that says so.
  error: z.number().int().nonnegative(),
  // Not yet concluded: unaudited | queued | running.
  pending: z.number().int().nonnegative(),
  // Resolved from an existing report instead of a fresh audit.
  cached: z.number().int().nonnegative(),
});
export type AuditSetRollup = z.infer<typeof AuditSetRollupSchema>;

// A set of (name, version) pairs being audited, and how far along it is —
// uniformly progress, with NOTHING about what the set is about. The subject
// lives in the enclosing response: repo detail returns `{repo, set, deps,
// alerts}`, a public scan `{scan: {repo, set}, deps}`, a bench run `{corpus,
// run: {set}, rows}`.
//
// Deliberately NOT a discriminated union on `origin`: a union would force every
// consumer of a counter to destructure a subject it does not care about, and
// adding `dep_tree` would then cost wire complexity. This costs none.
//
// INVARIANT: `finishedAt` is non-null iff `status === "done"` — one stored fact
// (`finished_at`) projected twice, so the pair cannot disagree.
// INVARIANT: `status === "done"` iff `rollup.pending === 0`. An item counts as
// pending only while it has a live job AND the set is live, so a finished set can
// never report work still outstanding — a job another set enqueues later cannot
// retroactively un-finish this one.
// `status` (did the SET finish) and `rollup.outcome` (the verdict over its items)
// are the §4.4 axes at set level: a `done` set can hold any outcome, including
// null when it covered nothing.
export const AuditSetSchema = z.object({
  id: z.number().int(),
  origin: AuditSetOriginSchema,
  trigger: AuditSetTriggerSchema,
  status: AuditSetStatusSchema,
  rollup: AuditSetRollupSchema,
  // Populated for repo origins. A snapshot without a commit sha is not
  // reproducible.
  commitSha: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AuditSet = z.infer<typeof AuditSetSchema>;

// One (name, version) inside a set — the ONE dep projection, shared by repo
// detail, repo list, public detail and the verdict index. `jobState` rather than
// a boolean `active`, which collapses queued/running/failed into one bit.
//
// INVARIANT: the set's rollup counts this item as concluded iff `outcome !==
// null`; `jobState` describes the attempt, never the result.
export const AuditSetItemSchema = z.object({
  name: z.string(),
  version: z.string(),
  // Declared in the subject's manifest vs pulled in transitively.
  direct: z.boolean(),
  // The requested semver range; null for a lockfile-only transitive pin.
  range: z.string().nullable(),
  outcome: OutcomeSchema.nullable(),
  verdictReason: z.string().nullable(),
  evidenceCount: z.number().int().nonnegative(),
  auditedAt: z.string().nullable(),
  jobState: JobStateSchema.nullable(),
  cached: z.boolean(),
});
export type AuditSetItem = z.infer<typeof AuditSetItemSchema>;

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export const PanelRepoSchema = z.object({
  id: z.number().int(),
  installationId: z.number().int(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  // Continuous protection: push webhooks trigger a delta scan + check-run.
  protected: z.boolean(),
  // The repo's most recent `repo_scan` set; null iff it has never been scanned.
  // The dashboard's entire triage story — the attention filter, "not audited",
  // the posture rail, the audited counter — reads this, so a null here makes
  // four surfaces inert.
  lastScan: AuditSetSchema.nullable(),
});
export type PanelRepo = z.infer<typeof PanelRepoSchema>;

export const ReposResponseSchema = z.object({
  repos: z.array(PanelRepoSchema),
});
export type ReposResponse = z.infer<typeof ReposResponseSchema>;

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export const AlertSchema = z.object({
  id: z.number().int(),
  // The installation account login the alert is scoped to (the feed is
  // org-scoped, not repo-scoped).
  org: z.string(),
  // Nullable because the alerts→repos FK is ON DELETE SET NULL, NOT because
  // package-level alerts lack a repo: every alert is raised through exposure
  // collection and carries a repo at insert time.
  repoId: z.number().int().nullable(),
  packageName: z.string(),
  version: z.string(),
  // Only DANGEROUS is ever raised. Narrowed from a bare `string` (which forced
  // every tone map to accept any string) and NOT widened to Outcome: a
  // reserved-but-unproduced value is the exact class this contract deletes.
  outcome: z.literal("DANGEROUS"),
  // The origin of the SET that raised the alert. Deriving it from the alert
  // itself (`"watch" if scan_id is None`) files every public-repo audit's
  // finding as a watch alert.
  origin: AuditSetOriginSchema,
  message: z.string(),
  seen: z.boolean(),
  createdAt: z.string(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const AlertsResponseSchema = z.object({
  alerts: z.array(AlertSchema),
});
export type AlertsResponse = z.infer<typeof AlertsResponseSchema>;

// GET /panel/repo/{owner}/{name}. `rollup` is NOT a sibling here — it lives on
// `set`, computed once server-side over the set's OWN items and consumed by the
// client, instead of a second (divergent) client-side recompute.
//
// `deps` is the SET's item list, never the repo's current dep index: summing
// `deps` must reproduce `set.rollup` (modulo truncation), and that is only true
// when the two describe one population, so every `repo_scan` set covers the
// whole parsed lockfile. The push path's "audit only what changed" is an ENQUEUE
// optimization the cache-first check already performs; narrowing the ITEM set
// instead makes `lastScan` a posture it cannot honestly claim.
export const RepoDetailResponseSchema = z.object({
  repo: PanelRepoSchema,
  // The scan being shown: the live one if any, else the most recent. Null iff
  // the repo has never been scanned.
  set: AuditSetSchema.nullable(),
  // True when the set covers more pairs than `deps` carries — same cap, same
  // ordering, same flag as the public-scan detail below. One truncation story:
  // both routes cap for wire size, and NEITHER leaves a consumer to infer it by
  // comparing lengths.
  depsTruncated: z.boolean(),
  deps: z.array(AuditSetItemSchema),
  // Most recent alerts for this repo, newest first.
  alerts: z.array(AlertSchema),
});
export type RepoDetailResponse = z.infer<typeof RepoDetailResponseSchema>;

// ---------------------------------------------------------------------------
// Audit-set progress stream — GET /panel/scan/{id}/events
// ---------------------------------------------------------------------------
// ONE stream for every origin (R-1): the route is keyed by SET id, so a public
// repo audit and an owned-repo scan are followed by the same client code. The
// public-scan polling loop it replaces was the second progress implementation.

// UNNAMED SSE frames: no `event:` line, so a consumer reads them with
// `onmessage` and discriminates on the payload's `type`. Per-name listeners
// receive nothing at all — the opposite convention from the audit stream
// (events.ts), which is one NAMED event per type.
//
// Frames DO carry an `id:` line (the durable log's `seq`), which is what makes
// `Last-Event-ID` resume work: an unnamed event with an id still fires
// `onmessage`, and EventSource replays the cursor on reconnect. Every frame is a
// SNAPSHOT of its subject, so replaying one is idempotent.
export const ScanDepFrameSchema = z.object({
  type: z.literal("dep"),
  // The whole item, not a flattened subset — anything less makes the stream a
  // second, lossier projection of the dep shape the detail response returns.
  item: AuditSetItemSchema,
});
export type ScanDepFrame = z.infer<typeof ScanDepFrameSchema>;

export const ScanProgressFrameSchema = z.object({
  type: z.literal("progress"),
  status: AuditSetStatusSchema,
  // The set's rollup verbatim — same object, same invariant, as the detail
  // response carries.
  rollup: AuditSetRollupSchema,
});
export type ScanProgressFrame = z.infer<typeof ScanProgressFrameSchema>;

// Terminal frame; the engine closes the stream immediately after it.
export const ScanDoneFrameSchema = z.object({
  type: z.literal("done"),
});
export type ScanDoneFrame = z.infer<typeof ScanDoneFrameSchema>;

export const ScanStreamFrameSchema = z.discriminatedUnion("type", [
  ScanDepFrameSchema,
  ScanProgressFrameSchema,
  ScanDoneFrameSchema,
]);
export type ScanStreamFrame = z.infer<typeof ScanStreamFrameSchema>;

// ---------------------------------------------------------------------------
// Public-repo audits — read-only snapshots (F-F4)
// ---------------------------------------------------------------------------

// The audited public repo. A snapshot: never joined into the owned-repo tables,
// so this is a sibling of PanelRepo rather than a reuse of it.
export const PublicRepoSchema = z.object({
  githubRepoId: z.number().int(),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(),
  htmlUrl: z.string(),
  defaultBranch: z.string(),
  // Which lockfile was resolved, and its blob sha — the pair that makes the
  // snapshot reproducible together with `set.commitSha`.
  lockfilePath: z.string(),
  lockfileSha: z.string(),
  // How many distinct (name, version) pairs the LOCKFILE held. `set.rollup.total`
  // is how many this scan COVERS, and the two differ when the per-user cost
  // ceiling bound the scan (D-1 / F-F6): past it, a scan is served from cached
  // verdicts rather than refused. The difference is the number of packages this
  // scan says nothing about, and a surface aimed at strangers has to be able to
  // say that — silently reporting a partial scan as a whole one is the same
  // credibility failure as overstating SAFE.
  lockfileDepCount: z.number().int().nonnegative(),
});
export type PublicRepo = z.infer<typeof PublicRepoSchema>;

export const PublicRepoScanSchema = z.object({
  id: z.number().int(),
  repo: PublicRepoSchema,
  // Progress, rollup, commitSha, error and timing all live here (origin
  // `public_repo_scan`), never duplicated onto the scan row.
  set: AuditSetSchema,
  // The gh_user who asked. A sign-in is required and is the whole abuse ceiling
  // (D-1); what remains is cost control, not abuse control.
  requestedBy: z.number().int(),
});
export type PublicRepoScan = z.infer<typeof PublicRepoScanSchema>;

export const PublicRepoScansResponseSchema = z.object({
  scans: z.array(PublicRepoScanSchema),
});
export type PublicRepoScansResponse = z.infer<typeof PublicRepoScansResponseSchema>;

export const PublicRepoScanDetailResponseSchema = z.object({
  scan: PublicRepoScanSchema,
  // True when the set covers more pairs than `deps` carries — the detail
  // projection is capped for wire size. The true count is `set.rollup.total`,
  // so a truncated view must never be summed for a posture. Same cap and same
  // severity-first ordering as the repo detail above, so the tail that gets cut
  // is the least urgent on both routes.
  depsTruncated: z.boolean(),
  deps: z.array(AuditSetItemSchema),
});
export type PublicRepoScanDetailResponse = z.infer<typeof PublicRepoScanDetailResponseSchema>;

// POST /panel/public-repos/scan. The body is the repository and NOTHING else:
// a GitHub sign-in is the whole requirement (D-1 / F-F5), so there is no account
// to choose. Asking a visitor who has never installed the App to name an
// installation is exactly what made this surface unreachable for the people it
// exists for.
export const PublicRepoScanRequestSchema = z.object({
  // Any public repo reference the engine can parse (owner/name or a URL).
  repository: z.string(),
});
export type PublicRepoScanRequest = z.infer<typeof PublicRepoScanRequestSchema>;

// ---------------------------------------------------------------------------
// Entitlements + billing — a policy layer behind one seam (F-E)
// ---------------------------------------------------------------------------

// INVARIANT: `limit === 0` means UNLIMITED, and `remaining` is then null;
// otherwise `remaining === max(0, limit - used)`. So `remaining === null` is the
// "no cap" signal, never "unknown".
export const UsageBucketSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  // Unconstrained on purpose: a nullable+constrained integer makes the Python
  // codegen emit a field-named wrapper class (`Remaining`) into the shared
  // contract module. The bound is the engine's — max(0, limit - used).
  remaining: z.number().int().nullable(),
});
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

// A DERIVED display label — "pro" iff `subscriptionStatus` is active|trialing.
// The authority is the entitlements projection below; no wire shape, table or
// component may branch on this two-valued fact (F-E5).
export const AccountPlanSchema = z.enum(["free", "pro"]);
export type AccountPlan = z.infer<typeof AccountPlanSchema>;

// The resource-keyed projection everything downstream of the billing seam
// consumes (F-E2). A new product — per-audit credits — is a new bucket here,
// never a new branch in a consumer.
export const AccountEntitlementsSchema = z.object({
  installationId: z.number().int(),
  accountLogin: z.string(),
  plan: AccountPlanSchema,
  // Stripe's own vocabulary, passed through verbatim ("inactive" when there is
  // no billing row). Deliberately not an enum: it is the provider's fact.
  subscriptionStatus: z.string(),
  protectedRepos: UsageBucketSchema,
  monthlyAudits: UsageBucketSchema,
});
export type AccountEntitlements = z.infer<typeof AccountEntitlementsSchema>;

// Deployment-tuned ceilings (Settings), same 0-means-unlimited rule as above.
export const PlanLimitsSchema = z.object({
  protectedRepos: z.number().int().nonnegative(),
  monthlyAudits: z.number().int().nonnegative(),
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

export const PlanCatalogSchema = z.object({
  free: PlanLimitsSchema,
  pro: PlanLimitsSchema,
});
export type PlanCatalog = z.infer<typeof PlanCatalogSchema>;

// Read best-effort from Stripe; each field is null when the price omits it.
export const SubscriptionPriceSchema = z.object({
  amount: z.number().int().nullable(),
  currency: z.string().nullable(),
  interval: z.string().nullable(),
});
export type SubscriptionPrice = z.infer<typeof SubscriptionPriceSchema>;

export const BillingResponseSchema = z.object({
  accounts: z.array(AccountEntitlementsSchema),
  plans: PlanCatalogSchema,
  checkoutEnabled: z.boolean(),
  // Null when checkout is not configured or Stripe could not be reached —
  // pricing is display-only, so its absence never blocks the page.
  price: SubscriptionPriceSchema.nullable(),
});
export type BillingResponse = z.infer<typeof BillingResponseSchema>;

// Body for BOTH POST /billing/checkout and POST /billing/portal — one strict
// parser, shared with the public-scan request.
export const BillingInstallationRequestSchema = z.object({
  installationId: z.number().int().positive(),
});
export type BillingInstallationRequest = z.infer<typeof BillingInstallationRequestSchema>;

// ---------------------------------------------------------------------------
// Named error bodies (B9) — a structural sniff is a missing type
// ---------------------------------------------------------------------------

// The default non-2xx body (~20 sites, 9 statuses). Branch on the HTTP status,
// never on the message text.
//
// There is deliberately NO `code` field here, and that is a decision rather than
// an omission. `code` in this system means `NpmGuardError.code` — a value that is
// stable forever, that clients branch on, and that `test_error_taxonomy.py`
// mechanically requires to have a producer. Adding it to the default body would
// put a field on ~20 sites across 9 statuses that could only ever be null at every
// one of them, which is the "declared value with no producer" defect this contract
// has just finished deleting elsewhere. Where a code IS the answer, the shape is a
// NAMED error body (`ReauthRequired`, `CapExceeded`, `ScanInFlight`,
// `ValidationFailed` below) — one type per distinguishable failure, discriminated
// structurally, so an exhaustive client handler is checkable.
export const ApiErrorSchema = z.object({
  error: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// One thing wrong with a request body. NpmGuard's own vocabulary, deliberately NOT
// Pydantic's `ErrorDetails`: engine-side these are mapped down from
// `ValidationError.errors()`, dropping `type` and `input`. Freezing Pydantic's
// internal error shape onto the wire would make a library upgrade a breaking
// contract change, and `input` echoes submitted values back out of a route that
// also accepts payment proofs.
export const ValidationIssueSchema = z.object({
  // Dotted path to the offending field, `""` for the body root.
  field: z.string(),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

// 400 from every route that parses a request body through `api.py::_body`.
//
// This DECLARES a key the wire was already carrying: `_body` emitted `details`
// against an `ApiError` schema that does not mention it. Zod strips unknown keys,
// so nothing broke — which is exactly the failure mode worth closing, because a
// consumer generated from the contract could not see the field while a consumer
// hand-reading JSON could come to depend on it.
//
// INVARIANT: `details` is empty ⟺ the body was not parseable JSON at all. Pydantic
// never reports a validation failure with zero issues, so an empty list can only
// mean the parse never got as far as the schema — and a client can tell "your JSON
// is malformed" from "your fields are wrong" without reading `error`'s prose.
export const ValidationFailedSchema = z.object({
  error: z.string(),
  details: z.array(ValidationIssueSchema),
});
export type ValidationFailed = z.infer<typeof ValidationFailedSchema>;

// 401 when the stored GitHub token no longer works. Distinct from a plain 401
// because the fix is "restart the OAuth flow", not "show an error".
export const ReauthRequiredSchema = z.object({
  error: z.string(),
  reauth: z.literal(true),
});
export type ReauthRequired = z.infer<typeof ReauthRequiredSchema>;

// 503 from every panel route while the GitHub App is unconfigured. Same shape as
// ApiError, named separately because the client behaviour differs — hide the
// panel, do not retry — and today it is unhandled entirely.
export const AppNotConfiguredSchema = z.object({
  error: z.string(),
});
export type AppNotConfigured = z.infer<typeof AppNotConfiguredSchema>;

export const CapResourceSchema = z.enum(["protected_repos", "monthly_audits"]);
export type CapResource = z.infer<typeof CapResourceSchema>;

// 402 on scan / protect. NOT on the public scan: that surface is not billed, so
// its ceiling degrades coverage instead of opening a paywall. Carries FRESH
// entitlements so the client patches its ledger from the very response that
// opened the paywall (F-E3) — no second request, no stale quota render.
export const CapExceededSchema = z.object({
  error: z.string(),
  cap: z.literal(true),
  resource: CapResourceSchema,
  installationId: z.number().int(),
  entitlements: AccountEntitlementsSchema,
});
export type CapExceeded = z.infer<typeof CapExceededSchema>;

// 429 from the public scan when the requester already has `limit` scans live.
// A concurrency bound, not a quota — named separately from CapExceeded because
// the honest answer is "wait for one to finish" and never "upgrade".
export const TooManyLiveScansSchema = z.object({
  error: z.string(),
  limit: z.number().int().positive(),
});
export type TooManyLiveScans = z.infer<typeof TooManyLiveScansSchema>;

// 409 from every scan trigger, repo and public alike. NOT a red banner: a set is
// already live and streamable, so the caller streams `scanId` instead. Naming it
// is what forces both call sites to agree on that.
export const ScanAlreadyRunningSchema = z.object({
  error: z.string(),
  scanId: z.number().int(),
});
export type ScanAlreadyRunning = z.infer<typeof ScanAlreadyRunningSchema>;

// ---------------------------------------------------------------------------
// Small success bodies — previously inline literals at the call sites
// ---------------------------------------------------------------------------

// POST /panel/repo/{id}/scan · /resync · public-repo scan. `scanId` is the
// set id to stream.
export const ScanStartedResponseSchema = z.object({
  scanId: z.number().int(),
});
export type ScanStartedResponse = z.infer<typeof ScanStartedResponseSchema>;

// POST/DELETE /panel/repo/{id}/protect.
export const OkResponseSchema = z.object({
  ok: z.literal(true),
});
export type OkResponse = z.infer<typeof OkResponseSchema>;

// POST /panel/alerts/seen. `updated` is the number of alerts acked — carried so
// the client can patch its unseen count instead of refetching the feed.
export const AlertsSeenResponseSchema = z.object({
  ok: z.literal(true),
  updated: z.number().int().nonnegative(),
});
export type AlertsSeenResponse = z.infer<typeof AlertsSeenResponseSchema>;

// POST /billing/checkout — Stripe Checkout redirect.
export const BillingCheckoutResponseSchema = z.object({
  url: z.string(),
  sessionId: z.string(),
});
export type BillingCheckoutResponse = z.infer<typeof BillingCheckoutResponseSchema>;

// POST /billing/portal — Stripe customer-portal redirect.
export const BillingPortalResponseSchema = z.object({
  url: z.string(),
});
export type BillingPortalResponse = z.infer<typeof BillingPortalResponseSchema>;
