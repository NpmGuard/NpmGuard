#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PROD=false
if [[ "${1:-}" == "--prod" ]]; then
  PROD=true
fi

npm install --silent

# Ensure the Docker verify image exists (needed for test verification)
if ! docker image inspect npmguard-verify >/dev/null 2>&1; then
  echo "[engine] Building npmguard-verify Docker image..."
  docker build -t npmguard-verify -f Dockerfile.verify . || {
    echo "[engine] WARNING: Failed to build npmguard-verify image. Test verification will be skipped."
  }
else
  echo "[engine] npmguard-verify Docker image: OK"
fi

# Run in its own process group so we can kill the entire tree
set -m

cleanup() {
  echo -e "\nShutting down engine..."
  kill -- -"$PID" 2>/dev/null
  wait "$PID" 2>/dev/null
  echo "Done."
}
trap cleanup INT TERM EXIT

if $PROD; then
  echo "[engine] Building..."
  npx tsc
  echo "[engine] Starting production server..."
  node dist/index.js &
else
  npx tsx src/index.ts &
fi
PID=$!
wait "$PID"
