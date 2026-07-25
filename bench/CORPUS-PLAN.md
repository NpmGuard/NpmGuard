# Corpus plan — getting from 20 all-DANGEROUS entries to a corpus D-7 can publish from

Scope: the **dataset**, not the runner. The engine-side bench package
(`engine/npmguard/bench/`) is built; it refuses to run because the corpus it
would run on does not support a publishable number and its fixtures are not on
disk. This plan is the ordered set of changes that removes both blockers, and
the decisions it takes that the methodology does not.

Inputs: D-7 (platform design §7 decisions log) and `METHODOLOGY-V2-DRAFT.md`
§6.4–§6.5.1. Everything in §1 below was read off disk rather than carried over
from either document.

---

## 1. What is actually on disk

| Fact | Value | Consequence |
|---|---|---|
| `dataset/manifest.full.json` | valid v2 manifest, `datasetVersion 0.2.0-datadog`, **20 entries** | loads; too small to publish from |
| its `expectedVerdict` values | 20 × `DANGEROUS` | **specificity is unmeasurable** — no denominator |
| its strata | 14 `datadog-compromised` (2025-09 →), 6 `datadog-malicious-intent` (2024 only) | temporally disjoint, so a stratum comparison is confounded with recency (§6.3c) |
| fixtures `sandbox/test-fixtures/test-pkg-bench-dd-*` | **none** | `runner._missing_fixtures` refuses before admitting anything |
| `dataset/datadog/corpus.json` | 50 samples (25 + 25), seed 42, pinned to a dataset commit | a **selection**, not a manifest; nothing converts one to the other |
| `src/datadog/select.ts` | targets **50 per class**, no date filter | re-running yields 100 candidates; the date confound is not addressed |
| `src/seeds/catalog.ts` | **28** integrity-pinned benign packages | the benign material exists; it is 28, not 75 |
| `src/seeds/fetch.ts` | materialises into `dataset/seeds/<name>` | **not** into `sandbox/test-fixtures/`, so no benign package is runnable today |
| `engine/config/watchlist-packages.json` | 165 bare package names, unversioned | the selection pool for controls |
| `engine/config/watchlist-smoke.json` | absent | `REAL_PACKAGES.md` cites it; that runbook is v1 |

Two gaps are load-bearing and are named nowhere in the design documents:

- **Nothing generates a manifest.** The 20 entries were authored by hand. Both
  expansion halves need a generator that emits exactly `corpus.ENTRY_FIELDS` —
  the loader rejects any extra key, by design.
- **Benign packages are not runnable.** The seeds pipeline stops one step short
  of a fixture directory the runner can see.

## 2. Target

D-7, unchanged:

| Component | Entries | N | Audits |
|---|---|---|---|
| Datadog malware, date-balanced across strata | 50 | 2 | 100 |
| Negative controls | 75 | 2 | 150 |
| Variance probe, selected *after* the main run | ≤10 | 5 | ≤30 |
| **Total** | **125** | | **≤280** |

75 controls is not a round number: a perfect score on 73 clean entries is the
smallest corpus that demonstrates specificity ≥95%. Minimum viable tier is
40 + 40 (≥91.2% both sides), and the honest trim order is probe → controls,
**never** entries traded for higher N.

## 3. Decisions this plan takes

**D-C1 — one mixed corpus, not two.** A run pins exactly one `corpus_id`
(`store.create(descriptor, corpus.id)`), and `projector` already splits its
result set into malware and controls by `entry.expected_verdict`. Recall and
specificity from one run therefore require one manifest holding both. Two
corpora would produce two runs, each with a structurally empty half.

**D-C2 — a corpus is a directory that contains itself, selected by path.**

```
bench/corpora/<name>/
  manifest.json     committed — the pinned expectations
  packages/         gitignored, regenerable, live malware
```

`--corpus <path>` takes a relative or absolute path to a manifest. No corpus
registry, no directory-name selector, no counts on the command line: a corpus is
authored and committed, not parameterized at run time, and running a bigger or
smaller one means pointing at a different manifest.

**D-C3 — each entry declares where its bytes are, and the engine infers
nothing.** An entry carries either a `path` relative to its manifest, or a
`packageName@version` with an `integrity` pin:

```json
{ "path": "packages/ember-browser-services-5.0.3", "expectedVerdict": "DANGEROUS" }
{ "packageName": "chalk", "version": "5.6.2", "integrity": "sha512-…",
  "expectedVerdict": "SAFE" }
```

The runner joins manifest-dir + `path` and sends the result as the audit's
`localPath`. Controls resolve through the real registry path a user would take,
pinned by npm's guarantee that a published version's bytes never change; their
`integrity` is verified by the bench tooling at lock time, so no pin has to
travel through `/audit`.

This replaces the `test-pkg-` prefix rule, which had encoded "where the bytes
come from" into the package name and left four consumers re-deriving it. Corpus
packages therefore carry their **real** names, and run rows name the actual
package.

**D-C4 — the 20-entry corpus stays as a smoke corpus.** It is the only thing
that exercises the harness end to end for a tenth of the cost. It must never
produce a published headline (§6.5).

## 4. Ordered work

Each item states what it produces and how it is checked. Items 1–4 are dataset
work and spend no LLM budget.

**1 · Date-balance the Datadog selection.** `select.ts` gains a discovery-date
floor applied per class, and the per-class target drops to 25 + 25. Today all 6
`malicious_intent` entries are from 2024 and all 14 `compromised` from 2025-09
or later, so any measured difference between strata is equally explicable as
recency — the strata are not comparable until their date ranges overlap.
Re-running re-pins `datasetCommitSha`, so the existing 50 samples are replaced,
not extended.
*Checked by:* the emitted `corpus.json` has 25 per class and overlapping
per-class date ranges.

**2 · Select 75 controls from the 165-package watchlist.** The watchlist is bare
names; each selection needs a resolved version and its published
`dist.integrity`, which is what `seeds/lock.ts` already does. Selection
criteria are `catalog.ts`'s own, kept: currently published, non-deprecated,
≥10k weekly downloads, behaviourally diverse, loadable in isolation, source
present in the tarball. The existing 28 seeds carry over where they appear in
the watchlist.
*Checked by:* `npm run verify-loads` passes for all 75; no empty `integrity`.

**3 · Lock the control pins.** Controls need no staging — they resolve from the
registry at run time. What they need is a verified `integrity` recorded in the
manifest, which is what `seeds/lock.ts` already produces.
*Checked by:* every control entry has a non-empty `integrity` that matches the
registry's published `dist.integrity` for that exact version.

**4 · Write the manifest generator.** New `src/manifest.ts`, emitting
`corpora/<name>/manifest.json` from `datadog/corpus.json` + the seed catalog.
Categories are
`datadog-compromised`, `datadog-malicious-intent`, `negative-control`;
`expectedVerdict` is `DANGEROUS` for Datadog rows and `SAFE` for controls.
`rationale` on a control states why it is expected clean, not merely that it is.
*Checked by:* `corpus.load_manifest` accepts it, `entry_id` uniqueness holds
(the loader asserts it — a collision silently scores two entries as one), and
the entry count is 125.

**5 · Materialise the malware packages.** `npm run datadog:fetch`, into the
corpus's own `packages/`. These are live malware (F-G7): never installed, never
executed outside the Docker sandbox, never committed. The runner checks only
that the directory *exists* — it never reads or copies one, and that property is
deliberate.

**6 · Smoke on the 20-entry corpus.** One N=1 run to exercise admit → observe →
project end to end before the real corpus spends anything. Note there is nothing
to migrate for it: a bench run is an `audit_set`, and its two irreducible facts
(the pinned descriptors, the `(entry, runIndex) → auditId` mapping) are appended
to the durable event log, so the domain declares no tables of its own.

**7 · The full run.** Gated on the owner — see §5.

## 5. What this plan does not decide

**O-7 — the model tier.** A full run is ≈17.0M input + 2.3M output tokens,
which prices between ≈$8 and ≈$262 depending on configuration. That is a
detection-validity decision before it is a budget one: a cheap tier has returned
false-SAFE on textbook exfiltration, and benchmarking a tier that would not ship
measures the wrong engine. Not an agent's call, and not a blocker for items 1–6.

**D-9 — the fidelity prerequisite.** Publishing rates from an engine whose
renderer drops facts measures the rendering lottery. The remaining item is the
two committed recordings under `engine/demo-data/`, and a re-record changes the
judge prompt — an owner decision with a dollar attached.

**The variance probe.** Demand-driven by design: its entries are drawn from what
the main run reveals (entries that flipped, and entries unanimous in outcome but
varying in capture or fidelity). If nothing flipped and fidelity held constant,
the probe costs nothing and that null result is the finding.

## 6. Corpus sizes to author

Sizes are corpora, not flags. The dev corpus exists so the pipeline can be
changed and re-run cheaply; the publish corpus is the one §2 sizes.

| Corpus | malware | controls | audits at N=2 |
|---|---|---|---|
| `smoke-5` | 5 | 5 | 20 |
| publish tier | 50 | 75 | 250 |

Five clean packages license "specificity ≥47%", so the dev corpus is a harness
test and never a headline.
