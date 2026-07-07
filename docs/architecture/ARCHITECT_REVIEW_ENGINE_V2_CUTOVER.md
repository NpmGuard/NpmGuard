# Architecture Review: Engine V2 Cutover — Retiring the Legacy Pipeline

**Date:** 2026-07-07
**Scope:** The `engine/` audit pipeline — how a package becomes a verdict. Follow-on to [`ARCHITECT_REVIEW_ENGINE.md`](./ARCHITECT_REVIEW_ENGINE.md) (2026-04-18 / 2026-05-05), which designed the v2 hypothesis-graph architecture. This review audits what actually shipped and defines the cutover to make v2 native.
**Status:** Phase 1 (make v2 native, retire v1) implemented 2026-07-07 — orchestrator dispatch loop + code-reader worker built, `verdict = deriveGraphVerdict(graph)`, v1 phases deleted, `AuditReport` grown to 4-state, cascaded to CLI + frontend. All packages build; 276 engine tests pass. Not yet benched (Phase 2) or deployed.

---

## System Shape

Four subprojects, one core. `cli/` is a thin observer (viem + WalletConnect, never holds keys). `engine/` (TypeScript + Hono) turns a package into a verdict and enforces the payment trust boundary server-side before any audit runs. `frontend/` is a React/Vite SSE dashboard. `contracts/` is a pay-to-audit Solidity contract on Base Sepolia. Reports persist as **flat JSON** at `data/reports/<pkg>/<version>.json` (`report-store.ts`, single source of truth, no external pinning by rule); per-run artifacts + the hypothesis graph are written under `audit-log/`; SSE session state is in-memory.

The engine pipeline currently runs **two stacked detection systems** on every non-trivial audit: the original linear pipeline (`inventory → triage → investigate → test-gen → verify`) and the v2 rework (`intent → hypothesis graph → experimenter/runUnderObservation → deriveGraphVerdict`) layered on top, reconciled by an ad-hoc boolean that collapses the 4-state graph verdict back into the legacy 2-state `SAFE|DANGEROUS`.

---

## Root Cause

**The v2 rework was grafted on as an additional layer instead of replacing v1.** The engine has two independent detection systems; the old one still owns the report that ships, and the new one is subordinate to it. This is drift, not a deliberate ensemble — confirmed with the owner.

### Evidence

| Symptom | Location | Traces to root how |
|---|---|---|
| **Verdict-collapse hack** — `graphVerdict === "SAFE" && !hasConfirmedProof ? SAFE : DANGEROUS`, with a 6-line apology comment | `pipeline.ts:499–504` | The design wanted `verdict = f(graph)`. Instead the graph verdict is ANDed with the old path's `TEST_CONFIRMED` proofs. Exists only because both engines run and neither is trusted alone. |
| **`correlate.ts` is a 379-line anti-corruption layer** translating old `Finding`/`Proof` into graph transitions | `correlate.ts`, called `pipeline.ts:364,473` | The target model is "Finding = Hypothesis with a state. One type, not two." With one model there is nothing to correlate. Pure accidental complexity from the graft. |
| **The new evidence engine is parasitic on the old one** — experimenter only runs on `IN_PROGRESS`, and hypotheses reach `IN_PROGRESS` only via `correlateAfterInvestigation` (the old agent) | `pipeline.ts:372`, `verdict.ts:110` | The tamper-proof evidence stack can only confirm what the old black-box agent already flagged. Graph can't resolve itself. |
| **Evidence built but not load-bearing** — RunArtifacts are hashed and written to `audit-log/`, but the shipped report uses old-path outputs and sets `runtimeEvidence: null` | `pipeline.ts:511–519` | Chain of custody (the entire point of the rework) is computed and discarded. Report is still the prose-based old model. |
| **Cross-process contract still 2-state** — `VerdictEnum = ["SAFE","DANGEROUS"]`; 4-state `GraphVerdict` never crosses the boundary | `shared/models.ts:7` vs `orchestrator/verdict.ts:10` | CLI/frontend can't distinguish `DANGEROUS` from `UNKNOWN`. The #1 product goal (coverage honesty) is defeated at the schema. |
| **Two taxonomies for one concept** — `CapabilityEnum` (21 values) and `ClaimKind` (13 values) | `models.ts:10` vs `shared/graph.ts:9` | A new attack type needs an entry in both, plus a strategy map, plus a correlate bridge. 4× tax, all from running two engines. |

The sharpest single tell: `deriveGraphVerdict` is **already the correct pure function** (`verdict.ts:76`). The blocker to making it authoritative is `verdict.ts:110` — "any OPEN/IN_PROGRESS → SUSPECT" — because **nothing drives hypotheses from OPEN to a terminal state except v1's correlator.** There is no orchestrator and there are no workers (`build-graph.ts` comment: "No workers yet — every node stays OPEN until Phase B orchestration"). Delete v1 today and the graph verdict is `SUSPECT` for nearly everything.

---

## Structural Move

**Make v2 native and retire v1 fully.** The hypothesis graph becomes the only truth-producing artifact; the verdict is the pure `deriveGraphVerdict` with no collapse and no fallback.

The core work is **not** deletion — it is building the minimal **orchestrator + workers** that let the graph resolve itself, which is the piece the graft skipped:

- **Orchestrator dispatch loop** — iterate OPEN hypotheses, route by `claim.kind`, transition on result. Deterministic code (priority + routing + completion), per the design's LLM-vs-code split.
- **Workers** — `experimenter` (already exists; dynamic claims via `runUnderObservation` + whitebox setup) and a minimal `code-reader` (static claims). The `HypothesisResolution.by` field already anticipates both.
- Once OPEN nodes reach terminal states on their own, `investigate` / `test-gen` / `verify` / `correlate.ts` have no consumer and come out, and the graph's evidence refs become what the report ships.

### The block decision — block only on reproduced evidence

Owner's call: **avoid false positives.** This is not just UX — it is the chain-of-custody axiom made operational. Only a `CONFIRMED` hypothesis with a cited `RunArtifact` may block an install; suspicion never gates.

| `GraphVerdict` | Reached when | CLI action |
|---|---|---|
| `DANGEROUS` | ≥1 `CONFIRMED` (dynamic evidence) | **Block**; show the observed chain; `--force` overrides |
| `SAFE` | empty graph, or all `REFUTED` | Install silently |
| `SUSPECT` | any hypothesis still pending | Warn + prompt; cite pending hypotheses |
| `UNKNOWN` | all resolved, none confirmed, ≥1 inconclusive/deferred | Warn + prompt; **show the coverage gap loudly** |

**The one bite to design against:** false-positive aversion means evasive malware that doesn't fire under the chosen setup lands in `UNKNOWN` and won't block — you can silently wave through the payload you couldn't reproduce. Mitigation is the whitebox principle (read the code, set the trigger, make it fire → `DANGEROUS`), but it is never total. Therefore `UNKNOWN` must **inform loudly** — "couldn't analyze" must never render as a quiet pass. That is the line between honest and negligent for a security gate.

---

## Implementation Order

Owner's chosen sequence: **make v2 native first, bench second, tune later.** Bench is validation-after, not a gate-before — a deliberate risk-appetite choice (see Tradeoffs).

**Phase 1 — Make v2 native (the cutover).**
1. Build the minimal orchestrator dispatch loop + `code-reader` worker so OPEN hypotheses reach terminal states without v1. (`experimenter` already exists.)
2. `verdict = deriveGraphVerdict(graph)` — delete the collapse and `hasConfirmedProof` fallback (`pipeline.ts:499–504`).
3. Grow `AuditReport` to the 4-state + evidence-ref shape; cascade `shared → engine → CLI → frontend`. Wipe `data/reports/*` on deploy (no migrator, by design).
4. Delete `investigate` / `test-gen` / `verify` / `correlate.ts`; merge `CapabilityEnum` into `ClaimKind`.

**Phase 2 — Bench on real packages.** Point `bench/` at a labeled set (malicious: event-stream, ua-parser-js, a Shai-Hulud shape; clean: is-number, left-pad, an unaffected chalk). Measure v2-native recall/precision. First real-package validation — fixtures only until now.

**Phase 3 — Tune (deferred).** Recall tuning, sensor reliability (L2 pcap is flaky per the prior review), whitebox trigger derivation, and reintroducing a human-readable reproducer as a pure artifact-generator off the `RunArtifact`. Explicitly not now.

---

## Tradeoffs Acknowledged

- **Bench-after-cutover is a deliberate risk.** v1 is the only path that has run in prod on real traffic; v2 has run only on fixtures. Retiring v1 before validating v2 on real packages is the owner's accepted call — favoring a clean architecture now over a cautious shadow-migration. The bench (Phase 2) is the safety net, run immediately after, not before.
- **Coarse verdicts are acceptable for now.** "We don't care that much about fine-tuning it" — a mostly-`SUSPECT`/`UNKNOWN` early state is fine; the structure is the goal, accuracy is Phase 3.
- **Loss of the Vitest reproducer.** `test-gen`/`verify` produced a human-readable "here's a test that proves it." Gone in the interim; reintroduce later as an artifact generator.
- **Breaking contract change.** 4-state is not wire-compatible with cached 2-state reports; `report-store.ts` has no migrator, so wipe-on-deploy. Do **not** ship the deletion to prod before CLI + frontend speak 4-state, or the dashboard breaks.
- **Real packages will hurt.** Download + larger file counts + longer triage will expose timeout/context limits the fixtures never did. Engineering follow-through, not a correctness risk — but the difference between "clean" and "broke prod on a Friday."
