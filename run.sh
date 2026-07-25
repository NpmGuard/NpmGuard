#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

DEV=false
if [[ "${1:-}" == "--dev" ]]; then
  DEV=true
fi

# Workspace install covers shared/, frontend/ and bench/ in one pass.
echo "Installing workspace dependencies..."
npm install --silent

# Build the @npmguard/shared workspace first — frontend and bench import its
# compiled dist/; the engine consumes it only via codegen (npm run contract).
echo "Building @npmguard/shared..."
npm run build:shared --silent

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

# engine/run.sh may uv-sync, migrate and build the sandbox image before it binds,
# so a cold start is minutes, not seconds. Waiting a fixed 15s and continuing
# anyway reported "running" for a stack with no engine in it.
wait_for_engine() {
  echo "Waiting for engine on :8000..."
  for _ in $(seq 1 600); do
    if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
      echo "Engine ready."
      return 0
    fi
    if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
      echo "Engine exited before it became ready." >&2
      return 1
    fi
    sleep 0.5
  done
  echo "Engine did not answer /health within 300s." >&2
  return 1
}

if $DEV; then
  # ── Dev mode: FastAPI reload + Vite dev server ──
  ./engine/run.sh &
  ENGINE_PID=$!
  wait_for_engine

  npm --prefix frontend run dev -- --host 0.0.0.0 &
  FRONTEND_PID=$!
  echo "Frontend dev server on :3000."
else
  # ── Production mode: build frontend, then start engine ──
  echo "[frontend] Building..."
  npm --prefix frontend run build

  ./engine/run.sh --prod &
  ENGINE_PID=$!
  wait_for_engine
  echo "Production server running — engine serves frontend/dist on :8000."
fi

wait
