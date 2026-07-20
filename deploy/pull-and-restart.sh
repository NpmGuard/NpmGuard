#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# NpmGuard — auto-deploy script
#
# Called by the webhook listener on every push to main.
# Pulls latest code, migrates the Python engine, rebuilds the frontend,
# and restarts the service.
#
# Logs to /var/log/npmguard-deploy.log
# Uses a lock file to prevent concurrent deployments.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -euo pipefail

REPO_DIR="/root/NpmGuard"
LOG="/var/log/npmguard-deploy.log"
LOCK="/tmp/npmguard-deploy.lock"

log() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG"; }

# ── Lock: prevent concurrent deploys ─────────────────────────────────
if [ -f "$LOCK" ]; then
  log "Deploy already in progress (lock: $LOCK). Skipping."
  exit 0
fi
trap 'rm -f "$LOCK"' EXIT
touch "$LOCK"

log "=== Deploy started ==="

# ── Pull latest code ─────────────────────────────────────────────────
cd "$REPO_DIR"
git pull origin main 2>&1 | tee -a "$LOG"

# ── Sync + migrate engine ────────────────────────────────────────────
log "Syncing Python engine..."
cd "$REPO_DIR/engine"
/root/.local/bin/uv sync --frozen 2>&1 | tee -a "$LOG"
/root/.local/bin/uv run alembic upgrade head 2>&1 | tee -a "$LOG"

# ── Rebuild frontend ────────────────────────────────────────────────
log "Building frontend..."
cd "$REPO_DIR"
npm install --silent 2>&1 | tee -a "$LOG"
npm run build:shared 2>&1 | tee -a "$LOG"
npm --prefix frontend run build 2>&1 | tee -a "$LOG"

# ── Restart service ──────────────────────────────────────────────────
log "Restarting npmguard service..."
systemctl restart npmguard 2>&1 | tee -a "$LOG"
curl --fail --silent --retry 10 --retry-delay 1 http://127.0.0.1:8000/health \
  2>&1 | tee -a "$LOG"

log "=== Deploy complete ==="
