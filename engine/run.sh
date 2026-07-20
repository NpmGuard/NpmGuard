#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

uv sync --all-groups
uv run alembic upgrade head

if ! docker image inspect npmguard-sandbox:v1 >/dev/null 2>&1; then
  echo "[engine] Building npmguard-sandbox:v1..."
  docker build -t npmguard-sandbox:v1 -f ../sandbox/docker/Dockerfile.sandbox ..
fi

if [[ "${1:-}" == "--prod" ]]; then
  exec uv run uvicorn npmguard.api:app \
    --host "${NPMGUARD_API_HOST:-0.0.0.0}" \
    --port "${NPMGUARD_API_PORT:-8000}"
fi

exec uv run uvicorn npmguard.api:app \
  --reload \
  --host "${NPMGUARD_API_HOST:-0.0.0.0}" \
  --port "${NPMGUARD_API_PORT:-8000}"
