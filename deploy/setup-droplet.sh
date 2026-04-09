#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# NpmGuard — server provisioning
#
# Idempotent. Safe to re-run on an already-provisioned server.
#
#   scp -r . root@<IP>:/root/NpmGuard
#   ssh root@<IP> /root/NpmGuard/deploy/setup-droplet.sh
#
# Options:
#   NPMGUARD_DOMAIN   domain name         (default: npmguard.com)
#   SKIP_CERTBOT=1    skip SSL setup      (useful for testing)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -eEuo pipefail

# ── Paths & config ────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${NPMGUARD_DOMAIN:-npmguard.com}"
SKIP_CERTBOT="${SKIP_CERTBOT:-0}"
LOG_FILE="/var/log/npmguard-setup-$(date +'%Y%m%d-%H%M%S').log"

# ── Logging ───────────────────────────────────────────────────────────

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
log_warn() { echo -e "  ${YELLOW}!${NC} $1"; }
log_err()  { echo -e "  ${RED}✗${NC} $1"; }
step()     { echo -e "\n${GREEN}──${NC} $1"; }

exec > >(tee -a "$LOG_FILE") 2>&1

# ── Error trap ────────────────────────────────────────────────────────

on_error() {
  log_err "Failed at line $1. Log: $LOG_FILE"
  exit 1
}
trap 'on_error $LINENO' ERR

# ── Preflight checks ─────────────────────────────────────────────────

echo ""
echo "  NpmGuard Setup — $DOMAIN"
echo "  $(date)"
echo ""

[[ $EUID -ne 0 ]] && { log_err "Must run as root"; exit 1; }

source /etc/os-release 2>/dev/null || true
if [[ "${ID:-}" != "ubuntu" && "${ID:-}" != "debian" ]]; then
  log_warn "Tested on Ubuntu 22.04+. Detected: ${PRETTY_NAME:-unknown}. Proceeding anyway."
fi

avail=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
(( avail < 5 )) && { log_err "Less than 5 GB free disk space"; exit 1; }

[[ ! -f "$REPO_DIR/engine/package.json" ]] && { log_err "Repo not found at $REPO_DIR"; exit 1; }

log_ok "Preflight passed (${avail}G free, repo at $REPO_DIR)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Side-effect boundary — everything below modifies the system
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# ── 1. System packages ────────────────────────────────────────────────

step "[1/7] System packages"
apt-get update -qq
apt-get install -y -qq \
  curl nginx certbot python3-certbot-nginx \
  fail2ban ufw \
  > /dev/null 2>&1

# Docker — prefer docker-ce if already installed (e.g. from Docker's repo),
# fall back to docker.io from Ubuntu
if ! command -v docker &>/dev/null; then
  apt-get install -y -qq docker.io > /dev/null 2>&1
fi
log_ok "Installed"

# ── 2. Node.js 22 ────────────────────────────────────────────────────

step "[2/7] Node.js"
if node --version 2>/dev/null | grep -q "^v2[2-9]\|^v[3-9]"; then
  log_ok "Node $(node --version) already installed"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
  log_ok "Installed Node $(node --version)"
fi

# ── 3. Firewall ──────────────────────────────────────────────────────

step "[3/7] Firewall"
ufw default deny incoming > /dev/null 2>&1
ufw default allow outgoing > /dev/null 2>&1
ufw limit 22/tcp  > /dev/null 2>&1  # SSH (rate-limited)
ufw allow 80/tcp  > /dev/null 2>&1  # HTTP → HTTPS redirect + certbot
ufw allow 443/tcp > /dev/null 2>&1  # HTTPS
# Ports 8000, 3000, 2375, 2376 are intentionally NOT opened
ufw --force enable > /dev/null 2>&1
log_ok "UFW: $(ufw status | grep -cE 'ALLOW|LIMIT') rules active"

# ── 4. fail2ban ──────────────────────────────────────────────────────

step "[4/7] fail2ban"
cat > /etc/fail2ban/jail.local << 'EOF'
[sshd]
enabled  = true
port     = ssh
filter   = sshd
logpath  = /var/log/auth.log
maxretry = 5
bantime  = 3600
findtime = 600

[nginx-req-limit]
enabled  = true
port     = http,https
filter   = nginx-limit-req
logpath  = /var/log/nginx/error.log
maxretry = 5
bantime  = 600
EOF
systemctl enable fail2ban > /dev/null 2>&1
systemctl restart fail2ban
log_ok "Jails: sshd, nginx-req-limit"

# ── 5. Nginx ─────────────────────────────────────────────────────────

step "[5/7] Nginx"

# Harden defaults (idempotent — sed is a no-op if already applied)
sed -i 's/# server_tokens off;/server_tokens off;/'                                   /etc/nginx/nginx.conf
sed -i 's/ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3;/ssl_protocols TLSv1.2 TLSv1.3;/' /etc/nginx/nginx.conf

cp "$REPO_DIR/deploy/nginx/rate-limit.conf" /etc/nginx/conf.d/rate-limit.conf
cp "$REPO_DIR/deploy/nginx/npmguard.conf"   /etc/nginx/sites-available/npmguard.com
ln -sf /etc/nginx/sites-available/npmguard.com /etc/nginx/sites-enabled/npmguard.com
rm -f /etc/nginx/sites-enabled/default

nginx -t 2>&1 && systemctl reload nginx
log_ok "Config from deploy/nginx/, hardened TLS"

# SSL
if [[ "$SKIP_CERTBOT" == "1" ]]; then
  log_warn "SKIP_CERTBOT=1, skipping SSL"
else
  certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" \
    --non-interactive --agree-tos --register-unsafely-without-email 2>&1 || {
    log_warn "Certbot failed — run manually: certbot --nginx -d $DOMAIN -d www.$DOMAIN"
  }
fi

# ── 6. Docker ────────────────────────────────────────────────────────

step "[6/8] Docker"
systemctl enable docker > /dev/null 2>&1

docker pull node:22-slim 2>&1 | tail -1
log_ok "Pulled node:22-slim"

if [[ -f "$REPO_DIR/engine/Dockerfile.verify" ]]; then
  (cd "$REPO_DIR/engine" && docker build -q -t npmguard-verify -f Dockerfile.verify .) \
    && log_ok "Built npmguard-verify" \
    || log_warn "Failed to build npmguard-verify — test verification will be skipped"
fi

# ── 7. App build ─────────────────────────────────────────────────────

step "[7/8] App build"
cd "$REPO_DIR"

(cd engine   && npm install --silent)
(cd frontend && npm install --silent)
log_ok "Dependencies installed"

(cd frontend && npx vite build 2>&1 | tail -3)
(cd engine   && npx tsc)
log_ok "Frontend + engine built"

# .env — create template only if missing, never overwrite existing
if [[ ! -f engine/.env ]]; then
  cp engine/.env.template engine/.env 2>/dev/null || cat > engine/.env << 'ENVEOF'
# Server
NPMGUARD_API_HOST=0.0.0.0
NPMGUARD_API_PORT=8000

# LLM backend
NPMGUARD_LLM_BACKEND=openai_compatible
NPMGUARD_LLM_BASE_URL=https://openrouter.ai/api/v1
NPMGUARD_LLM_API_KEY=REPLACE_ME

# Per-phase models
NPMGUARD_TRIAGE_MODEL=deepseek/deepseek-v3.2
NPMGUARD_INVESTIGATION_MODEL=z-ai/glm-5
NPMGUARD_TEST_GEN_MODEL=z-ai/glm-5

# Stripe
NPMGUARD_STRIPE_SECRET_KEY=REPLACE_ME
NPMGUARD_STRIPE_WEBHOOK_SECRET=REPLACE_ME
NPMGUARD_AUDIT_PRICE_CENTS=400

# CORS
NPMGUARD_CORS_ORIGIN=https://REPLACE_ME
ENVEOF
  log_warn "Created engine/.env — fill in API keys before starting"
else
  log_ok "engine/.env exists, not overwriting"
fi
chmod 600 engine/.env

# ── 8. Webhook auto-deploy ──────────────────────────────────────────

step "[8/8] Webhook auto-deploy"

chmod +x "$REPO_DIR/deploy/pull-and-restart.sh"
cp "$REPO_DIR/deploy/npmguard-webhook.service" /etc/systemd/system/npmguard-webhook.service
systemctl daemon-reload
systemctl enable npmguard-webhook > /dev/null 2>&1

if grep -q "REPLACE_ME" /etc/systemd/system/npmguard-webhook.service; then
  log_warn "Webhook service installed but GITHUB_WEBHOOK_SECRET not set"
  log_warn "  1. Generate a secret:  openssl rand -hex 32"
  log_warn "  2. Edit /etc/systemd/system/npmguard-webhook.service"
  log_warn "  3. systemctl daemon-reload && systemctl restart npmguard-webhook"
  log_warn "  4. Add webhook on GitHub: https://npmguard.com/deploy-webhook"
else
  systemctl restart npmguard-webhook
  log_ok "Webhook listener running on :9000"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
echo -e "${GREEN}  Setup complete.${NC}  Log: $LOG_FILE"
echo ""

if grep -q "REPLACE_ME" engine/.env 2>/dev/null; then
  echo "  Next:"
  echo "    vi $REPO_DIR/engine/.env   # fill in API keys"
  echo "    cd $REPO_DIR && ./run.sh"
else
  echo "  Start:"
  echo "    cd $REPO_DIR && ./run.sh"
fi
echo ""
