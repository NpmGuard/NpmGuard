# Spec — Execution Timeline + Evidence Judge (v2 evidence-layer rewrite)

_Status: proposed · 2026-07-08 · engine v2 · branch `engine-v2-cutover`_

This is a **from-scratch rewrite of the evidence layer** to be basic, clean, and working — the
foundation we finetune later. It builds exactly the six steps of the reimagined pipeline and adds
nothing else. No capability matching, no action taxonomy, no category gates, no preflight checks.
Those are finetuning; 90% of the time they are ducttape and a sign the core was weak. We are making
the core great first.

## Goal

Replace the hand-written `confirm(artifact)` predicate booleans in
`engine/src/orchestrator/experimenter.ts` with two pieces:

1. `renderTimeline(artifact)` → a **readable, chronological, layer-tagged execution trace** of what
   the package actually did — the run turned into a whitebox the model can read.
2. `judgeEvidence(hypothesis, timeline)` → an LLM that reads the hypothesis against that timeline and
   decides whether it fired, citing the timeline lines that prove it.

Delete every `eventsContain*` predicate and helper. The judge is the only decision-maker.

## The six steps this implements

Steps 1–3 already exist and are untouched:

1. **Expected purpose baseline** — `intent-extraction.ts` (stated purpose + claims). Passed to the judge
   as the benign baseline.
2. **Suspicious-part analysis** — `triage.ts`. (Obfuscation / geo-gate / time-gate / anti-parsing
   suspicion are prompt guidelines there, not steps.)
3. **Hypotheses** — the graph nodes triage emits.

This spec is steps 4–6:

4. **Run under the oracle, made readable.** The sandbox already runs the package and captures sensor
   events. We render those events into a human/LLM-readable timeline: readable syscalls + Node calls +
   network + filesystem, in chronological order. Modeled on the vimx bench timelines
   (`/home/wookie/zen/ventures/vimx/bench/timeline.py`), adapted to the npmguard domain.
5. **File as evidence; match hypothesis ↔ evidence.** The judge reads (hypothesis, timeline) and points
   at the specific timeline lines that back its call.
6. **Deem malicious; output the tuple.** For each confirmed hypothesis:
   _(the suspicious code, the hypothesis, the setup/what was run, the evidence/log lines of what it did)_.

## Why a readable timeline replaces the predicates (the core bet)

The predicate bug (`8af78a7`): `persistence` confirmed on **any** `write()` syscall, including the
instrumentation's own `write(1, …)` to stdout, so clean packages were flagged DANGEROUS.

We do **not** add a guard against that case. We make the timeline genuinely readable: a write to stdout
renders as `write stdout`; a write to a file renders as `write ~/.config/svc.json`. A model reading that
will not call a stdout write "persistence" — the same way a human researcher wouldn't. **One general
mechanism (readable rendering) replaces N special-cased predicates.** If the timeline were not readable
enough for the model to tell those apart, that is a rendering bug to fix, not a predicate to add.

## What the sensors give, and the one bit of rendering intelligence

| Layer | Yields | Already readable? |
|---|---|---|
| **L1** strace | `execve`(+argv), `connect`(ip:port), `openat`(path), `unlink`/`rename`(paths) | Yes — carries targets. |
| **L1** strace | `read`/`write` | **No — only an fd.** This is the one thing rendering must resolve. |
| **L2** pcap | `dns_query` / `http_request` / `tls_sni` (host) | Yes. |
| **L3** fsDiff | `file_created` / `file_modified` / `file_deleted` (path) | Yes. |
| **L4** monkey | `require`, `fs_op`(path), `network`(url), `process`(cmd), `env_access`, `eval`, `crypto`, `timer` | Yes — the semantic layer. |

The only rendering work is **fd resolution**: walk L1 in order, bind `fd → target` on `openat`/`connect`
(the fd is in the syscall return), and look it up at the matching `read`/`write`. So `write(5,…)` after
`openat("~/.npmrc")=5` renders `write ~/.npmrc`; `write(1,…)` renders `write stdout`. That single
mechanism is what makes syscalls read like sentences — and it is what makes the false positive
impossible without any predicate. Everything else already carries a readable target.

_(Note: L1/L2 have real timestamps, L3 is mtime-coarse, L4's timestamp is a logical index. We sort by the
event's existing `timestamp` field for a best-effort merged order and say so in the header. We do not try
to reconcile the clocks — that is not needed for the judge to read the narrative.)_

## Timeline format

One line per event, tagged by layer, chronological, each with a stable id the judge can cite. Header
states the trigger + setup so the reader knows what environment produced the run.

```
# Execution timeline — run_a1b2… · trigger=entrypoint:scripts/postinstall.js
# setup: env NPM_TOKEN=<canary>, planted /home/node/.npmrc
# order is best-effort across sensors.

e1   t+0.02s  [L4] require   child_process
e2   t+0.06s  [L1] execve    /usr/bin/node ["node","postinstall.js"]
e3   t+0.31s  [L4] read      ~/.npmrc                (readFileSync)
e4   t+0.40s  [L2] dns       api.telemetry-stats.example
e5   t+0.41s  [L1] connect   45.79.12.8:443
e6   t+0.44s  [L4] net send  POST https://api.telemetry-stats.example/collect
e7   t+0.51s  [L3] write     ~/.config/systemd/user/cache.service   (new)
e8   t+0.52s  [L4] spawn     systemctl --user enable cache.service
```

Rendering is plain formatting: map each event to `id · t+Ns · [layer] · verb · target`, resolving fds as
above, truncating long targets. No tags, no classification, no per-claim logic.

## The judge

`engine/src/orchestrator/judge.ts`, mirroring the existing `code-reader.ts` shape (`generateObject` +
Zod). One call per run (the orchestrator dispatch loop is untouched — we swap only `confirm`).

```ts
export const JudgeVerdict = z.object({
  malicious: z.boolean(),
  reason: z.string(),
  citedEvents: z.array(z.string()).default([]),  // timeline ids that prove it
});
```

System prompt (short): you are judging **one** hypothesis against **one** run's readable timeline; the
package's stated purpose is the benign baseline; decide whether the suspected behavior actually happened;
if malicious, cite the timeline ids that show it.

Confirmation mapping:

```
confirmed = malicious && citedEvents.length > 0 && citedEvents.every(id => timeline.has(id))
```

That is the whole guard — the judge must point at real log lines (step 5: match hypothesis ↔ evidence).
No confidence tiers, no category matching. The orchestrator's surrounding logic (persist artifact,
`observationFailed` → DEFERRED, else INCONCLUSIVE) is unchanged, so error runs still DEFER as today.

## Output tuple (step 6)

Assembled in the orchestrator from what already exists and persisted with the finding:

| tuple field | source |
|---|---|
| the suspicious code | `hypothesis.focusFiles` / `focusLines` |
| the hypothesis | `hypothesis.claim` + `description` |
| setup / what was run | `RunArtifact.triggerUsed` + `setupApplied` |
| evidence / logs | the rendered timeline + `citedEvents` |

## Changes

| file | change |
|---|---|
| `engine/src/evidence/timeline.ts` | **NEW.** `renderTimeline(artifact): { text, ids }`. fd resolution, merged-order rendering, stable ids. `ids` is the set of emitted ids for the citation check. |
| `engine/src/evidence/timeline.test.ts` | **NEW.** |
| `engine/src/orchestrator/judge.ts` | **NEW.** `JudgeVerdict` schema, `judgeEvidence`, confirm mapping, prompt. |
| `engine/src/orchestrator/judge.test.ts` | **NEW.** |
| `engine/src/orchestrator/experimenter.ts` | **EDIT.** Delete all `eventsContain*`, `FS_WRITE_METHODS`, `fsOpMethod`, `PLANTED_TOKEN` scan, `ConfirmationCheck`, and every `strategy.confirm`. `runExperiment`: run → `renderTimeline` → `judgeEvidence` → `ExperimentResult` (+`citedEvents`). `strategyForClaim` keeps trigger/setup/observe/budget (they define *how* to run); `claimHasDynamicStrategy` unchanged. |
| `engine/src/orchestrator/orchestrator.ts` | **EDIT (small).** Persist the timeline via `log.writeLog(\`timeline-${hypId}.md\`, timeline)`; add `citedEvents` to the existing `experiment-${hypId}.json`. Transition logic unchanged. |
| `engine/src/orchestrator/experimenter.test.ts` | **EDIT.** Drop predicate assertions; assert run→render→judge wiring with a stubbed judge. |

No shared-schema change: `citedEvents` rides in the experiment log; the timeline persists as an
audit-log file, retrievable via the existing `/audit/:id/file` route (for the inquisitive — it is a
secondary deliverable, not a headline).

## Decisions

| Decision | Choice |
|---|---|
| Fate of predicates | **Delete them all.** The judge reading a readable timeline is the sole decision-maker. |
| Judge scope | **One judge per run.** Swap only `confirm(artifact)` → `judgeEvidence(hyp, timeline)`; loop untouched. |
| Citation check | **Exist-only.** A malicious verdict must cite ≥1 real timeline id. No category/capability matching, no taxonomy. |
| Rendering | **Resolve fds so syscalls read as sentences.** This is the one general mechanism; it removes the whole predicate false-positive class. |
| Layers / evasion | **Assume all layers true.** No trust hierarchy, no integrity status, no evasion detection — deferred. |
| Timeline | **Persisted, secondary.** Retrievable, not surfaced by default. |

## Deferred — do NOT build in this vertical

The core must land clean before any of this. All of it is finetuning, and each item should be added only
if the core proves it necessary, never by default:

- **Evasion / anti-analysis** — static anti-instrumentation detection in triage, runtime correlate-gap
  checks, observation-integrity status, layer trust hierarchy. (We have the source; the strongest evasion
  signal is static and belongs in triage, not here.)
- **Any judge scaffolding** — confidence tiers, capability/category matching, per-claim evidence tables,
  pre-gates that skip the judge. These are the ducttape we are explicitly refusing until the readable-
  timeline core is shown to be insufficient on its own.
- **Hypothesis-driven environment setup tooling** and the recursion/child-graph path.

## Principle applied post-build: fail cleanly, don't mask LLM failures with ifology

Example (triage, `phases/triage.ts`): the old code masked an unreliable LLM two ways —
`synthesizeSummaryFallback` regex-scraped the prose `summary` into a fabricated hypothesis when
the model returned empty structured `hypotheses`, and the MAP-failed catch fabricated a generic
`obfuscation` finding when `generateObject` threw. Both dressed a model failure as a security
finding. Removed both. Now: the success path **trusts** the model's structured output; a thrown
call is **logged loudly** (`[triage:map] ANALYSIS FAILED …`) and recorded as an explicit
`TriageOutput.analysisFailures` entry. The pipeline's `withCoverageGap` guard turns that into an
honest verdict — a clean SAFE is **downgraded to UNKNOWN** when any file went unanalyzed, so a
coverage gap is loud, never a silent false-SAFE and never a fake finding. `deriveGraphVerdict`
stays pure (graph-only); coverage completeness is the pipeline's concern.

Invariant enforced (not a trade-off): **suspicious ⟹ a hypothesis exists.** A response whose
`summary` describes a risk but carries zero hypotheses is an *incoherent* state — there is nothing
to check — so it is neither trusted as "no finding" nor fabricated into one: it is flagged as an
error (thrown → recorded as an `analysisFailure` coverage gap → UNKNOWN). This is the general
principle at work: an invariant makes the code simpler because every stage can state what is true
by the time it runs. If a stage can't claim anything, the state is wrong and the only honest moves
are error or retry — for now we error, and revisit if real models trip it.

## Known follow-ups surfaced by the build (sensor-level, not the renderer)

- **L4 harness-require noise.** `sandbox/instrumentation.ts` installs its `Module._resolveFilename` hook
  before requiring its own deps (fs/http/https/child_process/crypto), so those appear as `require` events
  at the head of every timeline, attributed to the package. Identical baseline noise on every run, harmless
  (no matching fs/net/process event follows, so nothing confirms on it), but cosmetically misleading. The
  renderer shows it faithfully — the fix is in the instrument (install the hook last, or drop events whose
  `from` is the instrument), not a filter in `timeline.ts`. Marked at the site with `NOTE(timeline-noise)`.

## Tests

_Renderer:_
1. `write` to an fd previously `openat`'d to a file → line reads `write <path>`.
2. `write` to fd 1 → line reads `write stdout` (the `8af78a7` case, fixed by rendering, not a predicate).
3. `write`/`sendto` on an fd previously `connect`'d → line shows the socket, not a path.
4. Events from all four layers merge into non-decreasing `t+` order with contiguous ids `e1..eN`.
5. An unresolved fd (no prior openat/connect) → target `fd:N`; the event is still rendered, never dropped.

_Judge (model stubbed):_
6. `malicious=true` with ≥1 cited real id → `confirmed=true`.
7. `malicious=true` with `citedEvents=[]` → `confirmed=false`.
8. `malicious=true` citing an id absent from the timeline → `confirmed=false`.
9. `malicious=false` → `confirmed=false`.

_Integration:_
10. `runExperiment` runs → renders → judges and returns an `ExperimentResult` with `citedEvents` and the
    `evidenceRef`; no `confirm` predicate is invoked (they no longer exist).
11. A run ending in `SensorError` still flows through the judge; the orchestrator's `observationFailed`
    branch DEFERs it (surrounding logic intact).
```
