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
 * The scoring rule itself is UNRESOLVED (O-2), so it is deliberately absent from
 * this contract: no outcome vocabulary, no rates, no CIs. Modelling it now would
 * be guessing a question, which is exactly the v1 failure in a new place.
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

// One execution of a corpus. Fully described by (datasetVersion, engineSha,
// modelId, sandboxImageDigest) (F-G5) — a run missing any of them cannot be
// compared to another, which is why none of the four is nullable.
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
  modelId: z.string(),
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

// GET /bench/runs — newest first. Carries no derived metrics: until O-2 settles
// the scoring rule, a run summary is exactly its descriptors plus its set
// rollup, and every rate is computed by the reader from the rows below.
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

// GET /bench/runs/{run_id}
export const BenchRunDetailResponseSchema = z.object({
  corpus: BenchCorpusSchema,
  run: BenchRunSchema,
  rows: z.array(BenchRunRowSchema),
});
export type BenchRunDetailResponse = z.infer<typeof BenchRunDetailResponseSchema>;

// GET /bench/runs/{run_id}/rows — the drill-down. The `?outcome=` filter §5.3
// sketches is a DERIVED projection whose vocabulary is O-2's to decide, so it is
// not in the contract yet: the wire carries observations, and the reader
// filters. Adding the filter later adds a query param, not a stored field.
export const BenchRunRowsResponseSchema = z.object({
  runId: z.number().int(),
  rows: z.array(BenchRunRowSchema),
});
export type BenchRunRowsResponse = z.infer<typeof BenchRunRowsResponseSchema>;
