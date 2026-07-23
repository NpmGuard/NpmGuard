#!/bin/sh
# The merge gate, cheap first (see TESTING.md "The gate"):
#   ruff -> default pytest -> fixture lint -> e2e sqlite -> docker/postgres/cli tiers.
# Postgres is provisioned here as a throwaway container when docker is available
# so the DSN-gated unit classes (the only honest concurrency proofs) actually
# run; without docker they skip LOUDLY — they remain required before merge.
# No hook is installed by this script; wire it to pre-push yourself if desired.
set -e
# Anchor on the repo root so the script works both direct and as a pre-push symlink.
cd "$(git rev-parse --show-toplevel)/engine"

note() { printf '\ngate: %s\n' "$1" >&2; }

note "ruff"
uv run ruff check .

# Throwaway postgres for the DSN-gated unit + e2e postgres classes.
PG_NAME=""
cleanup() {
  if [ -n "$PG_NAME" ]; then
    docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

DOCKER_OK=0
if [ "${NPMGUARD_TEST_DOCKER:-1}" != "0" ] && docker info >/dev/null 2>&1; then
  DOCKER_OK=1
fi

if [ -z "$NPMGUARD_TEST_PG_DSN" ] && [ "$DOCKER_OK" = "1" ]; then
  PG_NAME="npmguard-gate-pg-$$"
  docker run -d --name "$PG_NAME" \
    -e POSTGRES_USER=npmguard -e POSTGRES_PASSWORD=npmguard -e POSTGRES_DB=npmguard \
    -p 127.0.0.1:0:5432 postgres:17-alpine >/dev/null
  PG_PORT="$(docker port "$PG_NAME" 5432/tcp | head -1 | sed 's/.*://')"
  tries=0
  until docker exec "$PG_NAME" pg_isready -U npmguard >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 150 ]; then
      note "throwaway Postgres never became ready"
      exit 1
    fi
    sleep 0.2
  done
  # pg_isready can pass against initdb's TEMPORARY server (observed on
  # postgres:17-alpine: 'accepting' then 'rejecting connections' during the
  # restart) — require a real query before exporting the DSN.
  tries=0
  until docker exec "$PG_NAME" psql -U npmguard -d npmguard -c 'select 1' >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 150 ]; then
      note "throwaway Postgres passed pg_isready but never accepted a query"
      exit 1
    fi
    sleep 0.2
  done
  NPMGUARD_TEST_PG_DSN="postgresql+asyncpg://npmguard:npmguard@127.0.0.1:${PG_PORT}/npmguard"
  export NPMGUARD_TEST_PG_DSN
  note "throwaway postgres at 127.0.0.1:${PG_PORT}"
elif [ -z "$NPMGUARD_TEST_PG_DSN" ]; then
  note "docker unavailable — postgres classes SKIP (required before merge)"
fi

note "default suite (units + slices)"
uv run pytest -q

note "fixture lint"
uv run python -m tools.fixture_lint

note "e2e sqlite"
uv run pytest -q -m "e2e and not docker and not postgres and not cli"

if [ "$DOCKER_OK" = "1" ] && docker image inspect npmguard-sandbox:v1 >/dev/null 2>&1; then
  note "e2e docker"
  uv run pytest -q -m "e2e and docker"
elif [ "$DOCKER_OK" = "1" ]; then
  note "npmguard-sandbox:v1 image missing — e2e docker tier SKIPPED (required before merge)"
else
  note "docker unavailable — e2e docker tier SKIPPED (required before merge)"
fi

if [ -n "$NPMGUARD_TEST_PG_DSN" ] || [ "$DOCKER_OK" = "1" ]; then
  note "e2e postgres"
  uv run pytest -q -m "e2e and postgres"
else
  note "no postgres available — e2e postgres tier SKIPPED (required before merge)"
fi

if [ -d ../cli/dist ]; then
  note "e2e cli"
  uv run pytest -q -m "e2e and cli"
else
  note "cli/dist not built — cli tier SKIPPED (build the CLI to run it)"
fi

note "GATE GREEN"
