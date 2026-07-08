# Archived architecture docs — SUPERSEDED

These describe the **pre-2026-07-08 engine pipeline design** (the v2 hypothesis-graph
cutover: intent → triage → orchestrator → experimenter/code-reader → `deriveGraphVerdict`,
with differential/capability-presence confirmation). That design is **obsolete** — the
pipeline is being redesigned from scratch around a "mimic a senior security researcher"
philosophy (read source for intent → hypotheses → run under a semantic-whitebox oracle →
match hypothesis to a human/LLM-readable execution log → judge).

Kept for history and context only. Do not treat as current design.

- `ARCHITECT_REVIEW_ENGINE.md` — original v2 hypothesis-graph design (2026-04-18 / 05-05)
- `ARCHITECT_REVIEW_ENGINE_V2_CUTOVER.md` — the v2-native cutover plan (2026-07-07)

Note: the currently *deployed* engine code still matches the cutover doc (committed
`4a56ac8`, running on the dev box :8100). Archiving the specs does not change that code —
it marks the design direction as replaced.
