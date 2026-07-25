# NpmGuard Python Engine

FastAPI audit service for npm supply-chain analysis. Python owns HTTP, payments,
orchestration, persistence, LLM calls, evidence, and verdicts. The only Node in
the engine runs inside the sandbox, because the audited packages are npm code.

## Run

Requirements: Python 3.12+, [uv](https://docs.astral.sh/uv/), Docker, and Node
22 for the frontend/shared contract build.

```bash
cp .env.template .env
uv sync --all-groups
uv run alembic upgrade head
uv run uvicorn npmguard.api:app --reload --port 8000
```

Or from the repository root:

```bash
./run.sh --dev
```

Every route answers under the `/api` mirror — `/audit`, `/audit/stream`, durable
SSE events, reports, registry, Stripe/on-chain payment verification, demos, and
benchmark-result reads — and most also answer at the root.

The exceptions are the routes whose path is also a page in the frontend the
engine serves: `/api/packages` and `/api/replays` have no root form, because a
root route of that name wins the match and hands a browser JSON. `/audit/{id}`
is likewise a page, while everything under it (`/events`, `/file`, `/report`) is
API. `api.py::client_owned_router` is where that is decided; a new page whose
path collides with a root route means moving the route there.

## Test and lint

```bash
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

`NPMGUARD_MOCK_LLM=true` enables the deterministic benign provider used by
API tests. It must never be enabled for a real audit.

Batch and watchlist operations, plus the false-positive gate over their output:

```bash
uv run npmguard-ops audit-batch is-number@7.0.0 left-pad
uv run npmguard-ops audit-latest --limit 5 --out ../data/watchlist/latest.json
uv run npmguard-ops watchlist-check --file ../data/watchlist/latest.json
```

`watchlist-check` is not part of the benchmark — the bench reads observations
from the database (`npmguard.bench`), while this reads `audit-latest` result
files. Its `--max-dangerous 0` default is a specificity canary over packages
presumed clean.

## Contracts

The canonical wire/persistence schemas live in `../shared`. Regenerate the
Pydantic contract whenever they change:

```bash
cd ..
npm run contract
```

This produces `npmguard/contract/models.py`. Do not hand-edit that file.

## State and evidence

- Published reports: `../data/reports/<package>/<real-version>.json`
- Durable sessions, SSE events, LLM captures, payment claims: SQLAlchemy DB
- Per-run evidence and graphs: `../audit-logs/`
- Default dev DB: `../data/npmguard.sqlite3`

Production runs `alembic upgrade head` before startup. A hard restart turns
orphaned running audits into explicit retryable errors; it never leaves clients
following a session that can no longer complete.

## Hypothesis generation

`npmguard.phases.HypothesisGenerator` is the application boundary. The default
`KitHypothesisGenerator` uses Kit's tool-carried structured output: a dynamic
Pydantic schema constrains setup primitives and the real trigger targets, one
synthetic output tool is forced, and invalid arguments receive bounded repair.
This adapter is intentionally replaceable as Kit's hypothesis support evolves.
