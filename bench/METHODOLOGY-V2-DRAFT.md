# NpmGuard Benchmark — Methodology v2 (draft)

_Version 2.0-draft · 2026-07-25 · supersedes v1.1 (2026-04-26)_

**Status: design deliverable for Phase 7a of the v3 platform design
(`docs/specs/2026-07-24-platform-v3-system-design.md` §7, goals G20/G21). No code.**
This document answers open questions **O-2** (what replaces the v1 detection
rule) and **O-3** (how big the corpus is), and is meant to be executed and
attacked by someone who did not write it.

Every claim about what the engine does carries a `file:line`. If a citation and
the code disagree, the code wins and this document is wrong.

---

## 0. What this document decides

| # | Decision | Where |
|---|---|---|
| **B-1** | Detection is scored on `verdict`, not on capability sets. `detected = verdict == "DANGEROUS"`. | §4.2 |
| **B-2** | A catch splits into `CAUGHT_PROVED` (≥1 CONFIRMED hypothesis) and `CAUGHT_STRUCTURAL` (dealbreaker short-circuit). Dealbreaker **is** a third detection mode and is reported separately, never folded into "proved". | §4.2, §4.4 |
| **B-3** | An audit that did not conclude is never a miss and never a catch. It splits into `ABSTAINED` (the engine's own honest "could not determine") and `VOID` (harness/infra/corpus fault, excluded from all denominators and reported as an exclusion). | §4.5 |
| **B-4** | The unit of statistical analysis is the **corpus entry**, never the individual audit run. Wilson CIs are computed at `n = entries`. Replication is used to split catches into *always* vs *sometimes*, not to inflate `n`. | §5.2 |
| **B-5** | The headline number is a **Wilson 95% lower bound**, published as a band `[reliable, optimistic]` with `k/n` always visible. Never a bare point estimate. | §5.4 |
| **B-6** | v1.1's "precision" is actually **specificity** and is renamed. Precision proper is not computable from these corpora without a prevalence assumption, so it is not published. | §5.3 |
| **B-7** | Per-attack-class recall keyed on `claim.kind` is **not** published as recall. `claim.kind` is an LLM self-label. It is published as a descriptive distribution of the tool's own reasoning, clearly labelled as such. | §4.6 |
| **B-8** | **O-3: expand the corpus and drop N from 3 to 2.** At a fixed audit budget, entries buy CI width and replication does not. Target 50 malware + 75 negative controls at N=2, plus a ≤10-entry `m=5` probe whose purpose is **variance attribution**, not a stability rate (amended by B-14). Minimum publishable tier is 40 + 40 at N=2. | §6.5, §6.5.1 |
| **B-9** | The per-`auditId` report for re-projection is `audit_sessions.report` in the database, **not** `data/reports/<pkg>/<version>.json` — the on-disk path keeps only the last of N repeat audits. | §8.2 |
| **B-10** | The bench lane must force a fresh audit per run index. A cache hit is not an observation. | §8.3 |
| **B-11** | A single `modelId` cannot describe a run — the engine splits roles across two configured models plus a fallback tail. The reproducibility identifier must be the *observed* set of `(role, actual_model)` pairs. | §7.6 |
| **B-12** | **Per-run render fidelity and sensor capture are first-class recorded observations of every bench audit**, read from the sealed run artifact (a third observation tier). Without them a detection rate has an unquantified leak and replication variance is unattributable. | §3.4, §3.2.1 |
| **B-13** | Observations are **not comparable across an `engineSha` boundary that crosses a fidelity fix**. The projector refuses to pool them; a pre-fix `MISSED` is not evidence of a detection failure. | §3.4.3 |
| **B-14** | **The `m=5` probe measures the wrong stochasticity as specified.** Run-to-run variance is sensor + render + model; the probe attributes all of it to the model. It survives **re-scoped**: selected after the main run from the flip list and from fidelity-unstable entries, reporting a *decomposition* rather than a unanimity rate, and never ρ. D-7's entries-vs-replication reasoning is untouched. | §6.5.1 |
| **B-15** | When the judge gains `UNDECIDABLE`, the bench records `undecidableCount`, a `missingObservation` histogram over the closed vocabulary, and `undecidableGaps` (distinct causes, not node count). **The undecidable rate is itself a model-tier disqualifier feeding O-7.** D-6's 8-value taxonomy is extended, never replaced. | §4.5.1 |

**Scope note on what exists today.** Phase 0 already authored the bench contract
(`shared/src/bench.ts`, generated into `engine/npmguard/contract/models.py:599-663`),
and it deliberately omits the outcome vocabulary pending this document
(`shared/src/bench.ts:19-21`). Filling that gap is this document's job. Everything
else on the bench side is unbuilt: there are **no bench tables** in any migration,
no `npmguard-ops bench run` command despite the contract referencing one
(`shared/src/bench.ts:95-96`), and the surviving v1 reader
(`engine/npmguard/bench.py`, `GET /bench/results`) is scheduled for deletion
(G22). So this document constrains code that does not exist yet — which is the
cheapest moment to constrain it.

---

## 1. Problem statement

The space of npm supply-chain auditors includes `npm audit`, Snyk, Socket,
Phylum, OSSF Scorecard and others. Vendor-published numbers are typically not
reproducible (closed datasets, no re-runnable script), not statistically
rigorous (single point estimates, no intervals), silent on robustness, and
silent on cost.

**This part of v1.1 §1 is still exactly right and is kept verbatim in spirit.** A
serious benchmark must (a) be re-runnable by any reader, (b) produce numbers
with stated uncertainty, (c) report what the tool *fails* to catch as
prominently as what it catches, and (d) state what one run costs.

What v1.1 got wrong was not its ambitions. It was that its *measurement
primitives* were denormalized snapshots of a report schema that then changed
underneath them. §2 is about that failure, because avoiding a repeat of it is
the single strongest constraint on this document.

---

## 2. What changed since v1.1, and what that invalidates

### 2.1 The three engine reworks v1.1 predates

1. **The triage/hypothesis redesign.** Findings-with-capabilities were replaced
   by a **hypothesis graph**: a suspicion is a node with a `claim`, a compiled
   `experiment`, and a lifecycle `OPEN → IN_PROGRESS → {CONFIRMED, REFUTED,
   DEFERRED}` (`shared/src/graph.ts:55-61`, semantics at `graph.ts:48-54`).
2. **The evidence-timeline + LLM-judge rework.** A suspicion is resolved only by
   *running* its experiment under the full oracle and having a judge cite
   specific events. `CONFIRMED`/`REFUTED` transitions structurally require at
   least one `evidenceRef` (`engine/npmguard/graph.py:214-218`). Note what that
   guard does **not** buy: an `evidenceRef` proves a run was *sealed*, never that
   the timeline rendered from it carried the decisive fact — see §3.2.1.
3. **The schemaVersion-2 report.** `AuditReport` is now
   `{schemaVersion, verdict, rationale, counts, confirmedHypIds, hypotheses[],
   fileSummaries[], dealbreaker, trace[]}` — nine fields, listed exhaustively at
   `shared/src/backend.ts:21-32`.

### 2.2 The v1 primitives that no longer exist

v1.1 §8 defined the two things the whole benchmark rested on:

```
detected = (verdict === "DANGEROUS") AND (expectedCapabilities ⊆ report.capabilities)
verified = detected AND (any proof matches expectedCapability with kind === "TEST_CONFIRMED")
```

Both are unimplementable, and worse than merely unimplementable — they were
*already vacuous on the pinned corpus before the schema changed*:

- **There is no top-level `capabilities` on a v2 report.** `AuditReportSchema`
  (`shared/src/backend.ts:21-32`) has no such field. The word survives only
  per-file, as `FileVerdict.capabilities` (`shared/src/models.ts:113`) and
  `FileSummary.capabilities` (`shared/src/models.ts:127`) — and in both cases as
  `z.array(z.string())`, free-form strings, *not* the `CapabilityEnum` declared
  at `shared/src/models.ts:16`. §3.3 explains why scoring on those strings would
  be a mistake rather than a port.
- **There is no `proofs[]` and no `TEST_CONFIRMED`.** `Proof` and `ProofKind`
  still exist as orphan schemas (`shared/src/models.ts:54-62`, `:146-170`) with
  **zero producers and zero consumers** anywhere in the engine — the only
  remaining readers are in the dead `engine/npmguard/bench.py:152,171`. They are
  vestigial types awaiting deletion, not a contract.
- **Both conjuncts were already dead weight on the pinned corpus.** All 20
  entries in `bench/dataset/manifest.full.json` carry
  `expected.capabilities: []` and `expected.kind: "AI_STATIC"`. An empty set is a
  subset of anything, so v1's `detected` had already degenerated to
  `verdict === "DANGEROUS"`; and no `expectedCapability` exists to match a
  `TEST_CONFIRMED` proof against, so v1's `verified` was **0/20 by
  construction**. The "two-tier" scoring was one tier and a constant.

That last point matters for how this document should be read: **B-1 is not a
weakening of v1's rule. It is the rule v1 was actually computing**, now stated
honestly, with the second tier rebuilt on a field that exists.

### 2.3 The deeper cause: v1 stored judgments, not observations

The reader that consumed those primitives is `engine/npmguard/bench.py`, and its
core is one line:

```python
# engine/npmguard/bench.py:132
return {"DANGEROUS": "detected", "SAFE": "missed"}.get(run.get("verdict"), "unknown")
```

That is a **judgment** (`detected` / `missed`) baked into the read of a
**snapshot** that had already frozen the report's fields at write time. When the
report schema moved, the stored rows became unreadable rather than
re-projectable. The failure then compounded into a silent one: with the results
directory absent (`bench.py:13` points at `bench/results/`, which does not
exist), `list_benchmark_runs` returns `{"runs": []}` from `bench.py:195-196`, and
any file that *did* fail to parse would be swallowed by
`except (OSError, ValueError, json.JSONDecodeError): continue` at
`bench.py:206-207`. `/bench/results` reports "no data" when the truth is "this
code cannot read this engine's reports" — the canonical N-3 violation.

**This is why the observations-only rule (F-G2) is non-negotiable, and it is the
one paragraph in this document a future reader must not undo.** Nothing about
scoring may be stored. A run item records what was *observed*; every
`detected`/`missed`/`false alarm`/`abstained` label is **derived at read time**
from `expected × observed`. The payoff is concrete and asymmetric: when the
scoring rule changes — and this document is itself proof that it does — a
derived projector re-scores all historical runs, while a stored judgment
invalidates them.

The already-authored bench contract encodes this rule in its header
(`shared/src/bench.ts:9-17`) and deliberately omits any outcome vocabulary
pending this document (`shared/src/bench.ts:19-21`). **Filling that gap without
adding a stored field is the entire job of §4.**

---

## 3. What a v2 report actually gives you to score on

### 3.1 The observation vocabulary

Phase 0 already authored `BenchRunItemSchema` (`shared/src/bench.ts:123-141`).
Its fields are the complete set of observations available to the cheap
projector:

| Observation | Type | Note |
|---|---|---|
| `auditId` | `string \| null` | `null` ⟹ the attempt never reached an audit (`bench.ts:117-118`) |
| `verdict` | `"SAFE" \| "DANGEROUS" \| null` | `null` ⟺ the audit did not conclude (`bench.ts:120-122`) |
| `durationMs` | `int \| null` | wall clock |
| `error` | `string \| null` | why it did not conclude |
| `confirmedCount` | `int` | count of CONFIRMED hypotheses |
| `dealbreaker` | `string \| null` | *which* check fired, not a boolean (`bench.ts:136-138`) |
| `tokensPrompt` / `tokensCompletion` | `int \| null` | LLM spend |

The expectation side is `BenchEntrySchema` (`shared/src/bench.ts:56-78`):
`expectedVerdict` (the audit-core `SAFE\|DANGEROUS`, `bench.ts:72`), a free-string
`category` stratum (`bench.ts:68`), `discoveryDate`, `fixtureName`, `packageName`,
`version`.

A **second, richer tier** is available by reading the stored report for an
`auditId` (see B-9/§8.2): `counts` including `deferred`, the full `hypotheses[]`
with `claim.kind`, `resolution.reason`, `evidenceRefs`, and `fileSummaries`. §4
defines all headline metrics over the *row-only* tier so that a run summary
never requires N×entries report reads, and uses the richer tier only for
drill-down and adjudication.

A **third tier** exists and this document originally omitted it: the **sealed run
artifact** behind each hypothesis's `evidenceRefs`, which carries the raw sensor
events and therefore the only available answer to *"did the judge see what the
sandbox saw?"*. §3.4 makes reading it mandatory rather than optional, because
§3.2.1 shows that without it a detection rate has an unquantified leak. It is a
cheap tier — no LLM tokens, no Docker, a content-addressed file already on disk —
and unlike tiers 1 and 2 it is the only one that can falsify the engine's own
account of its coverage.

### 3.2 Four engine invariants the scoring rule can lean on

These are not stylistic facts; they are asserted in code, and they are what let
the taxonomy be exhaustive rather than defensive.

1. **`DANGEROUS` has exactly two producers.** Either
   `derive_graph_verdict` found `counts.confirmed > 0`
   (`engine/npmguard/graph.py:314-320`), or the inventory dealbreaker
   short-circuited the pipeline (`engine/npmguard/pipeline.py:275-289`). There is
   no third path.
2. **`SAFE` implies *dispatch* coverage — not *evidentiary* coverage.** This is
   the one invariant in this list that an earlier draft overstated, and the
   overstatement changed what a published miss means. See §3.2.1, which replaces
   the sentence that used to sit here.
3. **"Couldn't check" cannot become a verdict.** If any hypothesis is `DEFERRED`
   and none is `CONFIRMED`, the pipeline raises `AuditIncompleteError`
   (`pipeline.py:416-425`) — there is **no report at all**. The verdict domain is
   exactly `{SAFE, DANGEROUS}` (`shared/src/models.ts:12`, rationale at `:7-11`).
4. **Failure is durably recorded per audit.** `audit_sessions.status ∈ {queued,
   running, done, error}` (`engine/npmguard/persistence.py:50`), and `finalize`
   writes `status="error" if error else "done"` alongside an `error` column
   (`persistence.py:227`). `NpmGuardError` subclasses carry stable codes
   (`engine/npmguard/errors.py`), so an incomplete audit is not just observable —
   its *cause* is machine-classifiable. §4.5 uses this.

**Invariant 3 is the correction that reshapes O-2's candidate rule.** The design
doc proposes "DEFERRED gets its own outcome bucket instead of counting as a
miss". Directionally right, mechanically wrong: a report with deferred-and-nothing-confirmed
**does not exist**. `counts.deferred > 0` can only appear on a report that also
has `counts.confirmed > 0` (i.e. a `DANGEROUS` verdict with partial coverage).
So the observable is not "a report with DEFERRED hypotheses" — it is
**an audit with no report and `status = error`**. The honest third bucket is
therefore keyed on `verdict == null`, and DEFERRED-ness is a *coverage
annotation* on catches, not an outcome. §4.5 defines it accordingly.

### 3.2.1 What a `SAFE` verdict actually guarantees

An earlier draft of this section claimed:

> **`SAFE` implies full coverage.** … So a `SAFE` verdict on known malware is a
> *fully evaluated* false negative — every suspicion the engine raised was run
> and came back clean.

**That is false as written, and the corpus falsifies it directly.** The
correction, and what it costs the `MISSED` bucket, is the single most important
paragraph in §3–§4, because it is what a published miss *means*.

**What the code asserts.** `derive_graph_verdict` raises `AssertionError` on
`SAFE` with any `DEFERRED` node (`graph.py:322-325`) and on any unresolved
`OPEN`/`IN_PROGRESS` node (`graph.py:309-312`). Both assertions quantify over
**hypothesis state**. They say: *every suspicion the engine raised was dispatched,
ran, and reached a terminal state.* That is **dispatch coverage**, and it is a
real, load-bearing guarantee — it is what makes "the scanner didn't flag it"
inadmissible as a description of a miss.

**What the code does not assert.** Nothing in `graph.py` — or anywhere else —
asserts that the evidence bearing on a hypothesis reached the judge that resolved
it. Two independent gaps, both live:

- **(a) The renderer is not held to the artifact.** `render_timeline`
  (`evidence.py:281-372`) may emit a placeholder or an outright wrong target for
  an event whose sealed `raw` carries a resolvable one, and no assertion forbids
  it. There is no `AssertionError` between "the sensor captured it" and "the judge
  read it". The *sensor* defects that made this bite have since been fixed, and
  §3.4 measures how much that bought — but the fix is unasserted, and §3.4 also
  finds a residual class the fixes do not touch.
- **(b) The judge cannot report insufficiency.** `JudgeVerdict.malicious` is a
  `bool` (`phases.py:204-209`) — verified in today's tree, unchanged by any of the
  fidelity fixes. A judge that means *"the timeline does not carry the fact this
  claim turns on"* has no way to say so, and `validate_verdict`
  (`orchestrator.py:81-89`) forces it into `malicious=false` — which the
  orchestrator maps to `REFUTED`, which counts toward `SAFE`. An epistemic
  limitation is silently converted into an ontological one. **This gap is
  structural and entirely open**; unlike (a), no landed commit narrows it.

**The measured counterexample — and this is a *pre-fix* measurement, which is
exactly why it is admissible as evidence for the correction.** On
`test-pkg-env-exfil@2.0.1`, nine recorded runs triggered `setup.js`. **All nine**
sealed artifacts hold the IMDS probe —
`connect(18, {sin_port=htons(80), sin_addr=inet_addr("169.254.169.254")})` **and**
its `write(18, "GET /latest/meta-data/ HTTP/1.1…", 82) = 82`, i.e. 82 bytes
confirmed sent. In the timelines the judges actually read, **3 of 9** carried that
endpoint; the other six rendered `connect socket` / `write socket` / `read socket`.
Eight of the nine runs "came back clean", and `hyp-0005`'s judge wrote *"there is
no evidence of a request to the IMDS (169.254.169.254/latest/meta-data/) — the stub
was provided but never observed being accessed"* **while looking at those three
anonymous lines.** Every one of those refutations satisfied dispatch coverage
perfectly.

Re-rendering the same sealed bytes through **today's** parser and renderer, the
endpoint appears in **9 of 9** (§3.4, method and caveats there). So the specific
leak that produced this counterexample is closed. **The invariant is still wrong
as originally written**, for three reasons that survive the fix and are the reason
this section is not simply deleted:

1. Dispatch coverage and evidentiary coverage remain **different guarantees**, and
   only the first is asserted. A benchmark sentence may only claim what is
   asserted.
2. Nothing prevents regression. The dead peer regex stayed green for its entire
   life because `test_sensors.py` C2 asserted a line shape strace never emits; a
   fix without an assert is a fix waiting to regress.
3. Gap (b) is untouched, and it alone is sufficient to break the stronger claim:
   a judge that had insufficient evidence still resolves to `REFUTED`, and
   `REFUTED` still counts toward `SAFE`, no matter how faithful the render is.

So, stated exactly, and this is the sentence the `MISSED` bucket rests on:

> **A `SAFE` verdict guarantees that every suspicion the engine raised was
> dispatched, run, and terminally resolved. It does not guarantee that the
> evidence each judge needed ever reached it.** A published miss therefore means
> *"the engine ran every suspicion, and the benchmark cannot tell you from the
> verdict alone whether its renderer showed the proof to its judge."*

**What would make the stronger claim available.** Evidentiary coverage is the
conjunction of two properties, neither of which exists today:

1. **A render-fidelity assertion.** `render_timeline` must be forbidden from
   emitting an anonymous or non-derivable target for an event whose
   `normalized`/`raw` carries a resolvable one — an assert, not a fix. The
   underlying *fixes* have landed (`sensors.py:271-330` `_peer` now parses
   `sin_addr=inet_addr("…")`, the form strace actually emits; `sensors.py:138-231`
   `_complete_lines` splices `<unfinished ...>`/`<... resumed>` pairs); the
   *invariant* has not. §3.4 measures the difference and explains why an unasserted
   fix is a fix waiting to regress.
2. **A third judge answer.** The judge must be able to return
   `UNDECIDABLE` with a `missingObservation` drawn from a closed, sensor-shaped
   vocabulary, routed to `DEFERRED` — which by invariant 3 cannot yield `SAFE`.
   The enforcement machinery already exists and is untouched by the change; only
   the judge's ability to *select* the honest outcome is missing. Designed in
   [`../docs/specs/2026-07-25-cross-hypothesis-coherence.md`](../docs/specs/2026-07-25-cross-hypothesis-coherence.md)
   §4 (R1/R2); §3.4 and §4.5 say what the bench records so it is measurable.

With both in place, `SAFE` becomes *"every suspicion ran, and every judge
affirmed it had what it needed"* — the property `shared/src/models.ts:7-11`
already claims in prose. **Until both are in place, no run of this benchmark may
describe a miss as "fully evaluated".** §4.2's `MISSED` row, §5.3's `miss_rate`,
and §10's threats list are all worded to that weaker guarantee.

### 3.3 What is not available, and must not be resurrected

**Do not rebuild the capability-subset rule on `fileSummaries[].capabilities`.**
It is tempting — the field is named `capabilities` and it is on the report. Three
reasons it is the wrong instrument:

1. It is `z.array(z.string())` (`shared/src/models.ts:127`), not the
   `CapabilityEnum` (`models.ts:16`). Nothing constrains the vocabulary.
2. It is an **LLM output** — the one-line-per-file summary emitted by triage MAP
   (`shared/src/models.ts:122-123`). Per the project's own finding that
   OpenRouter/gemini does not hard-constrain structured output, these are
   validated post-hoc, not constrained at decode time.
3. Therefore a subset test over it scores the **model's word choice**, not its
   detection. `["NETWORK"]` vs `["network egress"]` vs `["HTTP_POST"]` would be
   three different scores for identical behaviour. That is a benchmark measuring
   its own prompt.

The same applies to `Proof`/`ProofKind` (`shared/src/models.ts:54-62,146-170`):
they are dead and should be deleted, not re-plumbed.

### 3.4 Render fidelity is a recorded observation of every audit, not a footnote

§3.2.1 established that a detection rate rests on evidentiary coverage the engine
does not assert. The bench cannot fix that. What it can do — and this section is
**B-12** — is **record the coverage each audit actually achieved, per run**, so
that every published rate is a rate *at a stated evidentiary coverage* rather than
a rate whose leak is unquantified.

This matters beyond honesty in prose. It is the difference between a rate that
survives a sensor improvement and one that must be thrown away: *"91% detection"*
is invalidated by the next renderer fix, whereas *"91% detection at 0 fidelity
defects / 5,733 described events"* remains a meaningful historical datum after it.
It is also the load-bearing input to §6.5's stability probe (§6.5.1), because
without it replication variance cannot be attributed.

#### 3.4.1 The four recordables

All four are **observations derived at read time** — F-G2 compliant, nothing
stored as a judgment. Items 1–3 read the stored report (§3.1's tier 2); item 4
reads the sealed run artifact, which is a **third** tier this document had not
previously named.

| # | Recordable | Definition | Source |
|---|---|---|---|
| **1** | `renderFidelityDefects` | per run: events the renderer described with an anonymous target (`socket`, `fd:N`) **while that event's own `raw`/`normalized` carried a resolvable one** | artifact + a re-render |
| **2** | `falseTargetEvents` | per run: socket operations (`connect`/`sendto`) rendered with a **filesystem path** inherited from a recycled fd | artifact + a re-render |
| **3** | `undecidableOutcomes` | per audit: count and `missingObservation` histogram, once the third judge answer lands (§4.5) | report `hypotheses[]` |
| **4** | `confirmationConcentration` / `behaviourMultiplicity` | per audit: `confirmedCount / counts.total`; and the max number of distinct hypotheses whose `resolution.reason` references one normalised behaviour key | report `hypotheses[]` |

**Recordable 1 is the assertion's measurable shadow, and it is deliberately
narrower than "count the placeholders".** A placeholder is not automatically a
defect: `read`/`write` on a descriptor whose `openat` was never captured has no
resolvable target anywhere in the artifact, so rendering `fd:17` is honest. Only
"anonymous *despite* a resolvable target in the same event's bytes" is a defect,
and only that number belongs in a published caption. Both are cheap, so record
both — but keep them separate, because conflating them is how a 5.7% headline
gets mistaken for a 5.7% leak.

**Recordable 2 is new here and is not in the coherence spec's list.** A vague
target starves the judge; a **false** one misleads it, which is strictly worse and
cannot be recovered by a careful reader. It earns its own counter for that reason.

#### 3.4.2 Measured on the committed corpus — pre-fix vs. at `67f830f`

Method, so it is re-runnable and attackable: 31 sealed artifacts across the four
replay bundles in `engine/tests/fixtures/llm/`. **Pre-fix** = the committed
`sandbox/*.timeline.txt`, i.e. the exact bytes the recorded judges read.
**At `67f830f`** = the same artifacts' L1 events re-parsed from their verbatim `raw`
through that commit's `sensors.parse_strace_log` and re-rendered through its
`evidence.render_timeline`. No model calls, no Docker, no fixture execution.

**The right-hand column is pinned to an `engineSha`, and that is not pedantry.**
These figures were first taken against a working tree, and they moved — rendered
rows 4,140 → 4,616, anonymous rows 236 → 251 — because `evidence.py` was being
edited while the measurement ran. **A fidelity number without its `engineSha` is
not a measurement**, which is the same conclusion B-13 reaches from the other
direction, arrived at here by accident. Re-derive against a `git archive` of a named
commit, never against a working tree.

| Quantity | Pre-fix (as judged) | At `67f830f` (re-rendered) |
|---|---|---|
| Described events | 5,733 | 5,733 |
| Rendered timeline rows | 4,140 | 4,140 |
| **Fidelity defects** (anonymous despite a resolvable peer in `raw`) | **16** | **0** |
| False targets (socket op rendered as a filesystem path) | 384 events / 146 rows | **87 events / 52 rows** |
| Anonymous-target rows (all causes, incl. honest ones) | 277 / 4,140 (6.69%) | 236 / 4,140 (5.70%) |
| `env-exfil` runs rendering the IMDS endpoint | **3 of 9** | **9 of 9** |

Four readings of that table, in order of importance to the benchmark:

1. **The defect the correction was built on is gone: 16 → 0.** Recordable 1 is
   **zero across the entire committed corpus at `67f830f`**, and the nine-run IMDS
   lottery collapses from 3/9 to 9/9. `hyp-0001`'s three anonymous lines now render
   `connect 169.254.169.254:80` / `write 169.254.169.254:80` / `read
   169.254.169.254:80`. Any pre-`67f830f` "miss" must be re-read in this light
   before it is cited as a detection failure — **it is historical evidence about a
   renderer, not a measurement of today's engine.**
2. **False targets are down 4.4× but are emphatically *not* zero: 87 events
   remain.** These are the unfixed AF_UNIX/netlink recycled-fd fallback
   (`evidence.py:_describe`, pinned by `test_evidence.py` C14b, held back only
   because landing it shifts event ids and needs a paid re-record). The residual
   includes `connect /etc/localtime` ×14, `connect /etc/resolv.conf` ×17,
   `send /etc/nsswitch.conf` ×15 — and, worst, `connect /pkg/setup.js` and
   `connect /pkg/install-hook.js`, i.e. **a socket operation rendered as the
   malware payload file itself.** This is a live defect at `67f830f`, not a
   historical one, and the bench must count it.
3. **A 5.7% anonymous-row rate is not a 5.7% leak.** After the fix, every one of
   the 236 remaining anonymous rows is a `read`/`write` on a descriptor the
   artifact never resolved — honest by recordable 1's definition. This is precisely
   why the two counters are separate.

   **And a caution about that pre-fix 277, because it is a lesson about the metric
   rather than about the engine.** The coherence spec reports **244** anonymous rows
   over the same 4,140 rows; this document counts **277**. Neither is wrong — they
   are different predicates over "anonymous", differing on which placeholder forms
   and which layers count. The disagreement is the point: **an unpinned fidelity
   metric is not reproducible even between two careful readings of one immutable
   corpus.** So recordables 1 and 2 must ship as *code with a test*, not as a
   description in a methodology document, and the published caption must name the
   predicate version. Two numbers 13% apart, from one static input, is exactly the
   drift this document exists to prevent — and it appeared inside the correction
   itself.
4. **The corpus is lossy at the sensor boundary, so these current figures are
   optimistic bounds.** Facts the pre-fix sensors dropped *before sealing* cannot
   be recovered by re-parsing, because they are not in the artifact at all:
   - **0 of 31** artifacts retain any `<unfinished ...>`/`<... resumed>` marker, so
     the syscalls those pairs carried are simply absent. The re-parse yields
     3,923 L1 events from 3,923 recorded ones — an exact tie, which is the
     signature of "nothing left to recover", not of "nothing was lost".
   - **113 of 157** corpus `connect` calls carry `= -1`, and **0 of the 113** retain
     the errno text. The old `STRACE_CALL` regex truncated the result at the numeric
     token, so `EINPROGRESS` (**the connect SUCCEEDED, asynchronously**) is
     indistinguishable from `ECONNREFUSED` in the sealed bytes, permanently. Today's
     parser splits the errno into its own field (`sensors.py`
     `STRACE_RESULT`/`parse_strace_log`), but there is nothing here for it to split.
   - **221** `recvfrom` events were recorded under `kind: "openat"` with
     `normalized == {"ret": …}` — the peer discarded. Together with 85 `connect`
     events that is **306** artifact events whose `raw` holds a parseable
     `sin_addr`/`sin_port`. Today `recvfrom` maps to `read` and `_peer` parses it.
   - tshark layer selection (`mdns`/`llmnr`/`ssdp` packets that produced zero
     events) is **not re-derivable at all** — the raw tshark JSON is not sealed,
     only the events it yielded.

   **Consequence for the bench, and it is a hard one: the fidelity of the current
   engine cannot be established from the recorded corpus. It can only be
   established by a re-record.** §3.4.2's "current" column is the best available
   *lower bound on the defect count*, measured against bytes that were themselves
   filtered by the defects under study. This is the strongest argument in this
   document for D-9's ordering: fidelity first, then measure.

#### 3.4.3 What the wildcard-stub finding does to pre-fix misses

One more pre-fix result changes how any historical refutation must be read, and it
is not a rendering defect but an *experiment* defect. Across the corpus:

- **22 `stubUrl` declarations** over **17 runs**, of which **8 carry a `*`**.
- Every wildcard was inert twice over: `HTTP_PROXY`/`HTTPS_PROXY` are ignored by
  every Node client (verified in the sandbox image), and `escapeRegex` never
  escaped `*`, so `…/latest/meta-data/*` compiled to "…`/meta-data` followed by
  zero-or-more slashes" and matched no sub-path.
- **All 22 declarations carry a non-null `responseHash`** — i.e. **22 of 22 sealed
  artifacts attest that a canned response was served, and not one was.**

So a recorded refutation whose experiment declared a wildcard stub **was not
testing what its compiled experiment claimed**, and its judge was shown a setup
block describing a manipulation that never applied. Two `env-exfil` refutations
used exactly that phantom manipulation as grounds to acquit. Post-`b1b0a43`,
`responseHash` is read back from the proxy's own served ledger and is `null` when
nothing was served, so non-null *is* the statement "this was served"; and an
unappliable stub raises `SetupError`, which bars `REFUTED`.

**Rule for the benchmark (B-13):** an observation recorded on an engine older than
`ced29f2` + `b1b0a43` + `67f830f` is **not comparable** to one recorded after, and
a pre-fix `MISSED` may not be counted as a detection failure. Because `engineSha`
is already a mandatory non-nullable identifier (§8.1), this is enforceable rather
than aspirational: **the projector must refuse to pool observations across an
`engineSha` boundary that crosses a fidelity fix**, and the run report must name
the boundary rather than averaging over it. The corpus of pre-fix audits is a
corpus of *fidelity* measurements, and this document uses it as exactly that and
nothing else.

---

## 4. O-2 — the outcome taxonomy

### 4.1 The candidate rule, evaluated

The design doc's candidate (`§9 O-2`):

> `detected = verdict DANGEROUS`, plus a stricter tier
> `verified = DANGEROUS ∧ ≥1 CONFIRMED hypothesis`, and DEFERRED gets its own
> outcome bucket rather than counting as a miss.

**Adopted with three amendments.** The spine is right and I want to say why
before amending it: it scores the thing the product actually ships (a verdict a
user acts on), it is computable from a stored observation, and it separates
"flagged on static suspicion" from "proved by running it" — which is the honest
distinction a skeptic will ask about.

The amendments:

**(a) `verified` is the wrong name and a misleading nesting.** As written it
implies `verified ⊆ detected` with the residue being "detected but not proved" —
i.e. weaker evidence. But by §3.2 invariant 1, a `DANGEROUS` verdict with
`confirmedCount == 0` is **not** a weakly-proved confirmation; it is a
*dealbreaker*, a completely different mechanism that never produced a hypothesis
at all. Two disjoint modes, not a strong tier and a weak tier. Renamed and split
in §4.2/§4.4.

**(b) DEFERRED is not the observable; `verdict == null` is.** Per §3.2 invariant
3 and `pipeline.py:416-425`. And the bucket must be split by cause, because
"the engine ran and honestly could not determine" and "Docker was down" are not
the same fact about the tool (§4.5).

**(c) The rule must be stated for `expectedVerdict == SAFE` too.** The candidate
only covers malware. Negative controls are what make the recall number
non-gameable (v1.1 §6, still correct), so the taxonomy has to be symmetric.

### 4.2 The taxonomy — exact definitions

**Per-observation outcome.** A pure function of one `BenchRunItem` and its
`BenchEntry`. Eight values, exhaustive and mutually exclusive. Nothing here is
stored; this is the projector.

Let `ec = item.confirmedCount`, `db = item.dealbreaker`, `v = item.verdict`.

| Outcome | Condition | Meaning |
|---|---|---|
| **`CAUGHT_PROVED`** | `expected=DANGEROUS ∧ v=DANGEROUS ∧ ec ≥ 1` | Flagged, and at least one hypothesis was confirmed by running it with cited evidence. |
| **`CAUGHT_STRUCTURAL`** | `expected=DANGEROUS ∧ v=DANGEROUS ∧ ec = 0 ∧ db ≠ null` | Flagged by an inventory dealbreaker before any hypothesis existed. |
| **`MISSED`** | `expected=DANGEROUS ∧ v=SAFE` | False negative at **dispatch** coverage: every suspicion ran and terminally resolved. **Not** "fully evaluated" — see §3.2.1, and publish it beside the run's fidelity counts (§3.4.1) or not at all. |
| **`CLEARED`** | `expected=SAFE ∧ v=SAFE` | Correct clean verdict on a negative control. |
| **`FALSE_ALARM_PROVED`** | `expected=SAFE ∧ v=DANGEROUS ∧ ec ≥ 1` | The judge cited dynamic evidence of malice in a benign package. The most serious failure mode in the taxonomy. |
| **`FALSE_ALARM_STRUCTURAL`** | `expected=SAFE ∧ v=DANGEROUS ∧ ec = 0 ∧ db ≠ null` | A dealbreaker heuristic fired on a benign package. |
| **`ABSTAINED`** | `v = null ∧ cause is engine-capability` (§4.5) | The audit could not conclude, and that is a fact about the tool. |
| **`VOID`** | `v = null ∧ cause is harness/infra/corpus` (§4.5) | The observation failed to be made. Excluded from every rate; counted and named. |

**Three forbidden states become projector assertions**, per the delete-iff-asserted
discipline. Each is unreachable given §3.2, so the projector must fail loud
rather than branch:

```
assert not (v == "DANGEROUS" and ec == 0 and db is None)   # graph.py:314-320 + pipeline.py:275-289 are the only DANGEROUS producers
assert not (v == "SAFE" and ec > 0)                        # graph.py:314-320: confirmed > 0 ⟹ DANGEROUS
assert not (v is not None and item.auditId is None)        # shared/src/bench.ts:117-118
```

If any of these fires, the run is not scored — it means the engine, the contract,
or the runner disagree, and a benchmark that averages over that is worthless.

**Per-entry outcome.** The statistical unit is the entry (B-4/§5.2), so the N
observations of one entry aggregate to one entry-level bucket. Drop `VOID`
observations first; let `m` = the number of remaining observations.

| Entry bucket | Condition (`expected = DANGEROUS`) |
|---|---|
| `UNOBSERVED` | `m = 0` — every attempt was VOID |
| `CAUGHT_ALWAYS` | all `m` are `CAUGHT_*` |
| `CAUGHT_SOMETIMES` | ≥1 `CAUGHT_*` and ≥1 not |
| `MISSED_ALWAYS` | all `m` are `MISSED` |
| `ABSTAINED_ALWAYS` | all `m` are `ABSTAINED` |
| `NEVER_CAUGHT_MIXED` | no `CAUGHT_*`, and a mix of `MISSED`/`ABSTAINED` |

Symmetrically for `expected = SAFE`: `CLEARED_ALWAYS`, `CLEARED_SOMETIMES`,
`FALSE_ALARM_ALWAYS`, `ABSTAINED_ALWAYS`, `MIXED`.

`CAUGHT_SOMETIMES` is the bucket v1 could not express and is the most
interesting one in the whole design: it is the direct, honest measurement of LLM
stochasticity at the level a user experiences it — *"this package is caught on
some runs and not others."* v1 spent its entire N=3 replication budget and then
averaged that signal away into a pooled rate.

### 4.3 Why nothing here can be stored

Read the taxonomy above and note what it consumes: `expectedVerdict`,
`category`, `verdict`, `confirmedCount`, `dealbreaker`, `error`, `auditId`. Every
one is either a pinned expectation or an observation. There is no field named
`detected`, `status`, or `outcome` in `BenchRunItemSchema`
(`shared/src/bench.ts:123-141`), and adding one is described by the contract
itself as "the one change this domain cannot absorb"
(`shared/src/bench.ts:114-115`).

Concretely: had v1 stored `status: "missed"` for a SAFE verdict on malware — and
it did, at `bench.py:132` — then this document's split of that same observation
into `MISSED` vs `ABSTAINED` vs `VOID` would be impossible to apply
retroactively. It is applicable now precisely because the observation was kept
raw. **A future v3 scoring rule will thank v2 for the same reason, or curse it.**

### 4.4 Is `dealbreaker` a distinct detection mode? Yes.

The dealbreaker path returns from the pipeline before intent extraction, flagging,
hypothesizing, or the orchestrator ever run, with `counts=EMPTY_COUNTS` and
`hypotheses=[]` (`pipeline.py:275-289`, `EMPTY_COUNTS` at `pipeline.py:41`).
Today there are exactly two producers, both purely structural:

- `check="shell-pipe"` — an install script matches a shell-pipe pattern
  (`engine/npmguard/inventory.py:167-170`)
- `check="missing-install-script"` — an install script references a file absent
  from the package (`inventory.py:173-177`)

Three consequences for scoring:

1. **It is nearly free.** No LLM call, no sandbox. A corpus that happens to be
   rich in shell-pipe install scripts would produce excellent recall at almost
   zero cost — and a reader who couldn't see that would badly misread both the
   recall number and the cost number. **The dealbreaker share of catches is
   therefore a mandatory published figure, not a drill-down.**
2. **It breaks a contract comment, and the benchmark must not paper over it.**
   `shared/src/models.ts:7-8` states `DANGEROUS ⟺ a CONFIRMED hypothesis (cited
   dynamic proof)`. The dealbreaker path violates that biconditional. The engine
   is self-consistent (both producers are intended); the *comment* is stale. This
   is flagged in "Open" because it is an engine/contract question, not a bench
   question — but a scoring rule written from the comment rather than the code
   would classify every dealbreaker catch as an impossible state.
3. **A `FALSE_ALARM_STRUCTURAL` is a different bug from a
   `FALSE_ALARM_PROVED`.** The first is a heuristic that needs tuning; the second
   is the judge cited evidence for malice that isn't there. Reporting them as one
   number hides which one you have.

### 4.5 What an ERROR / incomplete audit counts as

It must not silently become a miss or a catch — and the engine has already taken
the same position, structurally, by refusing to launder "couldn't check" into a
verdict (`pipeline.py:416-425`, `graph.py:322-325`, and the orchestrator's four
defer paths at `orchestrator.py:231-248`, `:256-270`, `:271-283`, `:284-301`).
The benchmark's job is to not undo that in its arithmetic.

So `verdict == null` is split by the cause recorded in `error`, which carries a
stable `NpmGuardError` code (`engine/npmguard/errors.py`):

| Cause | Code | Bucket | Why |
|---|---|---|---|
| `AuditIncompleteError` — hypotheses deferred, none confirmed | `NPMGUARD-0031` | **`ABSTAINED`** | The engine ran, formed suspicions, tried to resolve them, and honestly reports it could not. That is a real capability limit and belongs in the published denominator. |
| `AuditTimeoutError` — a phase exceeded its budget | `NPMGUARD-0030` | **`ABSTAINED`** | The budgets are the engine's own configured behaviour (`pipeline.py:372`, `orchestrator.py:27`). Being too slow on an input is the tool's answer, not the harness's fault. |
| `LLMUnavailableError` | `NPMGUARD-0010` | **`VOID`** | Provider outage. Says nothing about the tool. |
| `DockerUnavailableError` | `NPMGUARD-0020` | **`VOID`** | Sandbox infrastructure. |
| `QueueFullError`, `SessionLimitError` | `NPMGUARD-0040/0050` | **`VOID`** | Admission pressure from the harness itself. |
| `PackageNotFoundError` | `NPMGUARD-0001` | **`VOID`** | The fixture is unresolvable — a corpus bug to fix, not a measurement. |
| `auditId == null` | — | **`VOID`** | Never admitted. |
| Client-side timeout (runner gave up first) | — | **`VOID`** | See the trap in §7.3: this is manufactured by the harness. |

Two rules make this honest rather than convenient:

- **`ABSTAINED` sits in the denominator of the detection rate.** A tool that
  abstains on half the corpus has a detection rate of at most 50%, and the
  published band makes that visible. Moving abstentions out of the denominator
  would let a fragile engine buy an excellent score by failing more often. Never
  do this.
- **`VOID` is excluded from every numerator and denominator, and is published as
  a count with its cause breakdown.** A run with a high VOID count is not a
  result; it is a broken run to re-do. Concretely: **a run whose VOID rate
  exceeds 5% of attempted observations is not publishable** and the report says
  so instead of reporting rates.

The asymmetry is deliberate and is the crux of B-3: an abstention is *the tool's
output*, a void is *the harness's failure*. Collapsing them in either direction
either flatters the tool or blames it for the weather.

#### 4.5.1 `ABSTAINED` gains a machine-readable sub-cause (B-15)

**D-6's eight-value taxonomy is unchanged by this subsection and must stay
unchanged — this extends it rather than replacing it.** No outcome is added,
renamed or merged; `ABSTAINED` gains a *second axis*.

Today `ABSTAINED` is keyed on the `NpmGuardError` code, and `NPMGUARD-0031` covers
every reason a hypothesis deferred: the sandbox broke, the judge call failed, a
module would not load, a phase timed out. When the judge gains its third answer
(§3.2.1 leg 2), a new and much more interesting cause joins that list: **the oracle
did not capture the fact the claim turned on.** That is not an infrastructure
failure and must not be filed as one.

So the bench records, per audit, alongside the error code:

| Field | Value | Read from |
|---|---|---|
| `undecidableCount` | hypotheses resolved `DEFERRED` because a judge returned `UNDECIDABLE` | report `hypotheses[].resolution` |
| `missingObservations` | histogram over the closed vocabulary — `request_body`, `response_body`, `planted_file_content`, `network_endpoint`, `spawned_process_env`, `decrypted_payload` | same |
| `undecidableGaps` | **distinct** `missingObservation` values, not node count | derived |

Three rules on how those are read, and each exists to stop a specific misreading:

1. **Group by cause, not by node.** *K* hypotheses deferring with the same
   `missingObservation` is **one** oracle gap, not *K*. Reporting node counts would
   let a wide FLAG fan-out inflate an oracle gap into a crisis — the same
   multiplicity artefact §4.6 warns about for `claim.kind`. `undecidableGaps` is the
   headline; `undecidableCount` is the drill-down.
2. **The undecidable rate is a *model-tier disqualifier*, and this is the sharp
   edge.** `UNDECIDABLE` is an answer that is always available and never provably
   wrong, so a cheap judge facing a hard question can learn to reach for it as an
   escape hatch. The closed vocabulary is the primary defence — "insufficient
   evidence" is not a member, and a judge must name a *sensor-shaped* fact — but the
   defence is not airtight, because the enum is validated post-hoc rather than
   hard-constrained at decode time. The bench is therefore the instrument that
   catches it: **a model tier whose undecidable rate is materially higher than a
   stronger tier's on the same corpus is disqualified from the published
   configuration**, on the same footing as this project's existing finding that a
   cheap model returned false-SAFE on textbook exfiltration. This makes the
   undecidable rate a **direct input to O-7** and not merely a coverage statistic —
   see Open item 9.
3. **Reclassification must be measured before any rate is published.** Giving the
   judge a third answer will convert some current `REFUTED` resolutions into
   `DEFERRED`, which converts some current `SAFE` verdicts into no-verdict
   `ABSTAINED` observations. On the recorded corpus at least one refutation is
   already a `DEFERRED` in all but name — `hyp-0014` reasons that *"the patched
   version was not actually invoked because the patched `require('module')._load`
   never triggered"*, i.e. an experiment reporting it did not test its own
   hypothesis. The size of that shift is unknown and it moves specificity as well as
   detection, so **the delta is measured on the corpus first and the rate is
   published second.**

One consequence worth stating plainly, because it looks like a regression and is
not: **the honest engine abstains more often than the dishonest one.** A rising
abstention rate against a falling miss rate is the intended direction of travel,
and §5.3 already keeps `ABSTAINED` in the detection denominator so the trade is
visible rather than free (§4.5's first rule). What must not happen is the reverse —
`ABSTAINED` quietly leaving the denominator once it stops being nearly empty.

### 4.6 Does `claim.kind` give a trustworthy per-attack-class breakdown?

v1.1 §3 correctly identified this gap: the Datadog corpus is not tagged by attack
class, so per-class recall was unavailable, and v1 deferred it to mutation
testing (§13). `claim.kind` is a 13-value enum (`shared/src/graph.ts:9-23`:
`env_exfil`, `cred_theft`, `binary_drop`, `obfuscation`, `persistence`,
`destructive`, `propagation`, `dos_loop`, `clipboard_hijack`, `dom_inject`,
`telemetry`, `dns_exfil`, `build_plugin_exfil`) and it is genuinely tempting.

**It does not close that gap, and publishing it as recall-per-class would be a
new version of v1's error.** The reason is provenance: `claim.kind` is authored
by the model, not by the corpus. `ClaimDraft` is a `StrictLlmOutput` whose `kind`
field is filled by the LLM (`engine/npmguard/phases.py:247-249`), and the value
is copied verbatim into the `Claim` at `phases.py:702`; the agentic generator does
the same at `engine/npmguard/hypothesis_agent.py:71,202`. And per this project's
own finding that structured output is not hard-constrained at decode time, the
enum is enforced by post-hoc validation with bounded repair, not by the decoder.

So a table of "recall by claim kind" would be a table of **how the tool labels
what it found**, cross-tabulated against itself. Its denominator — how many
`env_exfil` attacks are *in* the corpus — is unknown, because no ground truth
supplies it. A class with 100% "recall" might have one member, self-selected by
the model on the runs where it succeeded. That is a survivorship artifact
dressed as a breakdown.

**What is publishable, and is a genuine gain over v1:**

- **A descriptive distribution of `claim.kind` over CONFIRMED hypotheses**,
  explicitly captioned as *"what NpmGuard says it proved, across the corpus —
  the tool's own taxonomy of its findings, not an independent classification of
  the corpus."* This is useful and honest: it shows what the engine's detection
  actually consists of, and a reader who notices that 90% of confirmations are
  `env_exfil` learns something real about the blind spots.
- **A `gating` distribution** (`shared/src/graph.ts:27-33`: `time_gate`,
  `geo_gate`, `ci_gate`, `inspector_gate`, `docker_gate`) with the same caption.
  This is the closest thing available to v1.1 §5's "evasive" difficulty tier, and
  it is *observed* rather than injected.

**What would make it real recall:** an independent per-entry label of the attack
class, applied to the corpus by something that is not the engine under test.
Options and their costs are in "Open".

### 4.7 Is `expectedVerdict: DANGEROUS` enough ground truth?

**For recall: yes, and it is the only honest thing the Datadog corpus supports.**
Every entry is a package that was published, used in an attack, human-triaged by
Datadog, and pulled from the registry. "A correct auditor flags this package" is
a defensible, checkable, package-level proposition, and it is exactly what
`BenchEntrySchema.expectedVerdict` encodes (`shared/src/bench.ts:69-72`).

**For anything finer: no, and the corpus cannot be made to support it without new
labelling work.** Two limits, stated plainly:

1. **No per-behaviour ground truth ⟹ "right for the right reason" is
   unmeasured.** A `CAUGHT_PROVED` means the engine confirmed *some* malicious
   behaviour in a package known to contain malware. It does not establish that it
   confirmed *the* malware. A dealbreaker firing on an unrelated shell-pipe in a
   package whose actual payload is a credential stealer scores identically to a
   correct confirmation. The corpus has no field that could distinguish them —
   `manifest.full.json` carries only a generated one-line `rationale` per entry
   ("Datadog compromised_lib sample (2025-09-16) — known malicious npm package;
   expected verdict is DANGEROUS"), which is a restatement of the label, not
   evidence about the payload.
   **Mitigation, and it is cheap enough to require:** a **manual adjudication
   sample**. Draw K entries (K=10 is affordable) from the `CAUGHT_*` bucket, read
   the confirmed hypothesis's `resolution.reason` and cited `evidenceRefs` against
   the fixture source, and record a binary "the cited evidence describes the
   actual payload". Publish that as *explanation accuracy* with its own Wilson CI
   over K, clearly separate from recall. At K=10 with 10/10 correct the bound is
   ≥72.2% — weak, but honestly weak, and vastly better than an unstated
   assumption.
2. **A per-entry expected *claim kind* would need to come from outside.** Adding
   an `expectedClaimKind` column to the corpus is only meaningful if it is
   assigned independently of the engine (see §4.6 and "Open"). Note that
   `BenchEntrySchema` has no such field today, and adding one is a contract
   change — do not add it speculatively before deciding who labels it.

One thing the corpus *does* fully support and v1.1 already used correctly: the
`category` stratum. §6 keeps it.

---

## 5. Statistics

### 5.1 What carries over from v1.1 §8 unchanged

v1.1's statistical core is correct and is kept **verbatim**, including the
justification, which I am not going to improve on:

> For each rate, we report a **Wilson score 95% confidence interval** (Wilson,
> 1927) computed as
>
> ```
> CI_lower, CI_upper = (
>   (p̂ + z²/(2n) − z·√((p̂·(1−p̂) + z²/(4n))/n)) / (1 + z²/n),
>   (p̂ + z²/(2n) + z·√((p̂·(1−p̂) + z²/(4n))/n)) / (1 + z²/n),
> )
> where z = 1.959964 (97.5%-quantile of N(0,1)).
> ```
>
> Wilson is preferred over the more familiar Wald (`p̂ ± z√(p̂(1−p̂)/n)`) because
> Wald produces malformed intervals near 0 and 1, exactly the regime where a
> strong auditor lives.

Also kept: the premise that LLM outputs are stochastic so a single run is a
single sample of a distribution, and that reporting bare point estimates is
unscientific.

### 5.2 The unit-of-analysis error in v1.1, and the fix

v1.1 §8 computes `Recall = Σ detected_i / Σ runs_i` — pooling all
entries × runs — and then puts a Wilson CI on it. v1.1 §12 separately claims
"with N=3 runs, the Wilson 95% CI for a point estimate of 80% is roughly
[40%, 96%]". **These two statements use different `n` and neither is the right
one**, which is a sign the question "what is one independent observation?" was
never settled.

- At `n=3` (v1.1 §12's implied unit — one entry's three runs), p̂=0.80 gives
  **[28.8%, 97.5%]**. v1.1's "[40%, 96%]" is not even the Wilson interval for its
  own stated `n`.
- At `n=20` (entries), p̂=0.80 gives **[58.4%, 91.9%]** — the figure the design
  doc quotes in O-3.
- At `n=60` (entries × 3 runs, which is what §8's formula computes), p̂=0.80
  gives **[68.2%, 88.2%]**.

Pooling to `n=60` narrows the interval from ±16.8pp to ±10.0pp — **a 40%
reduction in width bought entirely by an independence assumption that is false.**
Three audits of `cline@2.3.0` are three measurements of the same package. They are
correlated by construction; a package that is trivially caught is caught all
three times. This is textbook pseudo-replication, and it inflates confidence in
exactly the direction a vendor benefits from.

**Fix (B-4): the entry is the unit. `n = number of entries`, always.**

I considered and rejected the more sophisticated alternative — pool to `n=60`
and correct with a design effect, `n_eff = n_obs / (1 + (m−1)ρ)`, estimating the
intraclass correlation ρ from the replicates. The arithmetic shows why it isn't
worth it:

| ρ | `n_eff` (60 obs, m=3) | Wilson CI at p̂=0.80 |
|---|---|---|
| 1.00 | 20.0 | [58.4%, 91.9%] |
| 0.75 | 24.0 | [60.4%, 91.3%] |
| 0.50 | 30.0 | [62.7%, 90.5%] |
| 0.25 | 40.0 | [65.2%, 89.5%] |
| 0.00 | 60.0 | [68.2%, 88.2%] |

The entire span of the achievable gain — 58% to 68% on the lower bound — lies
inside the uncertainty of ρ̂ itself, and ρ̂ estimated from `m=3` replicates is
very noisy. So the machinery would buy a CI whose width depends mostly on a
badly-estimated nuisance parameter. Reporting `n = entries` is the conservative
end of that range, needs no estimator, and is trivially auditable by a reader.

**What replication is for instead.** Not `n`. It is spent on the
`CAUGHT_ALWAYS` / `CAUGHT_SOMETIMES` split (§4.2), which yields a **band**:

- **Reliable rate** = `CAUGHT_ALWAYS / n` — caught on every observation.
- **Optimistic rate** = `(CAUGHT_ALWAYS + CAUGHT_SOMETIMES) / n` — caught at
  least once.

Both get their own Wilson CI at `n = entries`. When N=1 they coincide, and the
report must say so rather than implying a stability measurement that wasn't made.
This band carries strictly more decision-relevant information than a pooled point
estimate: a tool with a wide band is unreliable, and a user of that tool
experiences the width directly.

### 5.3 Rates, with exact denominators

Let `E_mal` = entries with `expectedVerdict = DANGEROUS` and at least one
non-`VOID` observation; `E_neg` = the same for `expectedVerdict = SAFE`.

```
n_mal = |E_mal|
detection_reliable   = |CAUGHT_ALWAYS|                        / n_mal
detection_optimistic = |CAUGHT_ALWAYS ∪ CAUGHT_SOMETIMES|     / n_mal
miss_rate            = |MISSED_ALWAYS|                        / n_mal
abstention_rate      = |ABSTAINED_ALWAYS|                     / n_mal
                       (+ NEVER_CAUGHT_MIXED reported explicitly)

n_neg = |E_neg|
specificity          = |CLEARED_ALWAYS|                       / n_neg
false_alarm_rate     = |FALSE_ALARM_ALWAYS ∪ CLEARED_SOMETIMES| / n_neg

proof_share          = |CAUGHT_PROVED observations| / |CAUGHT_* observations|
dealbreaker_share    = |CAUGHT_STRUCTURAL observations| / |CAUGHT_* observations|
```

Two checkable identities the projector must assert, in the spirit of the
`AuditSetRollup` invariant from the Phase 0 contract findings (§C2):

```
CAUGHT_ALWAYS + CAUGHT_SOMETIMES + MISSED_ALWAYS + ABSTAINED_ALWAYS + NEVER_CAUGHT_MIXED == n_mal
proof_share + dealbreaker_share == 1
```

`UNOBSERVED` entries are outside `n_mal`/`n_neg` by construction and are reported
as a separate count with their VOID causes.

**`miss_rate` carries the weaker guarantee of §3.2.1 and its caption must say so.**
It is the rate of *dispatch-complete* false negatives — every suspicion ran and
terminally resolved — not of fully-evaluated ones. It is therefore published only
beside the run's evidentiary-coverage counts (§3.4.1), and the two move together: a
run with non-zero fidelity defects has a `miss_rate` that is, in the direction the
defect biases, **overstated**. Detection is understated by the same mechanism, which
is why §9 rule 7 attaches coverage to the detection caption rather than to this one
alone.

**B-6: v1.1's "precision" is renamed to specificity.** v1.1 §8 defined
`Precision = 1 − (Σ false_positives on negative controls / Σ negative-control
runs)`. That quantity is *specificity* (true-negative rate), not precision
(`TP/(TP+FP)`). Precision depends on prevalence, and the prevalence in these
corpora is an artifact of how they were built — the Datadog corpus is 100%
malware (all 20 entries `expectedVerdict: DANGEROUS`). Publishing "precision"
from it would be publishing a number about the corpus, not the tool. So:
**publish sensitivity (detection) and specificity separately, each over its own
corpus, each with its own `n` and CI.** If a precision figure is ever wanted, it
must be stated as *precision at an assumed prevalence p*, with `p` named — and
that is a marketing choice, not a measurement.

v1.1 §6's substantive claim — that a recall-only benchmark is gameable, because
a tool that flags everything scores 100% — is **exactly right and is the reason
negative controls are load-bearing rather than nice-to-have.** §6.5 funds them
accordingly.

### 5.4 Headline convention: publish the lower bound

**B-5.** Every rate is published as `k/n`, `p̂`, and the Wilson 95% interval. The
*one-number* summary, when a single number is unavoidable (a metric tile, an
abstract, a landing page), is the **Wilson 95% lower bound**, phrased as a bound:

> "NpmGuard flagged ≥ 83.9% of a 20-package Datadog corpus (20/20 reliable
> detections, 95% Wilson lower bound, n=20)."

Three properties make this the right convention:

1. It cannot be a bare point estimate — the bound *is* the uncertainty.
2. It is conservative in the direction that matters. Overclaiming is the failure
   mode of vendor benchmarks; a lower bound cannot overclaim.
3. **It makes corpus size self-motivating.** A small `n` yields a weak bound even
   at a perfect score: 20/20 gives ≥83.9%, while 60/60 gives ≥94.0%. Nobody has
   to be argued into expanding the corpus; the headline number does it. This is
   the cleanest incentive alignment available and it directly serves O-3.

A tile component must therefore take `(k, n)` and never a pre-computed `p` — a
rate that arrives without its denominator cannot be rendered.

### 5.5 Stability reporting

Published alongside, from the replicates:

- **Unanimity rate** — fraction of entries where all non-VOID observations agreed
  on the outcome. This is the honest headline for "how deterministic is this
  **pipeline**". Note the noun: it is *not* "how deterministic is this model", and
  §6.5.1 explains why that substitution is the error the N=5 probe was about to
  make. Unanimity is a property of sensors, renderer and model jointly.
- **Flip list** — every `*_SOMETIMES` entry, by name, with its per-run outcomes
  **and each run's fidelity/capture counts beside them** (§3.4.1). Short, concrete,
  and the first thing a skeptic should be shown. The fidelity columns are what let
  that skeptic tell "the model changed its mind" from "the model was shown
  different evidence" — the two readings that a bare flip list conflates.
- **Attributable-flip fraction** — of the flips observed, how many occurred within a
  constant fidelity-and-capture class (§6.5.1 change 2). Published as a count over a
  count, never as a rate on its own, because its denominator is usually tiny.
- **N as configured**, and the explicit statement that at N=1 the reliable and
  optimistic bands are the same measurement.

---

## 6. Corpus, stratification, and O-3

### 6.1 What the pinned corpus is today

`bench/dataset/manifest.full.json`, `datasetVersion: "0.2.0-datadog"`,
generated 2026-05-08. **20 entries**, all `expected.verdict: DANGEROUS`:

| Stratum (`category`) | n | Discovery-date range |
|---|---|---|
| `datadog-compromised` (compromised_lib) | 14 | 2025-09-14 → 2026-04-02 |
| `datadog-malicious-intent` | 6 | 2024-05-16 → 2024-12-23 |

`difficulty` is `null` for all 20 (a v1 mutation-testing field with no producer),
`expected.capabilities` is `[]` for all 20, and `expected.kind` is `"AI_STATIC"`
for all 20 — see §2.2 for what that does to v1's scoring rule.

**There are zero negative-control entries.** Specificity is currently
unmeasurable, and therefore so is any defence against the gameability argument
in v1.1 §6.

### 6.2 What v1.1 §2–§3 got right and is kept

I went looking for reasons to rewrite these sections and did not find them. They
are kept, with attribution:

- **Datadog replay as the primary method, mutation testing deferred.** The four
  arguments in v1.1 §2 — credibility with a CISO, no mutator-design bias, free
  competitive comparison, a dataset that stays current for free — are still the
  right arguments, and the "your mutations are not realistic" critique is still
  unanswerable. Kept.
- **The named trade-offs.** Selection bias (the corpus is what GuardDog flagged,
  so attacks GuardDog missed are absent), limited per-class control, and the
  ethics of execution. All still true, all still stated. Kept.
- **The `compromised_lib` vs `malicious_intent` stratification and why it is the
  interesting axis.** `malicious_intent` is the easy target (no benign behaviour
  to hide the payload); `compromised_lib` is the realistic one (a real payload
  inside thousands of legitimate lines, which is what a CISO actually fears).
  This survives directly into `BenchEntrySchema.category`
  (`shared/src/bench.ts:65-68`), deliberately typed as a free string so the
  dataset can re-cut its own taxonomy. Kept.
- **Publishing the manifest hash of the exact dataset commit.** Now enforced by
  `BenchCorpusSchema.manifestSha` (`shared/src/bench.ts:44-46`). Kept and
  strengthened.
- **§6 negative controls** — kept in full; see §5.3 and §6.5.
- **The Wilson treatment and the Wald rebuttal** — kept verbatim (§5.1).

### 6.3 What this corpus cannot support, with the arithmetic

**(a) Per-stratum reporting is not viable at 14/6.** Assuming a strong p̂:

| Stratum | n | p̂ | Wilson 95% CI |
|---|---|---|---|
| `compromised` | 14 | 0.80 | [53.9%, 93.2%] |
| `malicious_intent` | 6 | 0.83 | [43.6%, 97.0%] |

A stratum whose interval spans 50 percentage points cannot support the sentence
"NpmGuard is better at X than Y". **This rejects one of O-3's three options
outright**: "report per-stratum only" does not escape the width problem, it
doubles it. Per-stratum reporting needs roughly `n ≥ 25` per stratum to be worth
printing, and even then only as a bound.

**(b) The temporal slice is dead.** v1.1 §3 wanted "recall on packages discovered
within the last six months at run time" to isolate performance on attacks too
recent to have been memorised. At today's date that window starts 2026-01-25 and
contains **2 entries** (`mgc@1.2.2`, 2026-04-02; `cline@2.3.0`, 2026-02-17). A
2/2 perfect score gives [34.2%, 100%]. The metric is not weak, it is absent.
Either the corpus is refreshed with recent samples on a schedule, or this metric
is retired; reporting it at n=2 would be worse than not reporting it.

**(c) The two strata are temporally disjoint, so the stratum comparison is
confounded.** All 14 `compromised` entries are from 2025-09 or later; all 6
`malicious_intent` entries are from 2024. Any difference between the strata is
equally explicable as a recency effect (2024 attacks are more likely to be in
model training data). **This is a new finding, not in v1.1, and it means the
stratum comparison cannot be published as a difficulty finding until the strata
are date-balanced.** Fixing it is free at selection time — draw
`malicious_intent` samples from 2025–2026 too.

### 6.4 The core arithmetic for O-3

The decisive fact, which is not obvious and reverses the intuition behind N=3:

> **At a fixed audit budget, replication buys nothing for the headline interval,
> and entries buy everything.** Because `n = entries` (B-4), a budget `B` split as
> `N` runs over `B/N` entries has `n = B/N`. Larger `N` means smaller `n` means a
> *wider* interval.

At `B = 60` audits — exactly v1's proposed 20 × 3:

| Design | entries (`n`) | Lower bound at p̂=0.90 | at p̂=1.00 |
|---|---|---|---|
| N=1 × 60 entries | 60 | **79.9%** | **94.0%** |
| N=2 × 30 entries | 30 | 74.4% | 88.6% |
| **N=3 × 20 entries (v1)** | **20** | **69.9%** | **83.9%** |
| N=4 × 15 entries | 15 | 66.0% | 79.6% |

v1's N=3 was the second-worst use of its own budget. The reason not to go to N=1
is not precision — it is that N=1 cannot detect a flaky entry at all, so a single
unlucky run permanently mislabels a package and the `CAUGHT_SOMETIMES` bucket
(§4.2) is unmeasurable. **N=2 is the cheapest N that can observe a disagreement**,
and that is the whole job of replication under this design.

Corpus-size ladder at N=2 (malware side):

| Entries | Audits | Lower bound at p̂=0.95 | at p̂=1.00 |
|---|---|---|---|
| 20 (today) | 40 | 76.4% | 83.9% |
| 30 | 60 | 80.9% | 88.6% |
| **40** | **80** | **83.5%** | **91.2%** |
| **50** | **100** | **85.1%** | **92.9%** |
| 60 | 120 | 86.3% | 94.0% |
| 100 | 200 | 88.8% | 96.3% |

Negative-control sizing, which is what makes the recall number mean anything.
With **zero** false alarms observed, the demonstrable specificity bound is:

| Clean entries | Specificity ≥ | i.e. false-positive rate ≤ |
|---|---|---|
| 20 | 83.9% | 16.1% |
| 40 | 91.2% | 8.8% |
| **73** | **95.0%** | **5.0%** |
| 125 | 97.0% | 3.0% |
| 165 | 97.7% | 2.3% |

**This retro-justifies v1.1 §6's threshold and prices it.** v1.1 demanded
"precision ≥ 95%, i.e. false-positive rate ≤ 5%. Anything worse is a research
prototype." Correct as an ambition — and it requires **73 clean entries scored
perfectly** to demonstrate. At 20 clean entries the claim is not provable even
with a flawless tool. v1 set a bar it had no corpus to clear.

Three pieces of good news on the negative-control side:

1. **Selection is already done.** `engine/config/watchlist-packages.json`
   contains **165** popular packages, and it is already wired into
   `npmguard-ops audit-latest` (`engine/npmguard/ops.py:395-399`).
2. **The gate already exists and is already a false-positive canary.**
   `npmguard-ops bench-check` defaults to `--max-dangerous 0`
   (`ops.py:413`) — it fails if *any* watchlist package is flagged. That is
   precisely a specificity check. It is mislabelled as a "bench" command, but the
   instrument is real and should be adopted rather than rewritten.

3. **They are the cheap half of the corpus.** One would expect the opposite —
   popular packages are large and the phase timeouts scale with source volume
   (`timeout_scale`, `pipeline.py:244-247`, capped at 4×). The recorded evidence
   says otherwise: a clean package raises no hypotheses, so the orchestrator loop
   that dominates cost never runs, and `chalk@5.6.2` audits **7× cheaper in input
   tokens** than `test-pkg-env-exfil@2.0.1`. See §7.3(b). The negative-control
   corpus is therefore the highest-value expansion per dollar on every axis:
   cheapest to select, cheapest to run, and the only thing that makes the recall
   number falsifiable.

### 6.5 Recommendation (B-8)

**Expand the corpus, drop N to 2, and fund negative controls first.**

| Component | Entries | N | Audits | Purpose |
|---|---|---|---|---|
| Datadog malware, date-balanced across strata | 50 | 2 | 100 | detection band |
| Negative controls from the 165-package watchlist | 75 | 2 | 150 | specificity ≥95% is demonstrable at 73 |
| Variance-decomposition probe — **selected after the main run**, ≤10 entries | ≤10 | 5 | ≤+30 | **attributing** replication variance; see §6.5.1, which replaces this row's original purpose |
| **Total per full run** | **125** | — | **≤280** | |

**The third row changed meaning, not just wording.** It was specified as a fixed
10-entry probe measuring "ρ / unanimity at a useful `m`". Both halves of that
purpose were wrong — ρ is a parameter §5.2 explicitly declined to estimate, and
unanimity at `m=5` cannot be *attributed* to the model. §6.5.1 is the correction.

Expected headline shape, if the engine performs as its design intends
(near-perfect on a corpus of known malware): `50/50` reliable detections →
**"≥92.9% detection (95% Wilson lower bound, n=50)"**, alongside
**"≥95.0% specificity, 0 false alarms in 75 clean packages"**. Both are
publishable sentences. Neither is available today at any performance level.

**Minimum publishable tier**, if 280 audits is too expensive: **40 malware + 40
controls at N=2 = 160 audits.** Yields ≥91.2% detection at a perfect score and
≥91.2% specificity (FP ≤ 8.8%) — which is honest, and honestly short of v1.1's
own 95% bar. Say so in the report rather than rounding.

**Explicitly do not** publish a headline from the current 20-entry, zero-control
corpus. Not because 20 is a shameful number, but because with no negative
controls the recall figure is unfalsifiable in the specific way v1.1 §6 warned
about. A 20-entry run is a **smoke test** for the harness — a legitimate and
useful thing to run first, labelled as such.

**Cost check.** Selection is not the expensive part (v1.1 already noted the
Datadog corpus has ~26 000 samples). From the real token evidence in §7.3, the
280-audit run is ≈17.0 M input + 2.3 M output tokens, which prices between
**≈$8** (cheap-tier models) and **≈$262** (the engine's deliberately-pessimistic
fallback rate). At the low end this recommendation needs no defence. At the high
end it is a real decision — and note that the spread is driven by an
*unrecorded model configuration*, not by corpus size, so the first thing to fix
is §7.5, not the corpus.

If the full run still exceeds the acceptable spend, the honest levers in order
are: (1) drop to the 40+40 minimum tier; (2) trim the variance-decomposition probe
(§6.5.1 makes it demand-driven, so it may cost nothing); (3) trim negative
controls — reluctantly, since §7.3(b) shows they are the cheap half.
**Never trade entries for higher N** — higher N actively worsens the number being
published (§6.4).

### 6.5.1 The N=5 probe measures the wrong stochasticity (B-14)

**What is not in dispute.** D-7's reasoning — that v1 pooled entries × runs into a
false `n`, that with `n = entries` the intuition behind N=3 reverses, and that
replication therefore has to be a *separate, small* instrument rather than a way to
buy CI width — is correct, corrects a real pseudo-replication error, and is
untouched by this subsection. §5.2 and §6.4 stand. What follows is a **confound
D-7 did not account for**, not a reversal of it.

**The defect.** D-7 spends ~50 audits (+30 marginal) to measure "replication
stability" and reports the result as a fact about the model. But a bench audit is
not a model sampled twice — it is *sensors → renderer → model*, sampled twice, and
**every stage of that chain is nondeterministic.** As specified, the probe cannot
attribute what it measures, so it would report sensor variance as model variance.

**The measurement that establishes it, and it is not a rendering artefact.** Across
the nine near-identical recorded runs of one file (`test-pkg-env-exfil@2.0.1`,
`setup.js`, same trigger, same setup, wall times **4.73–5.58 s**, all exit 0, none
timed out), the L2 pcap sensor produced an `http_request` event in **3 of 9** —
`hyp-0004`, `hyp-0008`, `hyp-0009` — and in **6 of 9** it captured nothing at that
layer. This is a *capture*-level count (`events[].stream == "L2:pcap"`), taken
directly from the sealed artifacts, and it is **not** what `67f830f` fixed: that
commit taught the L1 parser to read the peer address, which supplies the same fact
by a **different route**. The pcap sensor's own 3-of-9 is untouched by it and is
intrinsic — it depends on readiness barriers and packet timing, not on a regex.

**Why this is a confound and not merely a bug.** Two of the three components of
run-to-run variance are not model behaviour at all:

| Variance source | Nondeterministic? | Fixed by the landed commits? |
|---|---|---|
| **Capture** — which sensors observed the act (L2 pcap 3/9) | Yes, intrinsically | **No.** Independent of `67f830f`'s L1 route. |
| **Render** — whether a captured fact reached the judge legibly | Was, badly | Largely: fidelity defects 16 → **0** on the corpus at `67f830f`; but **87 false-target events remain**, and §3.4.2(4) shows the corpus cannot bound this for today's engine without a re-record. |
| **Model** — whether the judge, given the same legible timeline, decides the same way | Yes | Not applicable — this is the thing the probe is *supposed* to measure. |

A probe that reports one number over all three, and labels it model stochasticity,
is measuring the chain and naming the last link. That is the same class of error as
v1's pooled `n`: a real measurement attributed to the wrong entity.

**Does the probe survive? Yes — re-scoped, re-sequenced, and reporting a
decomposition instead of a rate.** Four changes, and the first is the one that
matters:

1. **Per-run render fidelity and capture are recorded on *every* bench audit, not
   on the ten probe entries** (B-12, §3.4.1). This is what makes variance
   attributable, and it is why it cannot be a footnote: attribution is a property of
   the whole run's records, not of a sub-experiment. It costs zero LLM tokens — the
   sealed artifact is already on disk — and it turns all 250 main-run observations
   into a variance dataset with a covariate, against the probe's 50.
2. **The probe reports a decomposition, not a stability rate.** For every entry that
   flipped, classify the flip: did the two observations differ in fidelity/capture
   class, or not? Only flips **within a constant capture-and-fidelity class** are
   evidence of model stochasticity. The published quantity is therefore
   `flips_attributable_to_model / flips_observed`, with both counts shown — never a
   bare unanimity number.
3. **Entries are selected *after* the main run, from where the information is.** A
   pre-chosen entry that returns 5/5 unanimous contributes **zero** variance to
   decompose, so a fixed 5-malware + 5-control selection spends its whole budget
   with no guarantee of measuring anything. Draw instead from two strata the main
   run identifies: (a) the `*_SOMETIMES` flip list — entries known to disagree; and
   (b) entries that were unanimous in *outcome* but varied in *fidelity or capture*
   — the "lucky so far" entries, where a latent flip is most likely and which a
   fixed selection would never find. This makes the probe **demand-driven**: if
   nothing flipped and fidelity was constant, the probe is unnecessary and costs
   nothing, and that null result is itself the finding.
4. **Do not report ρ.** The original row's stated purpose included it, which
   contradicts §5.2 — that section rejects the design-effect correction precisely
   because ρ̂ from a handful of replicates is a badly-estimated nuisance parameter,
   and `m=5` on ten entries is a *worse* estimator than the `m=3` §5.2 declined to
   use. Publishing ρ here would resurrect the machinery §5.2 argued away.

**What `m=5` actually buys, so the probe is not oversold.** Its only statistical
gain over `m=2` is flip-detection power. Writing `p` for an entry's per-run catch
probability, the chance of observing a disagreement in `m` runs is
`1 − pᵐ − (1−p)ᵐ`:

| `p` | `m=2` | `m=3` | `m=5` | `m=10` |
|---|---|---|---|---|
| 0.95 | 9.5% | 14.3% | **22.6%** | 40.1% |
| 0.90 | 18.0% | 27.0% | **40.9%** | 65.1% |
| 0.80 | 32.0% | 48.0% | **67.2%** | 89.3% |

So `m=5` roughly **doubles** flip-detection power over `m=2` — real, and modest.
What it emphatically does **not** buy is a per-entry catch probability: at a true
`p = 0.90`, a unanimous 5/5 occurs 59% of the time, and Wilson on 5/5 gives only
**≥56.6%**. §10's threat item claiming the probe "partially offsets" `m=2`'s
inability to estimate per-entry probability is therefore **overstated, and is
corrected there**: the probe improves *detection* of instability, never
*estimation* of it.

**Sequencing.** The probe must run after the fidelity work D-9 already ordered
ahead of Phase 7b, and after the main run. Run it against today's renderer and it
would decompose variance whose render component is bounded only by an optimistic
figure (§3.4.2(4)) — which is a measurement of the wrong engine for the second time,
in exactly the way O-7's prerequisite warns about.

---

## 7. Cost and latency reporting

### 7.1 What must be reported per run

Carried from v1.1 §9, which was right about *what* to report:

- wall clock per audit: **p50, p95, p99**, plus the total run wall clock
- LLM tokens, prompt and completion, summed and per entry
- total USD cost, with the price basis named and snapshotted at run time
- sandbox compute time

The contract already forces the important part of the honesty here:
`BenchRunSchema.tokenCostUsd` is `z.number().nullable()` with the explicit rule
that it is **null while unknown, never 0 as a stand-in**
(`shared/src/bench.ts:106-109`), and `BenchRunItemSchema.tokensPrompt` /
`tokensCompletion` are likewise nullable (`bench.ts:139-140`). A run that cannot
account for its spend says so.

**Good news: the accounting substrate already exists and is already attributed
per audit and per phase.** Two tables record every LLM call:
`llm_runs{context_kind, context_id, role, total_cost_usd}`
(`engine/kit_llm/capture.py:19-32`) and, one row per *physical* call including
retries and fallbacks, `llm_attempts{model, actual_model, in_tokens, out_tokens,
cached_tokens, cost_usd, latency_ms, …}` (`capture.py:34-75`). All six engine
call sites pass `context=("audit", audit_id)` with a `role` naming the phase —
`intent` (`phases.py:373`), `flag` (`phases.py:504`), `hypothesis`
(`phases.py:682`), `propose` (`hypothesis_agent.py:229`), `agent`
(`hypothesis_agent.py:381`), `judge` (`orchestrator.py:97`). So per-audit and
per-phase token totals are one `GROUP BY role` join, and a helper that does
exactly this sum already exists at
`engine/kit_llm/bench/harness.py:1319-1331` (`ledger_cost`) — **it is simply
never called from `engine/npmguard/`.** Wiring it is small; §7.4 covers what is
genuinely missing.

**N-13 requirement:** the cost of a run must be computable *before* it starts,
as `entries × N × observed_cost_per_audit`, using the per-audit cost observed
from the previous run on the same `(engineSha, modelId)`. The bench summary
therefore publishes a **per-audit cost distribution**, not just a total — a total
alone cannot be extrapolated to a different corpus size, which is exactly the
question O-3 asks. §7.3 shows the distribution is wide enough that this matters
a great deal.

### 7.2 The latency envelope, from the code

Independent of any measurement, the engine's own configured timeout budgets bound
a single audit. With `timeout_scale ∈ [1, 4]` (`pipeline.py:244-247`):

| Phase | Budget | at scale 1 | at scale 4 |
|---|---|---|---|
| `resolve` | 240 000 ms (`pipeline.py:163-170`) | 4 min | 4 min |
| `inventory` | 60 000 ms (`pipeline.py:203-223`) | 1 min | 1 min |
| `intent-extraction` | 120 000 ms (`pipeline.py:264-274`) | 2 min | 2 min |
| `flag` | 600 000 ms × scale (`pipeline.py:286-299`) | 10 min | 40 min |
| `hypothesize` | 1 200 000 ms × scale (`pipeline.py:309-336`) | 20 min | 80 min |
| `orchestrator` | 2 400 000 ms × scale (`pipeline.py:372`), **soft** | 40 min | 160 min |
| — per hypothesis | 360 s (`orchestrator.py:27`) | 6 min | 6 min |
| **Worst-case total** | | **≈77 min** | **≈4.8 h** |

Those six names are exactly the `trace[]` phase vocabulary, so a report's
`trace` is directly comparable against this table. Two caveats worth writing
down because they change how the numbers are read:

- The `orchestrator` budget is a **soft deadline checked between hypotheses**
  (`orchestrator.py:166-167`), not an `asyncio.timeout`; it is the only phase not
  wrapped by `_timed_phase`, and its `PhaseLog` is built by hand
  (`pipeline.py:381-388`).
- **`flag` and `hypothesize` run 8-way concurrent**
  (`asyncio.Semaphore(NPMGUARD_TRIAGE_CONCURRENCY)`, default 8, at
  `phases.py:417` and `phases.py:730`), while the **orchestrator is strictly
  serial** (`orchestrator.py:166`). So summing per-call LLM latency *overstates*
  wall clock for the two triage phases and is a good proxy for the judge loop.
  Any latency figure must say which it is.

For sizing a full run: audits execute at most `max_running_sessions` at a time,
default **4** (`engine/npmguard/config.py:47`). §6.5's 280 audits at the observed
LLM-latency scale of §7.3 is on the order of a day of wall clock, not a week —
but that depends on concurrency remaining the binding constraint rather than the
per-audit ceiling above.

### 7.3 What real recorded audits actually cost

Four audits of real production traffic survive as replay fixture bundles under
`engine/tests/fixtures/llm/`, exported from a production `llm_attempts` ledger
(`engine/tools/export_fixtures.py:94-97`, `:159`). These are the best cost
evidence in the repository. Token counts and latency are real; `cost_usd` was not
exported, which is why §7.4 exists.

| Audit | Verdict | LLM calls | in tokens | out tokens | cached | Σ call latency | sandbox wall |
|---|---|---|---|---|---|---|---|
| `is-number@7.0.0` | SAFE | 6 | 8 745 | 1 154 | 0 | 10.9 s | 9.8 s |
| `chalk@5.6.2` | SAFE | 8 | 16 723 | 1 760 | 320 | 80.0 s | 5.2 s |
| `test-pkg-env-exfil@2.0.1` | DANGEROUS | 55 | 123 732 | 17 682 | 18 176 | 750.5 s | 70.8 s |
| `test-pkg-dns-exfil@0.2.1` | DANGEROUS | 83 | 209 105 | 36 937 | 20 352 | 1 191.9 s | 107.2 s |

Recorded models: `deepseek/deepseek-v4-flash` for three bundles,
`google/gemini-2.5-flash` for `is-number`. Sandbox runs never timed out (31
artifacts, 4.5–10.7 s per run).

**Three findings that change the design, in order of importance.**

**(a) A DANGEROUS audit costs 7–24× a SAFE audit, and the driver is the
orchestrator, not package size.** Compare the role breakdown: `chalk`'s 8 calls
are 5 `flag` + 1 each of intent/hypothesis/judge, whereas `env-exfil` spends 19
`hypothesis` + 13 `agent` + 16 `judge` calls. Cost is dominated by *how many
suspicions reach the orchestrator loop*, and that loop only runs when the flag
phase raised something (`pipeline.py:302-307` returns early when it did not).

**(b) This reverses an assumption a cost model would naturally make, including
one in an earlier draft of this document.** I expected negative controls
(popular, large packages) to be the expensive end because `timeout_scale` grows
with source volume. The evidence says the opposite: `chalk` is a popular package
and is the second *cheapest* audit on record, because a clean package generates
no hypotheses to run. **Negative controls are therefore the cheap half of the
corpus, and §6.5's 75 clean entries are far more affordable than the 50 malware
entries.** That strengthens the recommendation rather than weakening it. The
honest residual caveat: none of the four bundles is a *large* popular package, so
the flag-phase cost of an 80-file dependency (`triage_max_files` default 80,
`config.py:51`) is an unmeasured middle case.

**(c) Budget arithmetic for §6.5, and why the model choice dominates it.** Using
`env-exfil` as the malware proxy and `chalk` as the control proxy, the
recommended 280-audit run is roughly **17.0 M input + 2.3 M output tokens**. What
that costs spans a factor of ~33 depending only on which model tier is used:

| Price basis | Provenance | Full run (280 audits) |
|---|---|---|
| $10.00 / $40.00 per Mtok | the engine's deliberately-pessimistic fallback rate (`kit_llm/config.py:38-39`) | **≈ $262** |
| $0.30 / $1.20 per Mtok | a real cheap-tier rate recorded in-repo for `minimax-m3` (`llm_runtime.py:54-55`) | **≈ $8** |

At the cheap end, corpus expansion is essentially free and O-3's answer is
trivially "expand". At the pessimistic end it is a real budget decision. **The
spread is not measurement noise — it is an unrecorded configuration choice**, and
that is the substance of §7.4 and of Open item 1.

For reference, applying only the engine's own pessimistic fallback rate to the
recorded token counts values a single audit at $0.134 (`is-number`), $0.235
(`chalk`), $1.781 (`env-exfil`), $3.385 (`dns-exfil`). **Publish these as a
ceiling with that provenance attached, never as a price** — the models actually
recorded are materially cheaper than $10/$40 per Mtok.

### 7.4 A trap the runner must not fall into

`npmguard-ops audit-batch` defaults to `--timeout-ms 1_200_000` — **20 minutes**
(`engine/npmguard/ops.py:390`) — which is *below* the engine's own ~72-minute
scale-1 envelope. A slow-but-succeeding audit would be abandoned by the client
and recorded as a failure the engine never had.

**Requirement:** the bench runner's client timeout must strictly exceed the
engine's phase envelope for the corpus's worst-case `timeout_scale`, and any
client-side timeout is classified **`VOID`**, never `ABSTAINED` (§4.5) — it is a
harness artifact. A run whose failures are client timeouts is measuring its own
patience.

### 7.5 What is genuinely missing, stated precisely

Tokens and latency are measurable today. **Dollars are not**, and the reason is
narrow and fixable rather than architectural:

1. **No price list exists for the models the engine actually runs.** `cost_usd`
   is written only when the provider reports a native cost — which happens on
   OpenRouter (`provider.py:439-445`, requested via `usage: {include: true}` at
   `provider.py:434`) and **never** on the plain OpenAI-compatible adapter, whose
   `_native_cost` returns `None` unconditionally (`provider.py:283-284`).
   Otherwise `cost_usd` falls back to `spec.prices`, and the primary model specs
   are built without prices (`llm_runtime.py:104-112`), so
   `_result_cost` returns `None` (`client.py:938-941`). Under the default
   `llm_backend="anthropic"` (`config.py:25`), **`cost_usd` is NULL on every
   primary-model row, forever.** Tokens are recorded; dollars are not.
2. **No price snapshot is stored.** v1.1 §9 promised "the OpenRouter price list at
   run time (snapshot stored alongside the result for historical accuracy)". That
   is **unimplemented** — there is no price fetch, no dated price file, and the
   only hardcoded price table is two zero-cost `:free` slugs
   (`llm_runtime.py:70-73`). The requirement is *kept*, and currently unmet.
3. **The $10/$40 per-Mtok fallback is a budget guard, not a price.**
   `kit_llm/config.py:38-39` documents it as "deliberately expensive: a budget
   that undercounts is not a budget". Using it as a cost estimate would overstate
   spend by the ~33× of §7.3.
4. **No ledger data exists locally.** Every reachable SQLite has **0 rows** in
   `llm_attempts`, and `engine/.env` sets `NPMGUARD_MOCK_LLM=true`, so a local run
   today burns no tokens at all. All real token evidence is the four exported
   fixture bundles in §7.3.
5. **Two smaller gaps in the same area:** `resolve_costs()`, the deferred-cost
   backfill (`spend.py:178-242`), is defined and never called, so any OpenRouter
   cost that only arrives via a later `GET /generation` is never collected; and
   there is **no per-audit spend cap** — the only gate is a global trailing-24h
   window whose budget defaults to `0`, i.e. disabled
   (`spend.py:164-176`, `config.py:29`).

**The unblocking action** is therefore narrower than "measure the cost": set
`ModelSpec.prices` for the primary slugs (or run the bench on OpenRouter, which
populates native cost), write a dated price snapshot next to each run, and call
the `ledger_cost` join that already exists. Then run the current 20-entry corpus
once at N=1 as a calibration pass (20 audits, publish nothing) to confirm the
§7.3 token model on real fixtures rather than on proxies.

### 7.6 One `modelId` cannot describe a run

`BenchRunSchema.modelId` is a single string (`shared/src/bench.ts:102`) and is
non-nullable on the grounds that a run missing it cannot be compared to another
(`bench.ts:85-87`). **That shape is insufficient, and it is a contract bug worth
fixing before the runner is written.** The engine does not run one model:

- Roles split across **two** configured models — `intent` and `flag` on
  `triage_model`, and `hypothesis`/`propose`/`agent`/`judge` on
  `investigation_model` (`llm_runtime.py:157-209`). Both default to
  `deepseek/deepseek-v4-flash`.
- Every role additionally carries a **cross-provider fallback tail**
  (`llm_runtime.py:62-73`, `_fallback_specs` at `:76-93`), so one logical phase
  can bill on several models within a single audit.
- ~~The repo contains **three disagreeing sources of truth** about what actually
  runs~~ — **resolved.** It did: the `config.py` defaults read
  `claude-haiku-4-5-20251001`/`claude-sonnet-4-6` (never ran),
  `engine/.env.template` declared `deepseek/deepseek-v3.2` + `z-ai/glm-5` (never
  validated, and it is what a deploy copies), and the recorded traffic showed
  `deepseek/deepseek-v4-flash`. Only the recording was evidence — it stores the
  model that *answered*. The defaults now carry the recorded pair, the template
  declares no pair at all, and `engine/tests/test_model_config_agreement.py`
  makes the duplication **unreachable** rather than policed: C2 requires the
  shipped model to appear in the corpus, C3 forbids any second declaration.

Because per-attempt `actual_model` is already recorded (`capture.py:34-75`), the
fix is to make the reproducibility identifier **observed rather than declared**:
record the set of `(role, actual_model)` pairs a run actually used, and publish
the configured `(triage_model, investigation_model)` alongside it. A run whose
observed model set differs from its configured one — because a fallback fired —
is a run whose comparability is compromised, and that must be visible rather than
averaged in. This is raised as Open item 8.

---

## 8. Reproducibility

### 8.1 The four identifiers — kept

v1.1 §10's four identifiers survive intact and are now non-nullable in the
contract, which is the right forcing function
(`shared/src/bench.ts:98-104`, rationale at `:85-87`):

1. `datasetVersion` — plus `manifestSha` over the entry manifest
   (`bench.ts:42,46`), so a corpus whose content changed under a fixed
   `(name, version)` is caught rather than silently compared.
2. `engineSha` — the engine git commit.
3. `modelId` — the LLM identifier.
4. `sandboxImageDigest` — the Docker image, **by digest**.

Kept from v1.1: datasets are **immutable once tagged**; new samples produce a new
dataset version. This is what allows comparing engine versions on a fixed corpus
or corpora on a fixed engine.

**One gap to close in the runner, and it is currently a hardcoded lie.** The
engine's config holds `sandbox_image: str = "npmguard-sandbox:v1"`
(`engine/npmguard/config.py:60`) — a **mutable tag**, not a digest. A tag is not a
reproducibility identifier: `:v1` can be rebuilt. Nothing in the repo resolves a
digest: `engine/npmguard/docker.py:81` passes the tag straight through, and the
v1 TypeScript runner writes `sandboxImageDigest: null`
(`bench/src/runner/audit-all.ts:108`) into a field the v2 contract declares
non-nullable. The runner must resolve the concrete image ID at run start
(`docker image inspect`) and store it. Because the image is built locally rather
than pulled, `RepoDigests` will typically be empty and the local image `Id` is the
correct value.

Note the same class of gap on the other two identifiers: `bench.py:58-60` *reads*
`engineSha` and `modelId` from a result file, but `audit_latest`'s payload
(`ops.py:234-249`) never *writes* them — so for every result the Python ops CLI
has ever produced, both are `None`. All three are one-line additions to whatever
writes a run, and all three are non-nullable in the v2 contract, which is the
right forcing function.

### 8.2 Where the report for re-projection actually lives (B-9)

This is load-bearing and easy to get wrong. The design doc (§4.3) and the bench
contract (`shared/src/bench.ts:16-17`) both say re-projection works because "the
report stays on disk". **For N>1 that is false as stated:**

- `report_store.save_report` writes to `data/reports/<pkg>/<version>.json`, one
  slot per `(name, version)` (`engine/npmguard/report_store.py:23-24`, `:45-61`).
  Runs 2..N of the same entry **overwrite** run 1. Only the last survives.
- `AuditLog` writes per-run artifacts to
  `audit-logs/<timestamp>_<package>/…` (`engine/npmguard/audit_log.py:25-28`) —
  keyed by timestamp and package name, **not** by `auditId`, so it is not reliably
  joinable to a run item.
- **`audit_sessions.report` is a JSON column keyed by `audit_id`**
  (`engine/npmguard/persistence.py:19`, `:25`), written by `finalize`
  (`persistence.py:227`), with the failure cause in `audit_sessions.error`
  alongside.

**So the per-`auditId` report — the thing that makes G24 ("bench metrics
re-derivable from stored `audit_id`s alone") true — is the database row, not the
filesystem.** The projector must read from there. Two consequences to write down:

- **A retention requirement:** `audit_sessions` rows referenced by a
  `bench_run_item` must not be pruned, or historical runs degrade from
  fully-re-projectable to row-only. If a retention policy exists or is added, bench
  runs need an exemption.
- **An acceptance test for G24** that is actually discriminating: delete
  `data/reports/**`, re-project a stored run from `audit_id`s alone, and compare
  aggregates. If it passes only with the report directory present, the claim is
  false.

### 8.3 The bench lane must bypass the report cache (B-10)

A cache hit is not an observation. Two existing mechanisms would silently produce
fake replicates:

- `audit_batch` short-circuits on an existing report when `--skip-existing` is
  set (`ops.py:167-182`, flag at `ops.py:392`).
- The panel lane resolves cached `(name, version)` pairs instantly from
  `package_verdicts` (design doc F-C3).

If run index 2 and 3 return run 1's report, then the `CAUGHT_ALWAYS` /
`CAUGHT_SOMETIMES` split (§4.2) is an artifact, unanimity is 100% by
construction, and the stability section of the report is a lie. **The bench lane
must force a fresh audit per `runIndex`**, and the acceptance criterion is
checkable: the `auditId`s of an entry's N items must be distinct, and the
`durationMs` values must not be identical.

Relatedly, do not read any rate off `set.rollup`. `BenchRunSchema.set` counts
audited `(name, version)` pairs while there are `runsPerEntry` observations per
entry — the contract flags this explicitly (`shared/src/bench.ts:91-93`), and its
`safe + dangerous + error + pending == total` invariant (Phase 0 findings §C2) is
a *progress* identity, not a scoring denominator.

---

## 9. Reporting shape — misses as prominent as hits (F-G3)

The requirement is a design constraint, not a sentiment, so here is the shape
that satisfies it.

**The primary object of a run report is the per-entry ledger, not the aggregate
tiles.** A run detail is a table with one row per corpus entry — every entry,
always, including the ones that worked — carrying: package + version, stratum,
discovery date, the N per-run outcomes, the derived entry bucket, and a link to
the stored report for each `auditId`. Default sort puts `MISSED_ALWAYS` first,
then `NEVER_CAUGHT_MIXED`, then `CAUGHT_SOMETIMES`, then `ABSTAINED_ALWAYS`, then
`CAUGHT_ALWAYS`. **The failures are above the fold by construction, not by
editorial choice.**

Rules for the aggregate tiles:

1. A tile renders `(k, n)`, `p̂`, and the Wilson interval. A tile component that
   accepts a bare `p` cannot enforce this and must not exist (§5.4).
2. Every tile is a filter link into the ledger. A reader who sees "≥92.9%
   detection" is one click from the exact packages that failed.
3. The three honest failure buckets — **misses, abstentions, voids** — are
   first-class tiles beside detection, not a footnote. A run with a 30%
   abstention rate must be as visually loud about that as about its detection
   rate.
4. **Mandatory companions to the detection tile:** `dealbreaker_share` (§4.4), the
   `VOID` count with causes (§4.5), and the run's **evidentiary-coverage counts**
   (§3.4.1 — fidelity defects, false targets, `undecidableGaps`). Detection without
   dealbreaker share is uninterpretable; any rate without the void count is
   unverified; and **a detection rate published without its coverage counts is a
   rate with an unquantified leak** (§3.2.1).
5. If `VOID > 5%` of attempted observations, the page renders "run not
   publishable — N voided observations" **instead of** rates (§4.5).
6. Empty corpus renders an explicit "no corpus", never "0%" (N-14).
7. **The detection tile's caption states the coverage it was measured at**, not just
   the rate — *"≥92.9% detection at 0 fidelity defects / 5,733 described events"*.
   A caption that omits it is the sentence §3.2.1 forbids. This is also what lets a
   future run be compared to this one after a sensor improvement instead of
   invalidated by it.
8. **A miss is never captioned "fully evaluated".** The ledger's `MISSED_ALWAYS`
   rows link to the per-hypothesis timelines so a reader can check for themselves
   whether the judge was shown the proof — which, per §3.2.1, the verdict alone
   cannot tell them.

Every one of these is a projection over stored observations. None requires a
stored judgment.

---

## 10. Threats to validity

**Carried from v1.1, still true:**

- **Selection bias.** The corpus is what Datadog's GuardDog flagged. Attacks
  GuardDog missed are absent, and a tool sharing heuristics with GuardDog looks
  strong while a divergent one looks weak even when correct. Partially addressed
  by pinning `manifestSha` so future dataset versions can be re-checked; fully
  addressed only by a method that does not share Datadog's biases (mutation
  testing, still deferred).
- **No package-publish testing.** All audits run against local fixture paths, so
  registry-time signals (typosquat similarity, account age, signature) are not
  exercised. The benchmark cannot ethically publish malware to the registry.
- **Native bindings.** Packages shipping `.node` files cannot be instrumented at
  the JS level; relevant to the negative-control corpus, where popular packages
  with native bindings are common.

**New in v2:**

- **Right-for-the-wrong-reason is unmeasured.** Package-level ground truth cannot
  distinguish "confirmed the actual payload" from "confirmed something else, or
  tripped a dealbreaker on an unrelated shell pipe" (§4.7). Mitigated, not
  solved, by the manual adjudication sample.
- **The stratum comparison is confounded with recency** (§6.3c). Do not publish
  a compromised-vs-malicious-intent difficulty claim until the strata are
  date-balanced.
- **`claim.kind` is the tool grading its own taxonomy** (§4.6). Publishable as a
  description of the tool's reasoning; not as recall.
- **Dealbreaker catches are near-free and could inflate recall** at negligible
  LLM cost, making the recall and cost numbers jointly misleading if the share is
  not shown (§4.4).
- **`ABSTAINED` vs `VOID` is a judgment call at the boundary.** Classifying a
  phase timeout (`NPMGUARD-0030`) as `ABSTAINED` is defensible but contestable — a
  timeout caused by a slow provider looks identical to one caused by a hard input.
  The mitigation is transparency: publish the abstention breakdown by error code
  so a reader can re-bucket it.
- **Re-projection depends on database retention**, not on the filesystem (§8.2).
  A pruning policy silently degrades historical runs.
- **The stability band depends on cache bypass** (§8.3). If it is not enforced,
  unanimity is 100% by construction.
- **`m = 2` is a weak instrument for stochasticity.** It detects disagreement but
  cannot estimate a per-entry catch probability. The `m=5` probe (§6.5.1) improves
  *detection* of instability — roughly doubling flip-detection power — and does
  **not** improve *estimation*: at a true per-run catch probability of 0.90, a
  unanimous 5/5 still occurs 59% of the time, and Wilson on 5/5 gives only ≥56.6%.
  An earlier version of this item said the probe "partially offsets" the estimation
  weakness. It does not, and no affordable `m` does; per-entry catch probabilities
  are simply not on this benchmark's menu.
- **Replication variance is a property of the whole pipeline, not of the model**
  (§6.5.1). Sensors, renderer and judge are each nondeterministic, and the
  attribution is only possible because fidelity and capture are recorded per run
  (§3.4.1). Recorded evidence for the confound: the L2 pcap sensor produced an
  `http_request` in **3 of 9** near-identical runs of one file. A run that omits the
  coverage records cannot separate the three sources, and its unanimity number
  should not be described as model stochasticity.
- **`SAFE` asserts dispatch coverage, not evidentiary coverage** (§3.2.1), and this
  is the single largest caveat on the `MISSED` bucket. The assertions
  (`graph.py:309-312`, `:322-325`) quantify over hypothesis *state*; nothing asserts
  that the evidence reached the judge. Two gaps carry it: the renderer is not held to
  the artifact, and `JudgeVerdict.malicious` is a `bool` so a judge cannot report
  insufficiency. **The pre-fix corpus falsified the stronger claim outright** (the
  IMDS probe present in 9 of 9 artifacts, rendered in 3 of 9), and while the landed
  fixes close that particular leak (fidelity defects 16 → 0 on re-render at `67f830f`), **the
  judge gap is untouched and is alone sufficient to keep the weaker wording.**
- **Today's fidelity cannot be established from the recorded corpus — only bounded
  optimistically** (§3.4.2(4)). Facts the pre-fix sensors dropped before sealing are
  absent from the artifacts: no `<unfinished>`/`<... resumed>` marker survives in any
  of the 31, and **0 of 113** `= -1` connects retain the errno that distinguishes a
  succeeded-asynchronously `EINPROGRESS` from a refused connection. A re-record can
  only find *more* defects than the re-render found, never fewer.
- **A residual render defect is live and is worse than an anonymous one.** At
  `67f830f`, **87 events** still render a socket operation with a filesystem path
  inherited from a recycled descriptor — including `connect /pkg/setup.js`, i.e. the
  malware payload file. A vague target starves the judge; a false one misleads it.
  Held back only because landing the one-line fix shifts event ids and needs a paid
  re-record.
- **`UNDECIDABLE` may become the model's escape hatch** (§4.5.1). It is an answer
  always available and never provably wrong, the closed vocabulary is enforced
  post-hoc rather than at decode time, and the mitigation is that the bench treats a
  high undecidable rate as a model-tier disqualifier feeding O-7. This makes the
  bench the detector for a failure mode the bench also depends on — an uncomfortable
  but unavoidable arrangement, and the reason item 3 of §4.5.1 requires the
  reclassification delta be measured before any rate is published.

---

## 11. Retired from v1.1

Each dropped primitive, and why. Nothing here is dropped for the sake of change.

| Retired | Was | Why it goes |
|---|---|---|
| `expectedCapabilities ⊆ report.capabilities` | v1.1 §8 detection conjunct | No top-level `capabilities` on a v2 report (`shared/src/backend.ts:21-32`). Was already vacuous on the pinned corpus — `expected.capabilities: []` for all 20 entries. Replaced by B-1. |
| `proof.kind === "TEST_CONFIRMED"` | v1.1 §8 `verified` tier | No `proofs[]`; `Proof`/`ProofKind` are orphan schemas with zero producers (`shared/src/models.ts:54-62,146-170`). Was **0/20 by construction** — the manifest sets `expected.kind: "AI_STATIC"` throughout. Replaced by `CAUGHT_PROVED` over `confirmedCount` (§4.2). |
| `expectedKind`, `expectedCapabilities`, `difficulty` as corpus fields | v1.1 §5 mutator metadata | `difficulty: null` on all 20 entries; `BenchEntrySchema` (`shared/src/bench.ts:56-78`) carries none of them. Mutation testing is deferred, not deleted — these fields return with it if it lands. |
| `Recall = Σ detected_i / Σ runs_i` with a CI on the pooled `n` | v1.1 §8 | Pseudo-replication: narrows the interval ~40% on a false independence assumption (§5.2). Replaced by entry-level `n` and the reliable/optimistic band. |
| "N=3 ⟹ Wilson CI ≈ [40%, 96%]" | v1.1 §12 | Not the Wilson interval for any coherent `n` — at n=3 it is [28.8%, 97.5%], at n=20 [58.4%, 91.9%]. Symptom of `n` never being defined. |
| "Precision" | v1.1 §6, §8 | The quantity defined is **specificity**. Precision depends on prevalence, which here is a corpus artifact (§5.3, B-6). Renamed; the ≥95% target is kept as a *specificity* target and priced at 73 clean entries. |
| Post-mutation load verification | v1.1 §7 | Its purpose is now an **engine invariant**, which is strictly better: a fixture that cannot load produces a module-resolution defer (`orchestrator.py:231,240-241`) and, absent a confirmation, an `AuditIncompleteError` (`pipeline.py:416-425`). "Doesn't load" is an observable `ABSTAINED`, not something the bench must pre-screen. |
| `bench.py` `_run_status` | `{"DANGEROUS": "detected", "SAFE": "missed"}` (`bench.py:132`) | A stored judgment — the exact F-G2 violation that killed v1 (§2.3). Delete with the module (G22). |
| `/bench/results` and its silent-empty behaviour | `bench.py:195-196`, `:206-207` | Reports "no data" for "cannot read this engine's reports". Replaced by `/bench/runs*` (design §5.3). |
| Temporal-slice recall as a standing metric | v1.1 §3 | n=2 at today's date (§6.3b). Retired until the corpus is refreshed on a schedule; reinstated the moment it is. |

**Retired from this document's own earlier draft**, because a benchmark that will
not correct itself has no standing to correct anyone else:

| Retired | Was | Why it goes |
|---|---|---|
| "`SAFE` implies full coverage … a *fully evaluated* false negative" | §3.2 invariant 2 | `graph.py:309-312,322-325` assert **dispatch** coverage — every hypothesis reached a terminal state — not **evidentiary** coverage. The pre-fix corpus falsifies the stronger reading: the IMDS probe is in **9 of 9** sealed artifacts and rendered in **3 of 9**, so eight of nine runs "came back clean" over evidence their own sandbox had captured. Replaced by §3.2.1 and B-12/B-13. |
| "10-entry N=5 **stability** probe … ρ / unanimity at a useful `m`" | §6.5, B-8 | Attributes sensor and render variance to the model, and ρ is the nuisance parameter §5.2 declined to estimate. The L2 pcap sensor fired in **3 of 9** near-identical runs of one file. Replaced by the variance-decomposition probe of §6.5.1 (B-14). |
| Implicitly treating any recorded audit as comparable to any other | throughout | `ced29f2` / `b1b0a43` / `67f830f` each changed what the engine can see. Pooling across them measures a moving instrument (B-13, §3.4.3). |

**Kept, deliberately and without rewriting:** v1.1 §1's four requirements for a
serious benchmark; §2's entire Datadog-vs-mutation argument and its three named
trade-offs; §3's `compromised_lib`/`malicious_intent` stratification and its
selection-bias note; §6's negative controls and the gameability argument that
justifies them; §8's Wilson formula and Wald rebuttal; §10's four reproducibility
identifiers and dataset immutability; §9's cost-and-latency reporting list; §12's
native-bindings and no-package-publish limitations; §13's deferral of mutation
testing to a later dataset version.

---

## 12. Changelog

- **v1.0** (2026-04-26): initial methodology centred on Security Mutation Testing.
- **v1.1** (2026-04-26): pivoted to Datadog replay as the primary v1 method;
  mutation testing moved to v2. Negative controls and post-mutation load
  verification preserved verbatim.
- **v2.0-draft** (2026-07-25): rebuilt the measurement layer against the
  schemaVersion-2 hypothesis-graph report. Retired the capability-subset and
  `TEST_CONFIRMED` primitives (both already vacuous on the pinned corpus, §2.2).
  New eight-value observation taxonomy with `CAUGHT_PROVED` /
  `CAUGHT_STRUCTURAL` / `ABSTAINED` / `VOID` (O-2, §4). Fixed the
  unit-of-analysis error: `n = entries`, replication spent on a
  reliable/optimistic band (§5.2). Renamed precision → specificity and priced
  v1's ≥95% bar at 73 clean entries (§5.3, §6.4). O-3 answered: expand to
  50 malware + 75 controls at **N=2**, because at fixed budget entries buy CI
  width and replication does not (§6.4, §6.5). Corrected the re-projection source
  to `audit_sessions.report` (§8.2) and required cache bypass per run index
  (§8.3). Costed the recommendation against real recorded token counts and found
  a DANGEROUS audit costs 7–24× a SAFE one, making negative controls the cheap
  half of the corpus (§7.3). Identified that one `modelId` cannot describe a run
  (§7.6). Statistics, corpus rationale, stratification, negative controls and
  reproducibility identifiers carried forward from v1.1 (§11).
- **v2.0-draft, rev. 2** (2026-07-25): corrected two claims of its own that
  changed what a published number *means*, both found by
  [`../docs/specs/2026-07-25-cross-hypothesis-coherence.md`](../docs/specs/2026-07-25-cross-hypothesis-coherence.md).
  **(1)** "`SAFE` implies full coverage" was false: the code asserts **dispatch**
  coverage, not **evidentiary** coverage, so a miss may not be captioned "fully
  evaluated" (§3.2.1). Render fidelity and sensor capture therefore become
  first-class per-run observations from a third, artifact-level tier (§3.4, B-12),
  and observations may not be pooled across a fidelity-fix `engineSha` boundary
  (§3.4.3, B-13). **(2)** The N=5 probe attributed sensor and render variance to the
  model; it survives re-scoped as a variance-*decomposition* probe, selected after
  the main run and reporting a decomposition rather than a unanimity rate (§6.5.1,
  B-14) — D-7's entries-vs-replication reasoning is untouched and remains correct.
  Also folded in what the bench records for the judge's forthcoming third answer,
  including the undecidable rate as a **model-tier disqualifier** feeding O-7
  (§4.5.1, B-15), extending D-6's 8-value taxonomy rather than replacing it. All
  corpus figures re-measured against the committed artifacts on today's parser and
  renderer, and labelled pre-fix or current throughout; stale `graph.py` /
  `pipeline.py` / `orchestrator.py` line citations refreshed against the working
  tree.
- _(planned)_ **v2.1**: comparative wrappers for `npm audit` and Snyk CLI on the
  same corpus.
- _(planned)_ **v3.0**: stratified mutation testing, contingent on an
  independent attack-class labelling of the corpus (§4.6).

---

## 13. References

- E.B. Wilson, "Probable Inference, the Law of Succession, and Statistical
  Inference," _JASA_, 1927. _(v1.1 attributes this to "D.S. Wilson"; the Wilson
  score interval is E.B. Wilson. Corrected.)_
- Y. Jia & M. Harman, "An Analysis and Survey of the Development of Mutation
  Testing," _IEEE TSE_, 2011.
- Datadog Security Labs, _Malicious Software Packages Dataset_,
  https://github.com/DataDog/malicious-software-packages-dataset
- SAP Security Research, _Risk Explorer for Software Supply Chains_,
  https://github.com/SAP/risk-explorer-for-software-supply-chains
- MITRE, _Software Supply Chain Compromise (T1195)_,
  https://attack.mitre.org/techniques/T1195/

---

## Open — needs a human decision

Each item states what I could not settle from evidence, and what evidence would
settle it.

**1. The price basis — which model tier is the benchmark run on?**
This is the only thing standing between §7.3's token model and a defensible
`$/audit`, and it is a *decision*, not a measurement. Real token counts exist
(§7.3); dollars do not, because the primary model specs carry no prices
(`llm_runtime.py:104-112`) and the non-OpenRouter adapter never reports native
cost (`provider.py:283-284`), so `cost_usd` is NULL under the default backend
(§7.5). The consequence is a **33× spread** in the cost of the same run (≈$8 vs
≈$262, §7.3c).
There is also a quality constraint pulling the other way: this project has already
observed a cheap model returning false-SAFE on textbook exfiltration, so the
cheapest tier may not be an eligible configuration for a *detection* benchmark
regardless of price.
*Settled by:* naming the model configuration the published benchmark runs on,
then setting `ModelSpec.prices` for those slugs (or running on OpenRouter) and
storing a dated price snapshot per run. After that, one N=1 calibration pass over
the current 20 entries confirms §7.3's token model on real fixtures.
**This is the single cheapest unblocking action in this document.**

**2. Who assigns an independent attack-class label, if per-class recall is
wanted?**
`claim.kind` cannot do it (§4.6). Options, ordered by credibility:
(a) manual triage of each entry by a human reading the fixture — highest quality,
~50 entries × ~15 min; (b) an LLM-as-judge classifier run *separately from the
auditor*, with a different model and prompt, published with its own agreement
statistics against a human-labelled subset; (c) borrow labels from a third-party
source if one publishes per-sample classes.
*Settled by:* a decision on whether per-class recall is a product requirement at
all. It is not needed for the headline, and v1 already deferred it.

**3. Is the `DANGEROUS ⟺ CONFIRMED hypothesis` comment
(`shared/src/models.ts:7-8`) wrong, or is the dealbreaker path?**
The code has two DANGEROUS producers (§3.2, §4.4); the comment asserts one. I
assume the comment is stale and the dealbreaker is intended, because it is
deliberate, tested-looking code with an explicit early return. But this is an
engine/contract question and a wrong assumption here mis-shapes `CAUGHT_STRUCTURAL`.
*Settled by:* the engine owner confirming the dealbreaker is intended, and the
comment being corrected to name both producers.

**4. Is a phase timeout (`NPMGUARD-0030`) an abstention or a void?**
I classified it `ABSTAINED` on the grounds that the budgets are the engine's own
configured behaviour (§4.5). A reviewer could reasonably argue a timeout caused
by a slow LLM provider is environmental. The published error-code breakdown makes
either reading recoverable, so this is a default, not a lock-in.
*Settled by:* observed timeout causes from a real run — if timeouts cluster on
provider latency rather than on large inputs, reclassify.

**5. Negative-control corpus size: 40 (affordable) or 75 (clears v1.1's own ≥95%
bar)?**
A credibility decision more than a cost one, now that §7.3(b) shows clean
packages are the cheap half of the corpus and the 165-package watchlist makes
selection free. The remaining unknown is the cost of a *large* popular package —
none of the four recorded audits is one, so the flag-phase cost at
`triage_max_files = 80` (`config.py:51`) is unmeasured.
*Settled by:* auditing ~5 large watchlist packages (e.g. `webpack`,
`@babel/core`) to price the upper end, plus a decision on whether "FP ≤ 8.8%" is
publishable or whether the ≥95% claim is required.

**6. Does the temporal-slice metric get a corpus-refresh cadence, or is it
retired?**
At n=2 it is unusable today (§6.3b). Keeping it requires re-cutting the corpus
from recent Datadog samples on a schedule, which means a new `datasetVersion`
each time and therefore breaks longitudinal comparison against older runs.
*Settled by:* a product decision on whether "performance on attacks too recent to
have been memorised" is a claim NpmGuard wants to make. If yes, the corpus needs
a rolling recent stratum *plus* a frozen stratum, and the report must not mix them.

**7. Is there a retention policy on `audit_sessions`?**
I found no pruning code, but I did not exhaustively search for an ops job or a
migration that trims it. If one exists, bench runs need an exemption or G24 quietly
becomes false over time (§8.2).
*Settled by:* a grep of deploy/ops tooling for session pruning, plus an explicit
retention statement.

**8. Should `BenchRunSchema.modelId` become a set of observed `(role,
actual_model)` pairs?**
A single `modelId` cannot describe a run that splits roles across two configured
models and carries a fallback tail per role (§7.6). I am confident the single
string is insufficient; I am **not** confident about the right replacement shape,
and it is a contract change that touches a schema Phase 0 has already authored.
Candidates: keep `modelId` as the declared investigation model and add an observed
`models: {role, model}[]`; or replace it with the observed set and derive a display
label. The data to populate either already exists as
`llm_attempts.actual_model`.
*Settled by:* a contract-owner decision, ideally taken together with item 1 since
both are about pinning what actually ran. Worth doing **before** the runner is
written — retrofitting it means re-cutting stored runs, which is the class of
mistake this whole document exists to avoid.

**9. Does the judge get its third answer before the benchmark publishes anything?**
This is the item with the largest effect on what a published detection rate means,
and it is not a bench decision. §3.2.1 shows that `SAFE` cannot mean "every judge
had what it needed" while `JudgeVerdict.malicious` is a `bool`, so **every rate
published before that change carries the weaker guarantee** — and the caption has to
say so. Against that: the change reclassifies an unknown fraction of today's
refutations into `DEFERRED`, which moves specificity as well as detection (§4.5.1
rule 3), and it edits the judge prompt, which per N-5 fails every recorded exchange
loud. **A re-record is an owner decision with a dollar attached, never an agent's.**
*Settled by:* an owner decision on the sequence. Two coherent orders exist and the
choice is not obvious — (a) publish now at the weaker guarantee, clearly captioned,
and re-baseline later; or (b) land the render-fidelity assertion, then the third
judge answer, measure the reclassification delta on the corpus, and publish once at
the stronger guarantee. This document's own preference is **(b)**, because a
re-baselined headline invites the "which number is real?" question that no
methodology section can answer afterwards — but (a) is defensible if a number is
needed before the re-record can be funded.

**10. Is a run whose fidelity counts are non-zero publishable at all, and where is
the line?**
§4.5 sets a hard gate on `VOID > 5%`. There is no equivalent gate on evidentiary
coverage, and I could not settle where it belongs from evidence. The two ends are
both wrong: refusing to publish until fidelity defects are zero makes publication
hostage to an AF_UNIX rendering nit (§3.4.2 reading 2), while publishing at any
fidelity makes the coverage caption decorative. Note the asymmetry that makes this
hard — a fidelity defect biases toward **false negatives**, so a non-zero count
means the *detection* rate is understated and the *specificity* rate is, if
anything, flattered. A single threshold across both rates is therefore probably
wrong.
*Settled by:* one full run's observed distribution of fidelity counts. Until then
the coverage counts are **published beside every rate and gate nothing**, which is
the conservative choice: a reader can apply their own threshold, and none of the
data needed to set one later is lost.
