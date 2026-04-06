#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

set -m

ENGINE_PID=
FRONTEND_PID=

cleanup() {
  echo -e "\nShutting down..."
  [ -n "$ENGINE_PID" ] && kill -- -"$ENGINE_PID" 2>/dev/null
  [ -n "$FRONTEND_PID" ] && kill -- -"$FRONTEND_PID" 2>/dev/null
  wait 2>/dev/null
  echo "Done."
}
trap cleanup INT TERM EXIT

./engine/run.sh &
ENGINE_PID=$!

# Wait for engine to be ready before starting frontend
echo "Waiting for engine on :8000..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    echo "Engine ready."
    break
  fi
  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
    echo "Engine failed to start."
    exit 1
  fi
  sleep 0.5
done

./frontend/run.sh &
FRONTEND_PID=$!

wait
