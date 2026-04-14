# Engine

TypeScript audit pipeline — inventory, LLM static analysis, agentic investigation, and sandbox execution. Also serves the `/audit/stream` endpoint that CLI users hit after paying via Stripe or WalletConnect (Base Sepolia).

## Prerequisites

- Node.js 20+
- Docker (for sandbox execution)
- OpenAI-compatible LLM provider (OpenRouter by default)
- Alchemy Base Sepolia key (for on-chain payment verification)

## Installation

```bash
npm install
```

## Usage

```bash
npx tsx src/index.ts              # dev server on :8000
npm run build && npm start        # production
```

Trigger an audit directly:

```bash
curl -X POST http://localhost:8000/audit \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"serialize-javascript"}'
```

Trigger via the payment-gated streaming endpoint (what the CLI uses):

```bash
# Crypto path — engine verifies the tx receipt + AuditRequested event on-chain
curl -X POST http://localhost:8000/audit/stream \
  -H 'Content-Type: application/json' \
  -d '{
    "packageName":"is-number",
    "version":"7.0.0",
    "txHash":"0x...",
    "chain":"base-sepolia"
  }'

# Stripe path — engine verifies the checkout session
curl -X POST http://localhost:8000/audit/stream \
  -H 'Content-Type: application/json' \
  -d '{"stripeSessionId":"cs_test_..."}'
```

Health check at `http://localhost:8000/health`.

## Payment verification

The engine accepts two payment proofs on `/audit/stream`:

1. **`stripeSessionId`** — looked up via the Stripe API, then cross-checked against the webhook-recorded session.
2. **`txHash` + `chain`** — fetched via viem's `waitForTransactionReceipt` on an Alchemy Base Sepolia endpoint, then the `AuditRequested` event is decoded and the `(packageName, version)` args are matched against the request.

Dedup:
- Stripe: keyed on `stripeSessionId`
- On-chain: keyed on `(chain, txHash)` — a single tx can only ever trigger one audit

The chain verification lives in [`src/chain.ts`](src/chain.ts) and the in-memory dedup in [`src/chain-payment-map.ts`](src/chain-payment-map.ts).

## Analysis Pipeline

See [`docs/architecture-v2.md`](../docs/architecture-v2.md) for the full pipeline design.

```
npm package → Phase 0: Inventory → Phase 1a: Triage → Phase 1b: Investigation → Phase 1c: Test gen → Phase 2: Sandbox → AuditReport
```

Reports are persisted to `data/reports/<pkg>/<version>.json`, keyed by the real version extracted from the tarball's `package.json` (not the value the user requested).

## Configuration

Settings are loaded from environment variables with the `NPMGUARD_` prefix (or a `.env` file):

| Variable | Default | Description |
|---|---|---|
| `NPMGUARD_API_HOST` | `0.0.0.0` | API listen host |
| `NPMGUARD_API_PORT` | `8000` | API listen port |
| `NPMGUARD_LLM_BACKEND` | `anthropic` | LLM backend: `anthropic` or `openai_compatible` |
| `NPMGUARD_LLM_MODEL` | — | LLM model (per-phase overrides below) |
| `NPMGUARD_LLM_BASE_URL` | _(unset)_ | OpenAI-compatible endpoint |
| `NPMGUARD_LLM_API_KEY` | _(unset)_ | API key for OpenAI-compatible backend |
| `NPMGUARD_LLM_TIMEOUT_SECONDS` | `60` | Request timeout for LLM calls |
| `NPMGUARD_TRIAGE_MODEL` | `claude-haiku-4-5-20251001` | Model for triage phase |
| `NPMGUARD_TRIAGE_RISK_THRESHOLD` | `3` | Risk score below this skips investigation |
| `NPMGUARD_INVESTIGATION_MODEL` | `claude-sonnet-4-6` | Model for investigation phase |
| `NPMGUARD_INVESTIGATION_ENABLED` | `true` | Set `false` to skip LLM investigation |
| `NPMGUARD_MAX_AGENT_TURNS` | `30` | Max tool-call turns for investigation agent |
| `NPMGUARD_TEST_GEN_MODEL` | `claude-sonnet-4-6` | Model for test generation |
| `NPMGUARD_SANDBOX_IMAGE` | `node:22-slim` | Docker image for sandbox |
| `NPMGUARD_SANDBOX_MEMORY_MB` | `512` | Sandbox memory limit |
| `NPMGUARD_SANDBOX_CPUS` | `1` | Sandbox CPU quota |
| `NPMGUARD_SANDBOX_NETWORK` | `none` | Sandbox network mode |
| `NPMGUARD_STRIPE_SECRET_KEY` | _(unset)_ | Stripe secret key for checkout sessions |
| `NPMGUARD_STRIPE_WEBHOOK_SECRET` | _(unset)_ | Stripe webhook signing secret |
| `NPMGUARD_BASE_SEPOLIA_CONTRACT` | _(unset)_ | `NpmGuardAuditRequest` address on Base Sepolia |
| `NPMGUARD_BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` | RPC URL for Base Sepolia (Alchemy recommended) |
| `NPMGUARD_BASE_CONTRACT` | _(unset)_ | `NpmGuardAuditRequest` address on Base mainnet |
| `NPMGUARD_BASE_RPC_URL` | `https://mainnet.base.org` | RPC URL for Base mainnet |

If neither `NPMGUARD_BASE_SEPOLIA_CONTRACT` nor `NPMGUARD_BASE_CONTRACT` is set, `/audit/stream` with `txHash` returns `501 "chain not configured"`. Stripe continues to work regardless.

## Deploy to DigitalOcean

Production runs on a DigitalOcean droplet behind nginx + Let's Encrypt, with a systemd-managed engine and a separate systemd-managed GitHub webhook listener. See [`../docs/DEPLOYMENT_PLAYBOOK.md`](../docs/DEPLOYMENT_PLAYBOOK.md) and [`../deploy/`](../deploy/) for the full setup.

High-level:

1. **Droplet** — Ubuntu 22+ with Docker installed. Size: 2 GB / 1 CPU minimum.
2. **Initial setup** — run `bash ../deploy/setup-droplet.sh` to install Node, nginx, certbot, and register systemd units.
3. **`.env`** — copy `.env.template` and fill in LLM, Stripe, and Alchemy keys. `NPMGUARD_BASE_SEPOLIA_CONTRACT` must be the address from the latest Foundry deploy (see [`../contracts/README.md`](../contracts/README.md)).
4. **Auto-deploy** — pushes to `main` hit `/deploy-webhook` (raw IP, bypassing Cloudflare), which triggers `deploy/pull-and-restart.sh` → `git pull` → `npm install` → `tsc` → `systemctl restart npmguard`.

### Manual deploy

```bash
cd /root/NpmGuard
git pull origin main
cd engine
npm install
npm run build
systemctl restart npmguard
```

### Check health

```bash
curl https://npmguard.com/health
# {"status":"ok"}
```

### Logs

```bash
journalctl -u npmguard -f              # engine logs
journalctl -u npmguard-webhook -f      # webhook listener logs
```
