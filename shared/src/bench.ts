import { z } from "zod";
import { VerdictSchema } from "./models.js";
import { AuditSetSchema } from "./panel.js";

/**
 * Bench — pinned corpora driven through the LIVE engine via the normal admission
 * path (F-G1), and the read-only surfaces over the results (§4.3, §5.3).
 *
 * THE RULE THIS DOMAIN IS BUILT AROUND (F-G2): a run item stores OBSERVATIONS
 * only. There is no `detected`, no `status`, no `proofKinds`, no per-item
 * outcome anywhere below. Every judgement — detected / missed / false positive /
 * inconclusive — is DERIVED at read time from `expected × observed`. Bench v1
 * died because it stored judgements computed from report fields
 * (`expectedCapabilities ⊆ capabilities`, `proof.kind === "TEST_CONFIRMED"`)
 * that no longer exist: the rows became unreadable instead of re-projectable.
 * Because a row keeps its `auditId` and the report stays on disk, a scoring-rule
 * change re-projects all history.
 *
 * O-2 — the scoring rule — is RESOLVED (D-6's eight-value outcome taxonomy), so
 * the vocabulary and the rates are now declared, at the bottom of this file. Note
 * what did NOT change: the outcome of an observation is still nowhere on
 * `BenchRunItem`. `BenchOutcome` and `BenchEntryBucket` appear only inside
 * `BenchRunMetrics`, which is a READ-TIME PROJECTION — the taxonomy travels on the
 * wire, never into storage, so the next taxonomy edit re-projects all history
 * exactly as before. Declaring a judgement and storing one are different acts, and
 * only the second is what killed v1.
 *
 * WIRE nullability rule as in panel.ts: `.nullable()`, never `.optional()`.
 */

// ---------------------------------------------------------------------------
// Corpus + entries — the `expected` side, pinned
// ---------------------------------------------------------------------------

// `negative-control` entries are expected SAFE; they are what makes a
// false-positive rate measurable at all.
export const BenchCorpusSourceSchema = z.enum(["datadog", "negative-control", "watchlist"]);
export type BenchCorpusSource = z.infer<typeof BenchCorpusSourceSchema>;

// A pinned corpus, keyed by (name, version) — immutable once runs reference it.
export const BenchCorpusSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  version: z.string(),
  // The dataset identity a run is described by (F-G5). Distinct from `version`
  // only because a corpus can be re-cut from the same dataset release.
  datasetVersion: z.string(),
  source: BenchCorpusSourceSchema,
  // Hash over the entry manifest: a corpus whose content changed under a fixed
  // (name, version) is a corrupted comparison, and this is how it is caught.
  manifestSha: z.string(),
  generatedAt: z.string(),
  // Convenience for the picker (§5.3 "corpora + entry counts") — derived, and
  // always equal to the number of `bench_entries` rows for this corpus.
  entryCount: z.number().int().nonnegative(),
});
export type BenchCorpus = z.infer<typeof BenchCorpusSchema>;

// One fixture in a corpus: the EXPECTATION, authored once. Never mutated by a
// run — a run only ever appends observations that reference it.
export const BenchEntrySchema = z.object({
  id: z.number().int(),
  corpusId: z.number().int(),
  // Unique within the corpus; the on-disk fixture directory name. Corpus
  // fixtures are live malware — never installed or executed outside the Docker
  // sandbox, never committed (F-G7).
  fixtureName: z.string(),
  packageName: z.string(),
  version: z.string(),
  // Corpus-defined stratum (e.g. "compromised", "malicious-intent",
  // "negative-control"). A free string, not an enum: it is the dataset's
  // taxonomy, and per-stratum reporting must survive the dataset re-cutting it.
  category: z.string(),
  // What a correct audit should conclude. The audit-core Verdict, because that
  // is what the engine produces per package; ERROR is an OBSERVED failure to
  // conclude, never an expectation.
  expectedVerdict: VerdictSchema,
  // Provenance, all nullable because the upstream dataset supplies them
  // unevenly — a missing rationale is a gap in the dataset, not in the row.
  discoveryDate: z.string().nullable(),
  rationale: z.string().nullable(),
  sourceId: z.string().nullable(),
});
export type BenchEntry = z.infer<typeof BenchEntrySchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// One `(role, model)` pair a run ACTUALLY billed against, read from
// `llm_attempts.actual_model` (store.observed_models). OBSERVED, never configured
// — see the note on `modelId` below.
export const BenchObservedModelSchema = z.object({
  // The phase that made the call: intent, flag, hypothesis, propose, agent, judge.
  // A free string, not an enum: the roles are the engine's call sites, and a new
  // phase must show up in a run's description without a contract edit.
  role: z.string(),
  model: z.string(),
});
export type BenchObservedModel = z.infer<typeof BenchObservedModelSchema>;

// One execution of a corpus. Its comparability identifiers are `engineSha`,
// `observedModels`, `sandboxImageDigest` and — via `corpusId` — the corpus's
// `datasetVersion` + `manifestSha` (F-G5). A run missing one of them cannot be
// compared to another, which is why the first three are non-nullable.
//
// Progress, status, timing and the outcome rollup live on the embedded
// `set` (origin `bench_run`), so there is ONE progress type across panel and
// bench rather than a second counters object. NOTE: `set.rollup` counts audited
// (name, version) pairs, while there are `runsPerEntry` observations per entry —
// so `rows[].items.length` does not sum to `set.rollup.total`.
//
// A run is produced by `npmguard-ops bench run`, which drives the corpus through
// the ordinary admission path. There is NO HTTP write surface: no bench route
// may enqueue work, so a bench run can never bypass the capacity owner.
export const BenchRunSchema = z.object({
  id: z.number().int(),
  corpusId: z.number().int(),
  engineSha: z.string(),
  // The reproducibility identifier, OBSERVED (B-11 / methodology §7.6). One
  // `modelId` string cannot describe a run: `intent`/`flag` bill on
  // `triage_model` while `hypothesis`/`propose`/`agent`/`judge` bill on
  // `investigation_model`, and every role carries a cross-provider fallback tail,
  // so a single audit can bill several models. Empty when no LLM attempt was
  // recorded — which is a run with no observed model, not a run to describe from
  // config.
  observedModels: z.array(BenchObservedModelSchema),
  // INVARIANT: `modelId` is a DERIVED label over `observedModels`
  // (`role=model|role=model`, sorted) and is `null` exactly when `observedModels`
  // is empty. It is never filled from configuration, and it is never `""`: a
  // declared model that a fallback silently overrode is precisely the
  // comparability failure this field exists to expose, and an empty string is the
  // same zero-value stand-in that `tokenCostUsd` and `coverage` refuse. A reader
  // who needs the truth reads `observedModels`; `modelId` is for grouping and for
  // a caption.
  //
  // Enforced at the PRODUCER (`read.py`'s `model_id`, which returns `... or None`)
  // rather than by the type, and not for want of trying: `.min(1).nullable()` makes
  // the Python codegen emit a field-named `ModelId` wrapper class into the shared
  // contract module — the hazard already documented on `BenchRunItem`'s nullable
  // numerics below — which would cost every Python reader a `.root` and every test
  // a string comparison. One producer is a cheaper guarantee than that.
  modelId: z.string().nullable(),
  sandboxImageDigest: z.string(),
  runsPerEntry: z.number().int().positive(),
  set: AuditSetSchema,
  // What the run cost in LLM spend. Null while the run is in flight or when the
  // provider did not report usage — never 0 as a stand-in for "unknown", since a
  // reader must know a re-run's cost before starting one (F-G4).
  tokenCostUsd: z.number().nullable(),
});
export type BenchRun = z.infer<typeof BenchRunSchema>;

// One audit attempt: `(runId, entryId, runIndex)`. OBSERVATIONS ONLY — see the
// file header. Adding a judgement field here is the one change this domain
// cannot absorb.
//
// INVARIANT: `auditId === null` ⟹ `error !== null` (the attempt never reached an
// audit). While `auditId` is non-null the report is on disk and every derived
// metric is re-projectable from it.
// INVARIANT: `verdict === null` ⟺ the audit did not conclude — read `error` for
// why. That is the observation an ERROR outcome is DERIVED from; the ERROR label
// is never stored.
export const BenchRunItemSchema = z.object({
  runId: z.number().int(),
  entryId: z.number().int(),
  // 0-based repeat index within the run: `runsPerEntry` observations per entry
  // are what make a rate estimable rather than a single sample.
  runIndex: z.number().int().nonnegative(),
  auditId: z.string().nullable(),
  verdict: VerdictSchema.nullable(),
  // The nullable numerics below are unconstrained on purpose: a
  // nullable+constrained integer makes the Python codegen emit a field-named
  // wrapper class (`DurationMs`, `TokensPrompt`, …) into the shared contract
  // module. Null means "not observed", never 0.
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  // Observed counts off the report, kept so the stricter "proved by running it"
  // tier is derivable without re-reading every report.
  confirmedCount: z.number().int().nonnegative(),
  // The dealbreaker CHECK that fired (a fact the audit observed), null if none.
  // Not a boolean: which check fired is what a re-projection needs.
  dealbreaker: z.string().nullable(),
  tokensPrompt: z.number().int().nullable(),
  tokensCompletion: z.number().int().nullable(),
});
export type BenchRunItem = z.infer<typeof BenchRunItemSchema>;

// ---------------------------------------------------------------------------
// Read surfaces (§5.3)
// ---------------------------------------------------------------------------

// GET /bench/corpora
export const BenchCorporaResponseSchema = z.object({
  corpora: z.array(BenchCorpusSchema),
});
export type BenchCorporaResponse = z.infer<typeof BenchCorporaResponseSchema>;

// GET /bench/runs — newest first. Carries descriptors and the set rollup, and no
// rates: a rate is a projection over one run's observations and belongs in
// `BenchRunMetrics`, which is fetched per run. A list route that inlined rates
// would be publishing scores for runs the reader never opened, including
// unpublishable ones (§4.5's VOID gate).
export const BenchRunsResponseSchema = z.object({
  runs: z.array(BenchRunSchema),
});
export type BenchRunsResponse = z.infer<typeof BenchRunsResponseSchema>;

// One per-entry row: the expectation and every observation made against it,
// co-located so `expected × observed` needs no client-side join.
export const BenchRunRowSchema = z.object({
  entry: BenchEntrySchema,
  // `runsPerEntry` long when the run completed; shorter while it is running or
  // if an attempt was never made.
  items: z.array(BenchRunItemSchema),
});
export type BenchRunRow = z.infer<typeof BenchRunRowSchema>;

// GET /bench/runs/{run_id} — the observations. NOT folded together with
// `BenchRunMetrics`: see the note above `BenchRunMetricsSchema` for why the
// projection is its own payload rather than a fourth key here.
export const BenchRunDetailResponseSchema = z.object({
  corpus: BenchCorpusSchema,
  run: BenchRunSchema,
  rows: z.array(BenchRunRowSchema),
});
export type BenchRunDetailResponse = z.infer<typeof BenchRunDetailResponseSchema>;

// GET /bench/runs/{run_id}/rows — the drill-down. The `?outcome=` filter §5.3
// sketches is still absent, and now for a smaller reason than O-2: the outcome
// vocabulary exists (`BenchOutcomeSchema`) but the wire carries observations and
// the reader filters, so adding the filter adds a query param rather than a
// stored field.
export const BenchRunRowsResponseSchema = z.object({
  runId: z.number().int(),
  rows: z.array(BenchRunRowSchema),
});
export type BenchRunRowsResponse = z.infer<typeof BenchRunRowsResponseSchema>;

// ---------------------------------------------------------------------------
// The derived projection (§4.2, §5.3–§5.5, §7.1) — D-6's answer to O-2
// ---------------------------------------------------------------------------

// §4.2 — the per-OBSERVATION outcome. Eight values, exhaustive and disjoint.
// Produced by `projector.classify`, and produced NOWHERE else: it is derived from
// `expected × observed` at read time and is never written to a row.
export const BenchOutcomeSchema = z.enum([
  // `expectedVerdict: DANGEROUS` and the engine said DANGEROUS. Split because §4.4
  // treats the dealbreaker short-circuit as a DISJOINT mechanism, not a weaker tier
  // — it returns before any hypothesis exists, so it must not be averaged in with
  // "proved by running it".
  "CAUGHT_PROVED",
  "CAUGHT_STRUCTURAL",
  "MISSED",
  "CLEARED",
  "FALSE_ALARM_PROVED",
  "FALSE_ALARM_STRUCTURAL",
  // The engine ran and honestly could not conclude. Stays IN the detection
  // denominator, so a fragile engine cannot buy a good score by failing more often.
  "ABSTAINED",
  // The observation failed to be MADE (sandbox, provider, admission, corpus bug).
  // Excluded from every numerator and denominator, and counted and named instead.
  "VOID",
]);
export type BenchOutcome = z.infer<typeof BenchOutcomeSchema>;

// §4.2 — the per-ENTRY bucket, because the entry is the unit of analysis (B-4)
// and `runsPerEntry` observations of one entry are not `runsPerEntry` independent
// samples. `CAUGHT_SOMETIMES` is the bucket v1 could not express and is the direct
// measurement of what a user experiences.
export const BenchEntryBucketSchema = z.enum([
  "UNOBSERVED",
  "CAUGHT_ALWAYS",
  "CAUGHT_SOMETIMES",
  "MISSED_ALWAYS",
  "ABSTAINED_ALWAYS",
  "NEVER_CAUGHT_MIXED",
  "CLEARED_ALWAYS",
  "CLEARED_SOMETIMES",
  "FALSE_ALARM_ALWAYS",
  "MIXED",
]);
export type BenchEntryBucket = z.infer<typeof BenchEntryBucketSchema>;

// A rate that was actually measured: `n >= 1`, so `k/n` and its Wilson 95%
// interval all exist. `point` is exactly `k/n` and is carried rather than left to
// the client only so that a caption and a chart cannot disagree about rounding.
export const BenchMeasuredRateSchema = z.object({
  k: z.number().int().nonnegative(),
  n: z.number().int().positive(),
  point: z.number().min(0).max(1),
  // The Wilson 95% score interval, preferred over Wald (`p̂ ± z√(p̂(1−p̂)/n)`),
  // which produces malformed intervals near 0 and 1 — exactly the regime a strong
  // auditor lives in. `lower` is the HEADLINE (B-5, §5.4): a bound cannot
  // overclaim, and a small `n` yields a weak bound even at a perfect score, which
  // makes corpus size self-motivating instead of an argument.
  lower: z.number().min(0).max(1),
  upper: z.number().min(0).max(1),
});
export type BenchMeasuredRate = z.infer<typeof BenchMeasuredRateSchema>;

// The other half of the rate domain: nothing was measured. `k` and `n` are pinned
// to the literal `0` and all three statistics are `null`.
export const BenchEmptyRateSchema = z.object({
  k: z.literal(0),
  n: z.literal(0),
  point: z.null(),
  lower: z.null(),
  upper: z.null(),
});
export type BenchEmptyRate = z.infer<typeof BenchEmptyRateSchema>;

// INVARIANT: `point === null ⟺ n === 0`, and it is UNREPRESENTABLE otherwise —
// the two members of this union have no common inhabitant, so `{n: 0, point: 0}`
// and `{n: 5, point: null}` both fail to parse, in TypeScript AND in the generated
// Pydantic model. Two dishonesty classes die with it:
//   - an empty corpus rendering as "0%" instead of "no corpus" (N-14). A zero
//     denominator is not a zero score, and the difference is the whole claim.
//   - a rate arriving without its denominator. A consumer literally cannot receive
//     `point` without `n`, so §5.4's "a tile takes (k, n), never a bare p" is
//     enforced by the type rather than asked for in a review.
// Expressed as a union rather than as one object with nullable statistics and a
// refinement, because a refinement is invisible to JSON Schema and therefore
// invisible to the engine: the invariant has to survive codegen to be worth
// anything, since the engine is the producer.
export const BenchRateSchema = z.union([BenchMeasuredRateSchema, BenchEmptyRateSchema]);
export type BenchRate = z.infer<typeof BenchRateSchema>;

// §5.2 — the band, not a number. At `runsPerEntry === 1` the two are the SAME
// measurement and `stabilityMeasured` says so, rather than implying a stability
// observation nobody made.
export const BenchDetectionBandSchema = z.object({
  // Entries caught on EVERY non-VOID observation / n_mal.
  reliable: BenchRateSchema,
  // Entries caught on AT LEAST ONE non-VOID observation / n_mal.
  optimistic: BenchRateSchema,
});
export type BenchDetectionBand = z.infer<typeof BenchDetectionBandSchema>;

// §7.1 — per-audit wall clock, summed over each report's own phase trace so it is
// comparable against the engine's configured envelope and excludes queue wait.
// Null when no observation had a duration; never 0, which would claim an
// instantaneous audit.
export const BenchLatencySchema = z.object({
  p50: z.number().int().nullable(),
  p95: z.number().int().nullable(),
  p99: z.number().int().nullable(),
});
export type BenchLatency = z.infer<typeof BenchLatencySchema>;

// §3.4.1 / B-12 — the evidentiary-coverage record for a run, produced by
// `bench.fidelity.counts_for` over the sealed run artifacts. Published BESIDE
// every rate and gating nothing: a fidelity defect biases toward false negatives,
// so a non-zero count means detection is understated while specificity is, if
// anything, flattered, and one threshold across both rates would be wrong.
//
// `fidelityDefects` is deliberately NARROWER than `anonymousRows`: a placeholder
// is only a defect when the same event's own bytes carried a resolvable target.
// Keeping the two separate is what stops a 5.7% headline being read as a 5.7% leak.
export const BenchCoverageSchema = z.object({
  describedEvents: z.number().int().nonnegative(),
  renderedRows: z.number().int().nonnegative(),
  anonymousRows: z.number().int().nonnegative(),
  fidelityDefects: z.number().int().nonnegative(),
  // A socket op rendered with a filesystem path inherited from a recycled fd. A
  // vague target starves the judge; a FALSE one misleads it, which is strictly
  // worse and cannot be recovered by a careful reader — hence its own counter.
  falseTargetEvents: z.number().int().nonnegative(),
  falseTargetRows: z.number().int().nonnegative(),
  predicateVersion: z.string(),
});
export type BenchCoverage = z.infer<typeof BenchCoverageSchema>;

// One corpus entry in the run report's primary object (F-G3 / §9). Carries the
// expectation, the per-observation outcomes, the bucket they aggregate to, and the
// audit ids they were derived from — so a reader can open the timelines and check
// a verdict for themselves, which §3.2.1 says the verdict alone cannot tell them.
export const BenchLedgerRowSchema = z.object({
  fixtureName: z.string(),
  packageName: z.string(),
  version: z.string(),
  category: z.string(),
  discoveryDate: z.string().nullable(),
  expectedVerdict: VerdictSchema,
  // `runsPerEntry` long, in run order. VOIDs are present here and dropped by the
  // bucket rule, so the exclusion is visible on the row it happened to.
  outcomes: z.array(BenchOutcomeSchema),
  bucket: BenchEntryBucketSchema,
  // Null for an attempt that was never admitted, which is exactly the case with no
  // report to read.
  auditIds: z.array(z.string().nullable()),
});
export type BenchLedgerRow = z.infer<typeof BenchLedgerRowSchema>;

// GET /bench/runs/{run_id}/metrics — everything §5.3, §5.5 and §7.1 publish,
// derived at read time from observations alone. This is the shape whose absence
// made G23's goal ("one full run yields rates with CIs, latency percentiles and a
// dollar cost") unsatisfiable inside the contract.
//
// NOT FOLDED into `BenchRunDetailResponse`, deliberately, for three reasons:
//   1. It is SELF-DESCRIBING on purpose (`runId`, `engineSha`, `datasetVersion`,
//      `manifestSha`, `coveragePredicate`). That is only worth anything if the
//      payload can travel alone — which is the same argument that puts `engineSha`
//      inside it rather than in metadata about it.
//   2. Folding would make the detail response carry every entry's expectation
//      THREE times: `rows[].entry`, `ledger[]`, and the `corpus`. Two spellings of
//      one fact in one payload is how a consumer ends up joining them.
//   3. A scorecard render would have to transfer every observation's tokens,
//      durations and errors to draw six tiles, and a run-LIST view that wants
//      headline rates could not reuse this shape at all if it were a key of the
//      detail response.
// The payload needs no wrapper key for the same reason: it already names its run.
export const BenchRunMetricsSchema = z.object({
  runId: z.number().int(),
  // INVARIANT: the identifiers that make these numbers poolable travel INSIDE the
  // payload, never alongside it. `pooled_engine_sha` REFUSES to combine runs whose
  // `engineSha` differs, because a fidelity fix changes what the engine can see and
  // a pre-fix MISSED is evidence about a renderer rather than about detection; the
  // corpus pair is here for the identical reason — averaging two datasetVersions is
  // averaging two questions. A metrics payload that omitted any of the three could
  // be averaged with another by a well-meaning reader, and nothing in the data would
  // stop them.
  engineSha: z.string(),
  datasetVersion: z.string(),
  manifestSha: z.string(),
  observedModels: z.array(BenchObservedModelSchema),
  runsPerEntry: z.number().int().nonnegative(),
  // False at N=1: the reliable and optimistic bands are then one measurement.
  stabilityMeasured: z.boolean(),
  // §4.5: false when the VOID share exceeds 5% of attempted observations. Such a
  // run is not a result, and §9 rule 5 requires the page to render the EXCLUSIONS
  // instead of the rates. The flag is carried rather than left to the client so
  // that the refusal is the engine's, not each renderer's.
  publishable: z.boolean(),
  detection: BenchDetectionBandSchema,
  missRate: BenchRateSchema,
  abstentionRate: BenchRateSchema,
  // Entries that were never caught but did not always MISS either — a mix of
  // misses and abstentions. Reported as a count beside `abstentionRate` because it
  // belongs to neither rate's numerator and hiding it would make the malware
  // buckets look like they partition when they do not.
  neverCaughtMixed: z.number().int().nonnegative(),
  specificity: BenchRateSchema,
  falseAlarmRate: BenchRateSchema,
  // §4.4 — MANDATORY companions to the detection tile: detection without the
  // dealbreaker share is uninterpretable, because a corpus rich in shell-pipe
  // install scripts scores well at almost no cost. `proofShare + dealbreakerShare`
  // is 1 over caught observations.
  proofShare: BenchRateSchema,
  dealbreakerShare: BenchRateSchema,
  // §4.5 — the exclusions, counted and NAMED. `voidCauses` is keyed by the stable
  // `NpmGuardError` code (never by message text), so a reader can re-bucket a
  // boundary call themselves instead of taking the projector's word for it.
  attempted: z.number().int().nonnegative(),
  voidCount: z.number().int().nonnegative(),
  // Null when nothing was attempted — a run with no observations has no share,
  // and 0.0 would read as "clean".
  voidShare: z.number().nullable(),
  voidCauses: z.record(z.number().int()),
  // Entries with no non-VOID observation at all. Outside every `n` by
  // construction, so they are reported here rather than silently counted as misses.
  unobservedEntries: z.number().int().nonnegative(),
  // §5.5 — the honest headline for "how deterministic is this PIPELINE" (sensors,
  // renderer and model jointly), not "how deterministic is this model".
  unanimity: BenchRateSchema,
  // Every `*_SOMETIMES` entry by name: short, concrete, and the first thing a
  // skeptic should be shown.
  flips: z.array(z.string()),
  latencyMs: BenchLatencySchema,
  // Null when ANY contributing observation is unknown, never a partial total: a
  // sum that silently omits an unobserved part is worse than an absent one,
  // because a reader cannot tell it is partial.
  tokensPrompt: z.number().int().nullable(),
  tokensCompletion: z.number().int().nullable(),
  tokenCostUsd: z.number().nullable(),
  // INVARIANT: `coverage` is null — NEVER a zeroed record — while the artifact
  // tier is unreachable for a run. `ArtifactStore` is rooted at `AuditLog.run_dir`
  // (timestamp + package name), so it is not joinable to an `auditId` yet and the
  // resolver returns nothing rather than guessing. A zeroed record would claim
  // "we measured coverage and found no defects", which is a measurement nobody
  // made and the strongest possible version of the claim.
  coverage: BenchCoverageSchema.nullable(),
  // Published even while `coverage` is null, because a fidelity number is
  // meaningless without both its `engineSha` and the predicate that produced it —
  // and a reader needs to know which predicate the null refers to.
  coveragePredicate: z.string(),
  // F-G3 / §9: the per-entry ledger IS the primary object, sorted failures-first
  // by construction rather than by editorial choice, and always complete —
  // including the entries that worked.
  ledger: z.array(BenchLedgerRowSchema),
});
export type BenchRunMetrics = z.infer<typeof BenchRunMetricsSchema>;
