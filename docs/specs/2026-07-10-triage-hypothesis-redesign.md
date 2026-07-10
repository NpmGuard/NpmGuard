# Spec — Triage vertical redesign: FLAG → HYPOTHESIZE → RUN+JUDGE

_Status: proposed · 2026-07-10 · brainstormed + approved · builds on 2026-07-08-evidence-timeline-judge_

Rewrite the detection front-end so the LLM does the understanding and the code holds invariants — no
hand-coded taxonomy, per-category strategy tables, static clearing, or coverage-gap verdicts. Same job,
far simpler system.

## Founding rule (everything below obeys it)

> A suspicion is cleared only by evidence from **running** it — never by a model **reading** it and
> calling it fine. This is why there is no "dismiss," why the judge can only *confirm*, and why SAFE
> means "we tried to make it misbehave and it didn't," never "a model looked and shrugged."

## Goal

Replace the single per-file MAP (read + flag + hypothesize + hand-mapped strategy) with a two-tier
pipeline: a **cheap, high-recall FLAG** pass over all files, then a **smart HYPOTHESIZE** pass over
flagged regions that emits a hypothesis carrying its own **experiment as tool calls**, run under a
**full oracle** and resolved by the judge. Verdict space collapses to **{SAFE, DANGEROUS}**; an audit
that can't complete is an **ERROR** (retry/fix the tool), not a verdict. **Out of scope:** browser/
registry threats (deferred e2e web sandbox); validation retries; line-level execution coverage; a
partial-evidence `SUSPICIOUS` verdict (deferred until real runs demand it).

## Architecture

```
  FLAG  (cheap model · reads WHOLE files · high recall / overzealous)
  ┌────────────────────────────────────────────────────────────────────┐
  │ every file + structural facts (checks.ts) + intent  ──▶  FLAGS      │
  │ point at (a) anything BEYOND the intent, AND                        │
  │          (b) intrinsically-suspicious shape regardless of intent —  │
  │              obfuscation, eval, hidden URLs, and GATES              │
  │              (time / geo / CI / anti-debug)                         │
  │ FLAG = { file, lines, one-line why }   (thin; over-flagging is fine)│
  └────────────────────────────────────────────────────────────────────┘
                                   │ flags
                                   ▼
  HYPOTHESIZE  (smart model · flagged regions only · precision)
  ┌────────────────────────────────────────────────────────────────────┐
  │ flag + flagged code + intent  ──▶  HYPOTHESIS                       │
  │   { description, focusLines, experiment: ToolCall[] }               │
  │ the experiment is designed to MAKE THE PAYLOAD FIRE — incl.         │
  │ defeating any gate FLAG spotted (advance clock, CI=true, spoof geo).│
  │ NO benign-dismiss branch. If it genuinely cannot form a testable    │
  │ experiment → that is an ERROR (retry), never a silent "benign".     │
  └────────────────────────────────────────────────────────────────────┘
                                   │ hypotheses (deduped by description, keep-first)
                                   ▼
  RUN under the FULL ORACLE  →  TIMELINE  →  JUDGE
  ┌────────────────────────────────────────────────────────────────────┐
  │ apply experiment tool calls → run trigger → ALL sensors on:         │
  │   L1 syscall · L2 net · L3 fs-diff · L4 node · V8 inspector         │
  │ JUDGE(description + timeline + intent) → CONFIRMED (cited) | not     │
  └────────────────────────────────────────────────────────────────────┘

  VERDICT  (only for a COMPLETED audit)
    any CONFIRMED (cited dynamic proof)                → DANGEROUS
    else, some hypothesis couldn't be evaluated (tool) → ERROR   (retry/fix — NOT a verdict)
    else (ran, genuinely tried to trigger, no malice)  → SAFE    (presumption of innocence)
```

## The shared tool registry (the contract that makes this work)

One registry, `sandbox/tools.ts`: each tool = `{ name, description, paramSchema (Zod), execute() }`,
wrapping the existing `manipulation/` primitives + triggers. **Both** the HYPOTHESIZE prompt (renders
the tool list for the model) **and** the sandbox executor read from it — one source of truth, no drift.
A `ToolCall` is `{ tool, args }` validated against the tool's `paramSchema`. Starter tools: `plantFiles`,
`setEnv`, `setDate`, `stubUrl`, `patchFile`, `preload`, `trigger(kind, target)`. New tools come from
analyzing logged audits (data-driven), not an in-flight escape hatch.

## Verdict model (the collapse)

`SAFE` and `DANGEROUS` are the only verdicts. "We couldn't check" is **not a property of the package** —
it's a transient **tool failure**, so it's an `ERROR` that triggers retry/fix, never a reported verdict.
This protects `SAFE` better than a middle state did: a non-check can't leak out as a result, because we
refuse to issue any verdict until the audit completes.

```
  any hypothesis CONFIRMED                         → DANGEROUS
  else any hypothesis unevaluated (machinery broke,
       structured-output failed, sensor/timeout)   → ERROR   (retry; if exhausted, surface to fix the tool)
  else                                             → SAFE
```

Invariants:
- **V1** — a verdict is issued ONLY for a completed audit; an incomplete audit is an `ERROR` (retry), never a verdict.
- **V2** — `SAFE` ⟺ the audit ran a genuine triggering experiment and the judge found no malice (SAFE is always backed by an *attempt*, never a default).
- **V3** — `DANGEROUS` ⟺ the judge confirmed malice from cited dynamic evidence.
- **Corollary** — "we didn't look" is unrepresentable as a verdict; not-looking yields an `ERROR`.

## Changes

| file | change |
|---|---|
| `shared/src/graph.ts` | **Hypothesis schema:** drop `claim` as a dispatch field; add `experiment: ToolCall[]`. Keep `focusFiles/focusLines/description/severity`. Optional derived `category: string` (display label only — nothing branches on it). |
| `shared/src/evidence.ts` | Add `ToolCall`. `ObserveFlags` becomes vestigial (full oracle always) — delete or default all-on. |
| `shared/src/models.ts` (VerdictEnum) | Collapse to **`{ SAFE, DANGEROUS }`**. Remove `SUSPECT`, `UNKNOWN`. |
| `engine/src/sandbox/tools.ts` | **NEW.** Tool registry (name + Zod param schema + executor over `manipulation/`). |
| `engine/src/phases/flag.ts` | **NEW (from triage.ts).** Cheap per-file FLAG: whole file + structural facts + intent → thin flags on intent-mismatch AND intrinsic-suspicion (incl. gates). High recall. |
| `engine/src/phases/hypothesize.ts` | **NEW.** Smart pass over flagged regions → hypothesis-with-experiment (tool calls, designed to defeat gates). No dismissal. |
| `engine/src/inventory/checks.ts` | Keep dealbreakers + structural facts; **drop content-pattern flags** (encoded/unusual-ext/minified — the reader sees those). |
| `engine/src/orchestrator/experimenter.ts` | **Gut.** Delete `strategyForClaim`, `claimHasDynamicStrategy`, `pickTriggerTarget`. `runExperiment`: execute `hypothesis.experiment` under the full oracle → render → judge. |
| `engine/src/orchestrator/orchestrator.ts` | Delete dynamic/static routing + `dispatchStatic`. One dispatch path. A hypothesis that can't be evaluated → the audit is an `ERROR` (retryable), not `DEFERRED`/`UNKNOWN`. |
| `engine/src/orchestrator/code-reader.ts` | **DELETE** (no static route; no static clearing). |
| `engine/src/orchestrator/verdict.ts` | Rewrite to the V1–V3 rules: confirmed → DANGEROUS; unevaluated → ERROR; else SAFE. |
| `engine/src/evidence/run-under-observation.ts` | Full oracle always (all sensors on); accept a `ToolCall[]` experiment. |
| `engine/src/pipeline.ts` | Wire flag → hypothesize → graph → orchestrator; return a report (SAFE/DANGEROUS) or raise a retryable audit-`ERROR`. |
| tests across the above | Update; delete code-reader tests; verdict tests to the new rules. |

## User-confirmed decisions

| decision | choice |
|---|---|
| Founding rule | Clear suspicions only by running; no static clearing anywhere. |
| FLAG lens | **Two lenses:** beyond-intent AND intrinsically-suspicious (obfuscation/eval/hidden-URLs/**gates**). Overzealous by design (recall). |
| Experiment | **Tool calls** the LLM composes from a shared registry; deterministic outcomes; lives in the hypothesis; designed to *defeat gates* FLAG spotted. No escape hatch (tools found via logged-audit analysis). |
| Dismissal | **Removed.** No benign-dismiss; every flag becomes a hypothesis and is resolved dynamically. |
| Sensors | **Full oracle, every run.** Inspector included (anti-debug is signal; compute ≪ LLM cost). |
| Resolution paths | **One** — run + judge. Code-reader deleted. |
| `claim.kind` | Dies as control flow; survives only as an optional derived display label. |
| Inventory flags | Keep dealbreakers + structural facts; drop content-pattern flags. |
| Dedup | Keep-first fuzzy on description; near-duplicates are the same hypothesis. |
| Two-tier split | FLAG cheap/high-volume/whole-files/thin/recall; HYPOTHESIZE smart/low-volume/precision. |
| Verdict space | **`{ SAFE, DANGEROUS }`** only. `SAFE` = no evidence of malice after a genuine triggering attempt (presumption of innocence). |
| "Couldn't check" | An **`ERROR`** (retry/fix the tool), NOT a verdict. Absorbs the old SUSPECT + machinery-broke UNKNOWN. |
| Partial-evidence state | Deferred. A narrow positive `SUSPICIOUS` (payload partway, unconfirmed) added only if logged runs show it's needed — never a coverage-gap dumping ground. |

## Technical decisions (3 orthogonal options each)

**Module split** — (a) two files flag.ts/hypothesize.ts ✅; (b) one file two passes; (c) generic staged-LLM framework. → (a): different models, cost profiles, and boundary contracts; separate files make the boundary explicit.

**Tool schema source** — (a) hand-written registry objects ✅; (b) reflect from `manipulation/` types; (c) external JSON. → (a): explicit, typed, one file, easy to render to a prompt and validate.

**ERROR mechanism** — (a) pipeline raises a retryable audit-error; no report issued ✅; (b) a report with a third `ERROR` verdict; (c) partial report + gap list. → (a): keeps VerdictEnum at two values and makes "no verdict without a completed audit" structural, not a value someone can read as a result.

**Full-oracle representation** — (a) always all-on, delete ObserveFlags ✅; (b) keep ObserveFlags defaulted all-true; (c) per-run override. → (a): the invariant should be structural, not a defaulted flag.

**Model tiers** — FLAG cheap (flash-class); HYPOTHESIZE + JUDGE capable. Triage becomes the main LLM-cost center.

## Implementation phases (land in order, each green)

1. **Tool registry + full oracle.** `sandbox/tools.ts`; `run-under-observation` takes `ToolCall[]`, all sensors on. Experimenter still builds tool calls from old strategies as an adapter (no detection change yet).
2. **HYPOTHESIZE emits experiments.** New `hypothesize.ts` produces `experiment: ToolCall[]`; experimenter executes them; delete `strategyForClaim`/`claimHasDynamicStrategy`.
3. **Two-tier FLAG.** Split the cheap flag pass out (dual lens); wire flag → hypothesize; trim `checks.ts`.
4. **Verdict collapse + delete static route.** Remove `code-reader.ts` + routing; VerdictEnum → {SAFE, DANGEROUS}; rewrite `verdict.ts` (V1–V3); machinery failure → retryable ERROR; drop `claim.kind` dispatch.

## Tests

1. **FLAG dual lens:** a payload beyond intent is flagged; a benign config-loader doing only expected things is not; a time-gate/`eval` is flagged even when the capability is expected.
2. **HYPOTHESIZE → experiment:** a flag ("reads ~/.npmrc, POSTs it") yields a hypothesis whose `experiment` plants a canary + env and triggers the hook — validated tool calls; a spotted gate produces a gate-defeating tool call (e.g. `setDate`).
3. **No dismissal:** HYPOTHESIZE never emits a benign-clear; a flag it can't turn into a testable experiment yields a retryable ERROR, not a SAFE.
4. **Tool registry is one contract:** an invalid `ToolCall` fails validation → ERROR (retry), never silently executed.
5. **Full oracle:** every run's artifact carries all sensor layers regardless of hypothesis.
6. **One resolution path:** every hypothesis routes to run+judge; no static route exists.
7. **Verdict rules:** any confirmed → DANGEROUS; a hypothesis that ran+didn't-fire → contributes to **SAFE** (not a middle state); a hypothesis whose run couldn't complete (sensor/timeout/LLM failure) → the audit is **ERROR** (retryable), no verdict; zero flags → SAFE.
8. **No claim dispatch:** nothing branches on a claim label; routing/strategy code is gone.
9. **End-to-end (real):** `test-pkg-env-exfil` → DANGEROUS (judge cites credential reads + exfil POST); `is-number` → SAFE (0 flags).
