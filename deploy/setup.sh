#!/usr/bin/env bash
# NpmGuard server setup — installs nginx config and prompts for SSL.
# Run as root on a fresh Ubuntu/Debian server.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NGINX_SRC="$SCRIPT_DIR/nginx/npmguard.conf"
NGINX_DEST="/etc/nginx/sites-available/npmguard.com"
NGINX_LINK="/etc/nginx/sites-enabled/npmguard.com"

if [[ $EUID -ne 0 ]]; then
  echo "Error: run as root (sudo $0)" >&2
  exit 1
fi

# Install nginx if missing
if ! command -v nginx &>/dev/null; then
  echo "[setup] Installing nginx..."
  apt-get update -qq && apt-get install -y -qq nginx
fi

# Copy config
echo "[setup] Installing nginx config -> $NGINX_DEST"
cp "$NGINX_SRC" "$NGINX_DEST"

# Symlink into sites-enabled (remove default if present)
rm -f /etc/nginx/sites-enabled/default
ln -sf "$NGINX_DEST" "$NGINX_LINK"

# Test
echo "[setup] Testing nginx config..."
nginx -t

# SSL
if ! command -v certbot &>/dev/null; then
  echo "[setup] Installing certbot..."
  apt-get install -y -qq certbot python3-certbot-nginx
fi

echo ""
echo "Nginx config installed. Next steps:"
echo "  1. Run: certbot --nginx -d npmguard.com -d www.npmguard.com"
echo "  2. Run: systemctl reload nginx"
echo "  3. Start the app: ./run.sh"
