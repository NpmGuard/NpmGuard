#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PROD=false
if [[ "${1:-}" == "--prod" ]]; then
  PROD=true
fi

npm install --silent

if $PROD; then
  echo "[frontend] Building..."
  npx vite build
  echo "[frontend] Build complete (dist/)."
  exit 0
fi

# Dev mode: run vite dev server
set -m

cleanup() {
  echo -e "\nShutting down frontend..."
  kill -- -"$PID" 2>/dev/null
  wait "$PID" 2>/dev/null
  echo "Done."
}
trap cleanup INT TERM EXIT

npx vite --host 0.0.0.0 &
PID=$!
wait "$PID"
