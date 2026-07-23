# NpmGuard — Deployment Playbook

## Architecture

```
Internet (:80)
        │
      nginx            reverse proxy, SSL (certbot), rate limiting, security headers
        │
        ├─ /deploy-webhook ──► webhook-server.mjs (:9000)  ← GitHub push events
        │
        └─ everything else ──► node dist/index.js (:8000)  ← engine API + frontend static
                                      │
                                      └─ Docker (npmguard-verify)  ← sandbox execution
```

## Branches

| Branch | Purpose |
|--------|---------|
| `main` | Production — push triggers auto-deploy to server |
| `dev` | Development — work here, merge to `main` when ready to deploy |

**Workflow:** develop on `dev` (or feature branches off `dev`), merge to `main` to deploy.

## Deploy flow

```
git push origin main
        │
        ▼
GitHub webhook POST ──► nginx /deploy-webhook ──► webhook-server.mjs (:9000)
                                                        │
                                                        ▼
                                                pull-and-restart.sh
                                                  1. git pull origin main
                                                  2. npm install (engine + frontend)
                                                  3. npx tsc (engine build)
                                                  4. npx vite build (frontend build)
                                                  5. systemctl restart npmguard
```

Deploy logs: `/var/log/npmguard-deploy.log`

## Services (systemd)

| Service | Unit file | What it does |
|---------|-----------|-------------|
| `npmguard` | `/etc/systemd/system/npmguard.service` | Engine API on :8000 |
| `npmguard-webhook` | `/etc/systemd/system/npmguard-webhook.service` | Webhook listener on :9000 |
| `nginx` | system | Reverse proxy on :80/:443 |
| `docker` | system | Container runtime for sandbox |

### Common commands

```bash
# Status
systemctl status npmguard
systemctl status npmguard-webhook

# Logs
tail -f /var/log/npmguard.log             # engine logs
tail -f /var/log/npmguard-webhook.log     # webhook logs
tail -f /var/log/npmguard-deploy.log      # deploy script logs
journalctl -u nginx -f                    # nginx logs

# Restart
systemctl restart npmguard
systemctl restart npmguard-webhook
systemctl reload nginx

# Manual deploy (if webhook is down)
cd /root/NpmGuard && bash deploy/pull-and-restart.sh
```

## Server

- **IP:** 91.99.207.103
- **OS:** Ubuntu (DigitalOcean Droplet)
- **Node:** v22
- **Repo:** `/root/NpmGuard`

```bash
ssh root@91.99.207.103
```

## Initial server setup

```bash
ssh root@91.99.207.103
git clone git@github.com:NpmGuard/NpmGuard.git
cd NpmGuard
bash deploy/setup-droplet.sh
```

This runs 8 steps: system packages, Node.js 22, firewall (UFW), fail2ban, nginx, Docker, app build, webhook service.

## GitHub App (repo panel) setup

The repo panel (spec: `docs/specs/2026-07-07-github-repo-panel.md`) needs a
GitHub App registered under the NpmGuard org:

1. **Register** at github.com → Settings → Developer settings → GitHub Apps:
   - Homepage: `https://npmguard.com`
   - Callback URL: `https://npmguard.com/api/auth/github/callback`
   - Webhook URL: `https://npmguard.com/webhooks/github` + a fresh secret
     (`openssl rand -hex 32`). This is NpmGuard's *App* webhook — distinct
     from the deploy webhook on :9000 below.
   - Permissions: **Contents: read**, **Checks: write**, **Metadata: read**,
     Account → **Email addresses: read** (optional, for alert emails)
   - Events: **push**, **installation**, **installation repositories**
   - "Where can this app be installed?" → Any account
2. **Generate a private key**, copy it to the server (e.g.
   `/root/npmguard-github-app.pem`, mode 600 — outside the repo).
3. **Provision `engine/.env`:**

```bash
NPMGUARD_GITHUB_APP_ID=<app id>
NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH=/root/npmguard-github-app.pem
NPMGUARD_GITHUB_CLIENT_ID=<client id>
NPMGUARD_GITHUB_CLIENT_SECRET=<client secret>
NPMGUARD_GITHUB_WEBHOOK_SECRET=<webhook secret>
NPMGUARD_ENCRYPTION_KEY=$(openssl rand -hex 32)   # user tokens at rest
NPMGUARD_PANEL_BASE_URL=https://npmguard.com
# optional
NPMGUARD_SMTP_URL=smtp://user:pass@host:587       # DANGEROUS alert emails
NPMGUARD_ALERT_FROM="NpmGuard <alerts@npmguard.com>"
NPMGUARD_SCAN_CONCURRENCY=4
NPMGUARD_WATCH_INTERVAL_MIN=15
NPMGUARD_FREE_MAX_PROTECTED_REPOS=1
NPMGUARD_FREE_MAX_PUBLIC_REPO_AUDITS=1
NPMGUARD_FREE_MAX_AUDITS_MONTH=250
NPMGUARD_PRO_MAX_PROTECTED_REPOS=25
NPMGUARD_PRO_MAX_PUBLIC_REPO_AUDITS=0
NPMGUARD_PRO_MAX_AUDITS_MONTH=5000
```

All five required vars must be present or the engine boots with the panel
disabled (503 on `/auth/*` + `/panel/*`, warning in the log listing what's
missing). Panel state lives in `data/npmguard.db` (SQLite, WAL) — include it
in any backup that covers `data/reports/`. `better-sqlite3` is a native
module: deploys must run `npm install` with build tools present (already
covered by setup-droplet.sh).

## Stripe repository subscriptions

Repository plans are attached to a GitHub App installation, not to an
individual member. Free includes 3 protected repositories and 250 newly
audited package versions per calendar month by default. Cache hits do not use
the monthly allowance.

1. Create one recurring Stripe Price for the Pro plan.
2. Add its non-secret `price_...` identifier to `engine/.env`:

```bash
NPMGUARD_STRIPE_PRO_PRICE_ID=price_...
```

3. Keep the existing signed Stripe endpoint at
   `https://npmguard.com/webhooks/stripe` and enable these events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Restart `npmguard` after changing `engine/.env`.

Only Stripe states `active` and `trialing` unlock Pro. The signed webhook is
the authority; the browser return URL never grants an entitlement by itself.

## Webhook setup

### 1. Generate a secret on the server

```bash
openssl rand -hex 32
# Save this value — you'll need it in two places
```

### 2. Configure the systemd service

```bash
nano /etc/systemd/system/npmguard-webhook.service
# Set Environment=GITHUB_WEBHOOK_SECRET=<your-secret>

systemctl daemon-reload
systemctl enable --now npmguard-webhook
```

### 3. Update nginx (if not already done by setup-droplet.sh)

```bash
cp /root/NpmGuard/deploy/nginx/npmguard.conf /etc/nginx/sites-available/npmguard.com
nginx -t && systemctl reload nginx
```

### 4. Add webhook on GitHub

Go to **github.com/NpmGuard/NpmGuard → Settings → Webhooks → Add webhook**:

- **Payload URL:** `http://91.99.207.103/deploy-webhook`
- **Content type:** `application/json`
- **Secret:** the value from step 1
- **SSL verification:** Disable (traffic goes directly to the server IP, not through a domain with SSL)
- **Events:** Just the `push` event
- **Active:** checked

> **Note:** The domain `npmguard.com` goes through Cloudflare which causes 521 errors on webhooks. Use the IP directly. The HMAC secret secures the payload.

### 5. Test

```bash
# Push something to main
git push origin main

# Check the deploy log
ssh root@91.99.207.103 tail -f /var/log/npmguard-deploy.log
```

## Firewall

UFW is configured to only allow:

| Port | Protocol | Purpose |
|------|----------|---------|
| 22 | TCP (rate-limited) | SSH |
| 80 | TCP | HTTP (nginx) |
| 443 | TCP | HTTPS (nginx) |

Ports 8000 (engine) and 9000 (webhook) are **not exposed** — only accessible via nginx proxy.

## SSL

Managed by certbot with auto-renewal:

```bash
# Check certificate
certbot certificates

# Force renewal
certbot renew --force-renewal
```

## Troubleshooting

**Deploy didn't trigger:**

1. Check webhook delivery on GitHub (Settings → Webhooks → Recent Deliveries)
2. Check webhook listener: `systemctl status npmguard-webhook`
3. Check logs: `tail -20 /var/log/npmguard-webhook.log`

**Deploy triggered but failed:**

1. Check deploy log: `tail -50 /var/log/npmguard-deploy.log`
2. Look for npm install or build errors
3. Run manually: `cd /root/NpmGuard && bash deploy/pull-and-restart.sh`

**Site is down after deploy:**

1. Check engine: `systemctl status npmguard`
2. Check logs: `tail -50 /var/log/npmguard.log`
3. Check nginx: `nginx -t && systemctl status nginx`
4. Rollback: `cd /root/NpmGuard && git checkout HEAD~1 && bash deploy/pull-and-restart.sh`

**Concurrent deploy issue:**

The deploy script uses a lock file (`/tmp/npmguard-deploy.lock`). If a deploy hangs:

```bash
rm /tmp/npmguard-deploy.lock
```
