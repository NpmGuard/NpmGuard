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

## Route ownership

- `api.py`: FastAPI routes, lifespan, `/api` mirror, static frontend
- `service.py`: queue, background execution, restart recovery
- `pipeline.py`: resolve → inventory → intent → flag → hypothesize → graph
- `orchestrator.py`: full-oracle experiment loop and evidence-bound judgment
- `payments.py`: Stripe and Base verification
- `persistence.py`: sessions and exact-once claims
- `events.py`: durable event log and legacy-compatible SSE wire format
