# engine — CLAUDE.md

- Python 3.12+, FastAPI, Pydantic v2, SQLAlchemy async, Alembic, uv.
- Runtime configuration is `.env`; application variables use `NPMGUARD_`.
- Run `uv run pytest` and `uv run ruff check .` after engine changes.
- `npmguard/contract/models.py` is generated from `shared`; never hand-edit it.
- Reports remain at `data/reports/<pkg>/<real-version>.json`. The real tarball
  version is authoritative; never persist a `latest.json` alias.
- SQL owns durable sessions, event replay, LLM capture, and exact-once payment
  claims. Do not replace those with process-local maps.
- Audit failure is an ERROR, never a SAFE verdict or hidden coverage gap.
- A suspicion can be cleared only by running its compiled experiment under the
  full oracle. Confirm/refute transitions require evidence.
- Hypothesis generation is behind `HypothesisGenerator`; keep Kit-specific
  changes inside `KitHypothesisGenerator`.
- JavaScript under `npmguard/assets/` is sandbox instrumentation for Node
  packages, not application backend code.

## Testing

See [TESTING.md](TESTING.md) for tiers, class maps, and the replay-fixture
system. One rule to know: LLM fixtures replay real captured traffic,
content-matched and pinned to prompt hashes — editing `prompts/` requires a
re-record (the loader fails loud).
Run `scripts/gate.sh` before pushing.

## Payment gate

`POST /audit/stream` has exactly three entry paths:

1. `txHash + chain`: verify the configured contract event, then atomically claim
   `(chain, txHash)`.
2. `stripeSessionId`: verify Stripe, then atomically claim the session id.
3. No proof: development only when `NPMGUARD_PAYMENT_REQUIRED=false`.

Never launch work before the payment proof is verified and claimed.

## How the audit core actually works

[`../docs/architecture/AUDIT_CORE_EXPLAINED.md`](../docs/architecture/AUDIT_CORE_EXPLAINED.md)
is the first-principles walkthrough of the whole path — admission → resolve →
inventory → intent → flag → hypothesize → graph → full-oracle orchestration →
evidence-bound judgment → report — traced with a real recorded audit, so every
value in it is true rather than illustrative. Read it before changing pipeline
shape, and read it instead of re-deriving the pipeline from the code.

It is the reference for the questions that keep recurring: what a hypothesis /
claim / experiment actually are, what "full oracle" observes, why a DEFERRED
hypothesis can never yield SAFE, and the **two report stores** —
`audit_sessions.report` keyed by `audit_id` versus
`data/reports/<pkg>/<version>.json` keyed by `(name, version)`. Confusing those
two is a live trap: the filesystem store keeps only the last audit of a given
`(name, version)`, so anything needing per-run reports must read the DB.

## Route ownership

- `api.py`: FastAPI routes, lifespan, `/api` mirror, static frontend
- `service.py`: queue, background execution, restart recovery
- `pipeline.py`: resolve → inventory → intent → flag → hypothesize → graph
- `orchestrator.py`: full-oracle experiment loop and evidence-bound judgment
- `payments.py`: Stripe and Base verification
- `persistence.py`: sessions and exact-once claims
- `events.py`: durable event log and legacy-compatible SSE wire format
