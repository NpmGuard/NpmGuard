# Spec — HYPOTHESIZE composes a fully-typed experiment (no freeform args, no agentic loop)

_Status: approved · 2026-07-11 · brainstormed + approved · builds on 2026-07-10-triage-hypothesis-redesign_

Fix the HYPOTHESIZE experiment-generation bottleneck: the model composes the whole hypothesis in **one
shot** against a schema that is **typed all the way down** (no unconstrained `args` hole), delivered via a
**single forced tool call** so the backend actually honors it. This removes both the original freeform-args
failure and the agentic-loop termination fragility we surfaced while iterating.

## Problem (why this exists)

Today HYPOTHESIZE emits one `generateObject` whose experiment field is `experiment: ToolCall[]` with
`args: z.record(z.unknown())` — an unconstrained **hole**. The model free-types the per-tool args and
reliably mis-shapes them (`setEnv.env` as a string, then as a stringified key list); the mistake is only
caught downstream in `compileExperiment`, disconnected from generation. On the dev server this reproduced
across `gemini-2.5-flash` **and** `gemini-2.5-pro`, and separately produced `"No object generated"`
(the OpenRouter/gemini backend ignoring `response_format` json-schema — the same failure `llm.ts` documents
for MiniMax). The armed-or-ERROR invariant held correctly the whole time (every failure surfaced as a clean
`AuditIncompleteError`, never a false verdict) — but the audit could not complete.

Two orthogonal defects were conflated:
- **Typing** (the real bottleneck): the `args` hole. Fixed by making the schema typed per-tool.
- **Termination** (introduced by the multi-step tool-loop we first reached for): handing the model control
  of when to stop lets it wander and never submit → false ERROR. Avoided by staying single-shot.

## Goal

HYPOTHESIZE turns one flag into one hypothesis carrying a registry-valid experiment via a single
schema-complete generation, or raises `AuditIncompleteError`. **Out of scope:** the judge, model-tier
tuning (a separate concern — "if models fail, we experiment with them"), the sandbox/executor, the verdict,
and `Hypothesis.experiment`'s stored shape (stays `ToolCall[]`).

## Architecture

```
                                     ┌── registry (sandbox/tools.ts) ──────────────┐
                                     │ setup tools: setEnv, plantFiles, setDate,   │
                                     │   stubUrl, patchFile, preload  (each a       │
                                     │   z.object paramSchema)                      │
                                     │ trigger: kind + target + argv + stdin        │
                                     └──────────────────────────────────────────────┘
   FLAG {file, lines, why}                        │ buildExperimentSchema(triggerTargets)
   intent · focus code · entry points             ▼
   ┌───────────────────────────────┐   ┌─ per-flag TYPED schema (no hole) ─────────────────────┐
   │ one flag                      │──▶│ {                                                     │
   └───────────────────────────────┘   │   description: string,                               │
                                        │   claim: { kind: ClaimKind, gating: Gating|null },   │
                                        │   severity: HypothesisSeverity,                      │
                                        │   setup: Array< discriminatedUnion("tool", [         │
                                        │     {tool:"setEnv",     env: Record<string,string>}, │
                                        │     {tool:"plantFiles", files:[{path,content}]},     │
                                        │     {tool:"setDate",    iso: <ISO-datetime>},        │
                                        │     {tool:"stubUrl",    stubs:[...]},                 │
                                        │     {tool:"patchFile",  patches:[...]},              │
                                        │     {tool:"preload",    code: string} ]) >,          │
                                        │   trigger: { kind, target: z.enum(triggerTargets),   │◀─ target is an ENUM of the
                                        │              argv, stdin }                           │   package's real files →
                                        │ }                                                    │   a bad target is UNREPRESENTABLE
                                        └───────────────────────────────────────────────────────┘
                                                         │ generateText, ONE forced tool call
                                                         │   submitHypothesis(inputSchema = the schema above)
                                                         │   toolChoice: required · stepCountIs(1)
                                                         ▼
                                        ┌─ validated typed object ─────────────────────────────┐
                                        │ setup variants  ──▶ ToolCall[] ({tool, args:rest})   │
                                        │ trigger         ──▶ trigger ToolCall                 │  ← convert to the SAME
                                        │ description/claim/severity ──▶ hypothesis fields     │    ToolCall[] the sandbox
                                        └───────────────────────────────────────────────────────┘    already runs
                                                         │
                                    valid ──▶ Hypothesis (experiment = ToolCall[], armed)
                                    invalid / unparseable / no tool call ──▶ AuditIncompleteError
```

Nothing downstream of `Hypothesis.experiment` changes: it stays `ToolCall[]`, `compileExperiment` stays the
executor (now a redundant re-check), run/timeline/judge/verdict are untouched.

## The mechanism, precisely

1. **Per-flag schema, built from the registry (single source of truth).** A new
   `buildExperimentSchema(triggerTargets: string[])` in `tools.ts` assembles the typed output schema:
   `setup` is `z.array(z.discriminatedUnion("tool", [ <each setup tool's paramSchema>.extend({ tool: z.literal(name) }) ]))`;
   `trigger` is the trigger tool's schema with `target` narrowed to `z.enum(triggerTargets)`;
   `description`/`claim`/`severity` are siblings. The variants **are** the tools' `paramSchema`s — one source
   of truth for prompt-schema and executor.
2. **`triggerTargets` is the package's real runnable files** — `entryPoints.runtime ∪ entryPoints.install ∪
   entryPoints.bin ∪ flag.file` (deduped). Because `trigger.target` is an enum over this set, a nonexistent
   target is **unrepresentable** — the model cannot silently trigger a missing file (which would run nothing
   → REFUTED → false SAFE). This is provocative-assumption-1, enforced at the schema, not post-validated.
3. **Single forced tool call delivery.** `generateText({ model: investigationModel, tools: { submitHypothesis:
   tool({ inputSchema: <the schema>, execute: async (x) => x }) }, toolChoice: { type: "tool", toolName:
   "submitHypothesis" }, stopWhen: stepCountIs(1) })`. Read the validated args off the one tool call. This is
   single-shot (one forced call, no loop, no model-controlled termination) and uses the transport that
   backends honor where `response_format` json-schema is silently ignored — the same move `llm.ts` already
   shims for MiniMax.
4. **Convert → `Hypothesis`.** Each `setup` variant `{tool, ...args}` → `{tool, args}`; `trigger` → a trigger
   `ToolCall`; append in order → `experiment: ToolCall[]`. `compileExperiment` re-validates (idempotent).
5. **Armed-or-ERROR, one attempt.** No hand-coded retry loop (delete `MAX_ARMING_ATTEMPTS`). If the SDK
   cannot produce a valid tool call (unparseable, schema-invalid, or absent), raise `AuditIncompleteError` —
   the schema completeness is the fix, not retries.

## Changes

| file | change |
|---|---|
| `engine/src/sandbox/tools.ts` | **NEW** `buildExperimentSchema(triggerTargets)` → the typed `{description, claim, severity, setup: discriminatedUnion[], trigger(target enum)}` Zod schema, assembled from the setup tools' `paramSchema`s + the trigger schema. Type `SetupTool.paramSchema` as `z.ZodObject` (all already are) so `.extend({tool: literal})` type-checks. Tighten `setDate.iso` from `z.string()` to an ISO-8601 datetime constraint (invalid dates unrepresentable). Drop `argsExample` + its catalog rendering — the typed schema now carries the shape; the catalog keeps name + purpose only. |
| `engine/src/phases/hypothesize.ts` | **Rework `hypothesizeFlag`.** Replace the freeform `HypothesisResponse` + `generateObject` + `MAX_ARMING_ATTEMPTS` retry with: compute `triggerTargets`, `buildExperimentSchema`, one forced-tool-call generation, convert the typed object → `Hypothesis`. Invalid/unparseable/no-call → `AuditIncompleteError`. Keep `buildHypothesizePrompt` (intent + flag + focus code + purpose catalog + `SUGGESTED_CANARY`). |
| `engine/src/phases/hypothesize.test.ts` | Update: mock the forced tool call returning a typed object; assert setup+trigger → `ToolCall[]` conversion, the `trigger.target` enum rejects an off-list target, invalid object → `AuditIncompleteError`, and no hand-coded retry (one generation). |
| `engine/src/sandbox/tools.test.ts` | Drop the `argsExample` catalog assertion; add: `buildExperimentSchema` accepts a valid typed object and rejects a string `env` / an off-enum `trigger.target`; every setup tool has a discriminated variant. |

## User-confirmed decisions

| decision | choice |
|---|---|
| Composition shape | **One-shot fully-typed object**, not the agentic setup-tools+terminal-submit loop. The loop's only survivor: `trigger` is a typed field, not a callable tool, so exactly-one-trigger is structural. |
| Per-tool arg typing | **Discriminated union** over the registry's `paramSchema`s — closes the `args` hole at the schema level. |
| Delivery | **Single forced tool call** (honored where `response_format` json-schema is silently ignored, per `llm.ts`), not a multi-step loop. |
| Model tier | **Don't pin** — HYPOTHESIZE uses `NPMGUARD_INVESTIGATION_MODEL`; the mechanism fix is expected to make even a cheap tier compose valid experiments. Model quality is a separate experiment. |
| Retry / ERROR bound | **One attempt, no hand-coded outer retry.** Schema completeness is the fix; an invalid result → `AuditIncompleteError`. |
| `trigger.target` validity | **Schema-level enum** of the package's real runnable files — an invalid target is unrepresentable (not post-validated). |
| Bait adequacy | **Model's responsibility.** No per-flag "must plant bait before a trigger" enforcement; a bare trigger that fires nothing → REFUTED. |
| Shape-valid-but-semantic-junk args | **Tighten schemas to shrink the invalid space** wherever feasible (`setDate.iso` datetime, `trigger.target` enum). Residual semantic-invalid args (e.g. a stub pattern that matches nothing) surface as a run-time error → DEFERRED → ERROR — loud, not fake-in-darkness. |

## Technical decisions (3 orthogonal options each)

**Delivery mechanism** — (a) single forced tool call via `generateText`+`toolChoice` ✅; (b) `generateObject`
`response_format` json-schema; (c) multi-step agentic tool loop. → (a): honored across OpenAI-compatible
backends (b silently failed on our actual backend with "No object generated"); single-shot (c hands the
model termination control → the fragility we're removing).

**Schema construction** — (a) discriminated union assembled from the registry `paramSchema`s ✅; (b) a
hand-written typed schema duplicating the tool shapes; (c) freeform `record(unknown)`. → (a): one source of
truth (the variants are the tool schemas), so the prompt-schema and the executor can never drift; (b)
duplicates and drifts; (c) is the bug.

**`trigger.target` constraint** — (a) `z.enum(packageTriggerTargets)` in the per-flag schema ✅; (b) free
string + post-generation validation against the package files; (c) free string, no check. → (a): an invalid
target is unrepresentable, caught at generation, per the "shrink the invalid space" rule; (b) catches it but
later and as bespoke code; (c) is the silent-false-SAFE hole.

## Invariants

- **I1** — every flag becomes a hypothesis carrying a registry-valid experiment, or the audit is an
  `AuditIncompleteError`. No fabricated hypothesis, no empty experiment, no benign dismissal.
- **I2** — an experiment has exactly one trigger. Structural: `trigger` is one typed field, not an array and
  not a callable tool.
- **I3** — an experiment's `trigger.target` is a real runnable file in the package. Structural: enum.
- **I4** — the tool registry is the single source of truth for both the generation schema and the executor;
  the discriminated-union variants are the tools' `paramSchema`s.

## Tests

1. **Typed happy path:** a mocked forced-tool-call returns `{description, claim, severity, setup:[{tool:"setEnv",env:{…}},{tool:"plantFiles",files:[…]}], trigger:{kind,target}}` → a `Hypothesis` whose `experiment` is the equivalent `ToolCall[]` (setEnv, plantFiles, trigger) and whose description/claim/severity/focus are carried.
2. **No `args` hole:** `buildExperimentSchema([...]).safeParse` rejects a `setup` element with `env` as a string (`Expected object, received string`) — the shape that broke us is now unrepresentable.
3. **Trigger target enum:** `buildExperimentSchema(["setup.js","index.js"])` rejects `trigger.target = "nope.js"`; accepts `"setup.js"`. A flag whose focus file is on the enum can be triggered directly.
4. **Exactly one trigger (structural):** the schema has a single `trigger` object field — there is no representation for zero or two triggers.
5. **Single source of truth:** every setup tool in `TOOLS` has a matching discriminated-union variant, and each variant's non-`tool` fields equal that tool's `paramSchema` shape.
6. **Armed-or-ERROR, one attempt:** an unparseable / schema-invalid / absent tool call → `AuditIncompleteError`; the generation is attempted exactly once (no hand-coded retry).
7. **Tightened arg:** `setDate` rejects `"last tuesday"` and accepts `"2027-03-01T00:00:00Z"` at the schema.
8. **End-to-end (real, dev server):** `test-pkg-env-exfil` completes to a verdict (DANGEROUS on a capable judge; the point of THIS spec is that HYPOTHESIZE no longer errors on arg shape) — eyeballed on `:8100`, the acceptance bar.
