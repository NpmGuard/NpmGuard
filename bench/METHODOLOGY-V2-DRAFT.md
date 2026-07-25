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
| **B-8** | **O-3: expand the corpus and drop N from 3 to 2.** At a fixed audit budget, entries buy CI width and replication does not. Target 50 malware + 75 negative controls at N=2, plus a 10-entry N=5 stability probe. Minimum publishable tier is 40 + 40 at N=2. | §6.5 |
| **B-9** | The per-`auditId` report for re-projection is `audit_sessions.report` in the database, **not** `data/reports/<pkg>/<version>.json` — the on-disk path keeps only the last of N repeat audits. | §8.2 |
| **B-10** | The bench lane must force a fresh audit per run index. A cache hit is not an observation. | §8.3 |
| **B-11** | A single `modelId` cannot describe a run — the engine splits roles across two configured models plus a fallback tail. The reproducibility identifier must be the *observed* set of `(role, actual_model)` pairs. | §7.6 |

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
   least one `evidenceRef` (`engine/npmguard/graph.py:170-173`).
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

### 3.2 Four engine invariants the scoring rule can lean on

These are not stylistic facts; they are asserted in code, and they are what let
the taxonomy be exhaustive rather than defensive.

1. **`DANGEROUS` has exactly two producers.** Either
   `derive_graph_verdict` found `counts.confirmed > 0`
   (`engine/npmguard/graph.py:269-276`), or the inventory dealbreaker
   short-circuited the pipeline (`engine/npmguard/pipeline.py:249-262`). There is
   no third path.
2. **`SAFE` implies full coverage.** `derive_graph_verdict` raises
   `AssertionError` on `SAFE` with any `DEFERRED` node
   (`graph.py:277-280`) and on any unresolved `OPEN`/`IN_PROGRESS` node
   (`graph.py:264-267`). So a `SAFE` verdict on known malware is a *fully
   evaluated* false negative — every suspicion the engine raised was run and
   came back clean. That is a much stronger statement than "the scanner didn't
   flag it", and §4.2 relies on it.
3. **"Couldn't check" cannot become a verdict.** If any hypothesis is `DEFERRED`
   and none is `CONFIRMED`, the pipeline raises `AuditIncompleteError`
   (`pipeline.py:390-398`) — there is **no report at all**. The verdict domain is
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
3 and `pipeline.py:390-398`. And the bucket must be split by cause, because
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
| **`MISSED`** | `expected=DANGEROUS ∧ v=SAFE` | Fully evaluated false negative (§3.2 inv. 2). |
| **`CLEARED`** | `expected=SAFE ∧ v=SAFE` | Correct clean verdict on a negative control. |
| **`FALSE_ALARM_PROVED`** | `expected=SAFE ∧ v=DANGEROUS ∧ ec ≥ 1` | The judge cited dynamic evidence of malice in a benign package. The most serious failure mode in the taxonomy. |
| **`FALSE_ALARM_STRUCTURAL`** | `expected=SAFE ∧ v=DANGEROUS ∧ ec = 0 ∧ db ≠ null` | A dealbreaker heuristic fired on a benign package. |
| **`ABSTAINED`** | `v = null ∧ cause is engine-capability` (§4.5) | The audit could not conclude, and that is a fact about the tool. |
| **`VOID`** | `v = null ∧ cause is harness/infra/corpus` (§4.5) | The observation failed to be made. Excluded from every rate; counted and named. |

**Three forbidden states become projector assertions**, per the delete-iff-asserted
discipline. Each is unreachable given §3.2, so the projector must fail loud
rather than branch:

```
assert not (v == "DANGEROUS" and ec == 0 and db is None)   # graph.py:269-276 + pipeline.py:249-262 are the only DANGEROUS producers
assert not (v == "SAFE" and ec > 0)                        # graph.py:269-276: confirmed > 0 ⟹ DANGEROUS
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
`hypotheses=[]` (`pipeline.py:249-262`, `EMPTY_COUNTS` at `pipeline.py:40`).
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
verdict (`pipeline.py:390-398`, `graph.py:277-280`, and the orchestrator's four
defer paths at `orchestrator.py:232-247`, `:257-271`, `:272-283`, `:284-303`).
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
  tool".
- **Flip list** — every `*_SOMETIMES` entry, by name, with its per-run outcomes.
  Short, concrete, and the first thing a skeptic should be shown.
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
| Stability probe (5 malware + 5 control, fixed) | 10 | 5 | +30 | ρ / unanimity at a useful `m` |
| **Total per full run** | **125** | — | **≈280** | |

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
are: (1) drop to the 40+40 minimum tier; (2) trim the stability probe; (3) trim
negative controls — reluctantly, since §7.3(b) shows they are the cheap half.
**Never trade entries for higher N** — higher N actively worsens the number being
published (§6.4).

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
  `investigation_model` (`llm_runtime.py:157-209`). Defaults are
  `claude-haiku-4-5-20251001` and `claude-sonnet-4-6`
  (`config.py:50`, `:52`).
- Every role additionally carries a **cross-provider fallback tail**
  (`llm_runtime.py:62-73`, `_fallback_specs` at `:76-93`), so one logical phase
  can bill on several models within a single audit.
- The repo contains **three disagreeing sources of truth** about what actually
  runs: the `config.py` defaults above; `engine/.env.template:6-10`
  (OpenRouter, `deepseek/deepseek-v3.2` + `z-ai/glm-5`); and the recorded
  production traffic (`deepseek/deepseek-v4-flash`, `google/gemini-2.5-flash`).

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
4. **Mandatory companions to the detection tile:** `dealbreaker_share` (§4.4) and
   the `VOID` count with causes (§4.5). Detection without dealbreaker share is
   uninterpretable; any rate without the void count is unverified.
5. If `VOID > 5%` of attempted observations, the page renders "run not
   publishable — N voided observations" **instead of** rates (§4.5).
6. Empty corpus renders an explicit "no corpus", never "0%" (N-14).

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
  cannot estimate a per-entry catch probability. The N=5 stability probe (§6.5)
  exists to partially offset this, on 10 entries only.
- **The engine's SAFE-implies-full-coverage invariant is doing real work in
  §4.2**, and the strength of the `MISSED` claim depends on it holding. It is
  asserted (`graph.py:277-280`), which is why it is trustworthy — but a change to
  that assertion changes what a published miss means.

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
| Post-mutation load verification | v1.1 §7 | Its purpose is now an **engine invariant**, which is strictly better: a fixture that cannot load produces a module-resolution defer (`orchestrator.py:227-231,240-241`) and, absent a confirmation, an `AuditIncompleteError` (`pipeline.py:390-398`). "Doesn't load" is an observable `ABSTAINED`, not something the bench must pre-screen. |
| `bench.py` `_run_status` | `{"DANGEROUS": "detected", "SAFE": "missed"}` (`bench.py:132`) | A stored judgment — the exact F-G2 violation that killed v1 (§2.3). Delete with the module (G22). |
| `/bench/results` and its silent-empty behaviour | `bench.py:195-196`, `:206-207` | Reports "no data" for "cannot read this engine's reports". Replaced by `/bench/runs*` (design §5.3). |
| Temporal-slice recall as a standing metric | v1.1 §3 | n=2 at today's date (§6.3b). Retired until the corpus is refreshed on a schedule; reinstated the moment it is. |

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
