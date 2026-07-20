# Python backend migration

Status: complete (2026-07-20).

## Outcome

Replace the TypeScript backend with a Python service while preserving the
existing frontend and CLI wire contracts. Reuse the proven migration shape
from Rizz and vendor the useful infrastructure modules from
`/home/wookie/zen/lab/kit`.

## Fixed boundaries

- Python owns HTTP routes, SSE delivery, audit orchestration, report storage,
  payment verification, registry access, and LLM integration.
- Node-specific audit instrumentation remains JavaScript because the target
  process is a Node package. Python owns its lifecycle and consumes its output.
- Existing HTTP paths, JSON shapes, SSE event names/data, report filenames, and
  payment semantics are compatibility contracts.
- `shared/` remains the canonical Zod contract source. JSON Schema and Pydantic
  models are generated and checked for drift.
- Audit failures remain failures. They are never converted into SAFE or
  DANGEROUS verdicts.
- Reports remain filesystem-backed at `data/reports/<package>/<version>.json`.
  Durable audit events and terminal state use Kit's stream/spine persistence.

## Adopt from Kit

- `spine`: configuration, structured errors, request IDs, logging, async DB
  lifecycle, and notifier ports;
- `stream`: append-only sequenced audit events, replayable SSE, and durable
  terminal progress;
- `llm`: OpenRouter client, model roles/fallbacks, timeouts, structured-output
  validation and bounded repair, capture ledger, budgets, and deterministic
  mocks.

Kit auth is outside this backend's scope. SQLite is the local/default event
store; the same persistence layer may use PostgreSQL in deployment.

## Kit hypothesis integration

Hypothesis generation remains isolated behind the app-owned
`HypothesisGenerator` port. The latest Kit structured/tool-call fix is vendored:
the adapter forces a typed tool output, validates it against targets present in
the current flag, and gives the same model one bounded repair attempt. Every
flag therefore becomes a schema-valid runnable experiment or the audit
terminates with an explicit error.

## Cutover sequence

1. Freeze contracts and record canonical HTTP/SSE/report traces from the
   TypeScript backend.
2. Scaffold the Python engine, vendor Kit modules, and prove generated model parity.
3. Port leaf dependencies first: configuration, errors, registry, storage,
   evidence, graph, and Node instrumentation assets.
4. Port model adapters, phases, orchestration, audit service, payments, and
   routes.
5. Run Python unit/integration tests plus the shared golden parity suite.
6. Point frontend, CLI, Docker, and deployment configuration at Python.
7. Remove the TypeScript backend after the parity gates pass and make the
   Python service the canonical `engine/`.

Do not mix eval redesign into the compatibility migration. The deferred eval
work starts from the durable run data produced by the new backend.
