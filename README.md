# NpmGuard

Autonomous npm supply chain security auditor. Runs npm packages through a
multi-step LLM + sandbox security pipeline and publishes verdicts via a
public API — plus a CLI that gates `npm install` behind those verdicts.

Users install packages with `npx npmguard-cli install express`. If the
package already has an audit → install happens immediately (or is blocked
if DANGEROUS). If not → the user pays for an audit with a credit card
(Stripe), a browser wallet (MetaMask/Rabby), or a mobile wallet
(WalletConnect on Base Sepolia), the pipeline runs, and the verdict
decides whether the install proceeds. SAFE packages install from an ENS
announced Pinata tarball by default when publication is available; the CLI
falls back to npm only when no publication exists yet or when explicitly
configured.

## How it works

```mermaid
flowchart TD
    subgraph CLI["Developer"]
        U[npmguard install express]
    end

    subgraph LOOKUP["Lookup"]
        GET[GET /package/express/report]
        GET -->|SAFE| SAFE_INSTALL[Install from npm / Pinata / ENS]
        GET -->|DANGEROUS| WARN[Warn + prompt y/N]
        GET -->|not found| PAY
    end

    subgraph PAY["Pay for audit"]
        PAY[Stripe or crypto wallet?]
        PAY -->|Stripe| STRIPE[Stripe Checkout<br/>card payment]
        PAY -->|Browser wallet| BROWSER_WALLET[Open npmguard.com/pay<br/>sign with MetaMask/Rabby]
        PAY -->|WalletConnect| WC[Scan QR with mobile wallet<br/>sign tx on Base Sepolia<br/>0.0001 ETH]
    end

    subgraph VERIFY["Engine verification"]
        STRIPE --> STRIPE_VERIFY[Verify Stripe session]
        BROWSER_WALLET --> CHAIN_VERIFY[Verify tx receipt<br/>via Alchemy Base Sepolia]
        WC --> CHAIN_VERIFY
        STRIPE_VERIFY --> PIPELINE
        CHAIN_VERIFY --> PIPELINE
    end

    subgraph PIPELINE["Audit pipeline"]
        INVENTORY[Phase 0: Inventory<br/>tarball structural triage]
        TRIAGE[Phase 1a: LLM risk scoring]
        INVESTIGATE[Phase 1b: Agentic investigation]
        TESTGEN[Phase 1c: Exploit test generation]
        SANDBOX[Phase 2: Docker sandbox execution]
        INVENTORY --> TRIAGE
        TRIAGE -->|low risk| VERDICT
        TRIAGE -->|high risk| INVESTIGATE --> TESTGEN --> SANDBOX --> VERDICT
        VERDICT{Verdict}
    end

    U --> GET
    PIPELINE -->|persist| DB[(data/reports/<br/>pkg/version.json)]
    PIPELINE -->|optional publish| STORE[(Pinata tarball + manifest<br/>ENS text records)]
    VERDICT -->|SAFE| SAFE_INSTALL
    VERDICT -->|DANGEROUS| WARN
    WARN -->|force| SAFE_INSTALL

    style CLI fill:#fff3cd,stroke:#ffc107,color:#000
    style LOOKUP fill:#d4edda,stroke:#28a745,color:#000
    style PAY fill:#cce5ff,stroke:#0d6efd,color:#000
    style VERIFY fill:#fce5ff,stroke:#a855f7,color:#000
    style PIPELINE fill:#e8daef,stroke:#8e44ad,color:#000
```

## Live Services

| Service | URL |
|---|---|
| Frontend Dashboard | [https://npmguard.com](https://npmguard.com) |
| Audit Engine API | [https://npmguard.com/health](https://npmguard.com/health) |
| CLI on npm | [`npmguard-cli`](https://www.npmjs.com/package/npmguard-cli) |
| Audit Contract (Base Sepolia) | [`0xBF56...B9eD`](https://sepolia.basescan.org/address/0xbf562626e4afb883423ec719e0270db232bcb9ed) |

## Quick Start

### Install a package with NpmGuard

```bash
npx npmguard-cli install express
```

- If an audit exists and the verdict is **SAFE**, it installs immediately
- If **DANGEROUS**, it warns and asks before installing (or `--force`)
- If there's no audit yet, you get a menu:
  1. **Stripe** — pay by card in the browser
  2. **Browser wallet** — open `npmguard.com/pay`, connect MetaMask/Rabby,
     and sign a `0.0001 ETH` transaction on **Base Sepolia**
  3. **WalletConnect** — scan a QR from your mobile wallet, sign a
     `0.0001 ETH` transaction on **Base Sepolia**
  4. Install without audit
  5. Cancel

After payment, the audit runs end-to-end. Stripe and WalletConnect stream
events in the terminal; the browser-wallet flow shows the live audit in the
web app while the CLI waits for the persisted report.

The audit and install steps are deliberately separate:

1. **Resolve** the concrete npm tarball and extract package metadata.
2. **Inventory** files, lifecycle scripts, entry points, dependency surface,
   and structural dealbreakers.
3. **Triage** source files with the configured OpenAI-compatible model and
   produce hypotheses/capabilities.
4. **Investigate** suspicious hypotheses with an agentic pass when static
   risk warrants deeper analysis.
5. **Generate and run proof tests** in the sandbox for high-risk findings.
6. **Persist the verdict** under `data/reports/<pkg>/<version>.json`.
7. **Publish demo artefacts** best-effort when configured: report JSON,
   installable package tarball, optional package folder, manifest, and ENS
   `npmguard.*` records on the package subdomain when ENS v2 is available.
   Publication failure never changes the verdict.

Install source is a CLI policy decision after the server verdict:

```bash
npx npmguard-cli@latest install express --install-source auto
npx npmguard-cli@latest install express --install-source npm
npx npmguard-cli@latest install express --install-source pinata
npx npmguard-cli@latest install express --install-source ens
```

`auto` is the default: after a SAFE verdict it waits briefly for publication,
then tries ENS text records, then the NpmGuard storage API, and finally npm
as a fallback. `pinata` asks the NpmGuard API for the stored tarball URL.
`ens` resolves Sepolia ENS text records such as `npmguard.tarball_uri` /
`npmguard.latest_tarball_uri`, then installs that Pinata tarball.

See [cli/README.md](cli/README.md) for the full CLI reference.

### Audit a project's dependencies

```bash
cd my-project
npx npmguard-cli check
```

Walks `package.json` and reports every dependency's audit status.

### Query the API directly

```bash
curl https://npmguard.com/package/express/report
```

```bash
curl -X POST https://npmguard.com/audit \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"express","version":"5.2.1"}'
```

## Payment — Base Sepolia contract

The audit engine is gated behind a small payment so that the LLM and
sandbox compute is paid for. Three options are live:

### Stripe
Existing Stripe Checkout flow. The engine has a webhook that marks the
session paid and triggers the audit.

### Browser wallet (on Base Sepolia)
The CLI can print and open a `https://npmguard.com/pay?...` URL. The user
connects MetaMask/Rabby in Brave or Chrome, signs
`NpmGuardAuditRequest.requestAudit(pkg, version)`, and the web app submits
the tx hash to the engine.

### WalletConnect (on Base Sepolia)
Users sign a transaction to `NpmGuardAuditRequest.requestAudit(pkg, version)`
which emits an `AuditRequested` event. The engine verifies the receipt via
a dedicated Alchemy Base Sepolia RPC and decodes the event to match the
requested `(packageName, version)` before running the audit.

- **Fee**: `0.0001 ETH` (set in contract constructor, updatable by owner)
- **Chain**: Base Sepolia (chain id 84532)
- **Contract**: [`0xBF562626e4Afb883423Ec719e0270DB232bcB9eD`](https://sepolia.basescan.org/address/0xbf562626e4afb883423ec719e0270db232bcb9ed)

Anti-replay: the engine maintains a `(chain, txHash)` dedup map so a single
payment can only launch one audit. The contract itself also prevents
double-payment for the same `(pkg, version)` pair.

See [contracts/README.md](contracts/README.md) for the contract source,
tests, and deploy instructions (Foundry).

## Project Structure

| Directory | Description |
|---|---|
| `cli/` | `npmguard-cli` — the user-facing CLI (`install`, `audit`, `check`) |
| `engine/` | Audit pipeline — TypeScript + Hono, stores reports in `data/reports/` |
| `frontend/` | React + Vite dashboard — live audit streaming via SSE |
| `contracts/` | `NpmGuardAuditRequest.sol` + Foundry tests + deploy scripts |
| `sandbox/` | Dynamic exploitation harness (Vitest) |
| `deploy/` | Systemd units, nginx config, webhook listener, deploy script |
| `docs/` | Architecture docs, research notes, production guides |

## Run locally

```bash
bash run.sh
# Engine on :8000, Frontend on :3000
```

Or individually:

```bash
cd engine && npm install && npx tsx src/index.ts   # API on :8000
cd frontend && npm install && npm run dev           # UI on :3000
```

Testing the CLI against local engine:

```bash
cd cli && npm install && npm run build
node dist/index.js --api http://localhost:8000 install is-number
```

## Deploy

Production runs on a single DigitalOcean droplet (209.38.42.28):

- `npmguard.service` — the Hono engine on `:8000`
- `npmguard-webhook.service` — GitHub push webhook listener on `127.0.0.1:9000`
- nginx reverse proxy with Let's Encrypt (`npmguard.com`)
- Cloudflare in front of `npmguard.com`; `/deploy-webhook` accessed via
  raw IP to bypass Cloudflare (GitHub webhook only)

The webhook receives pushes to `main`, validates the HMAC-SHA256
signature, and spawns `deploy/pull-and-restart.sh` which pulls, runs
`npm install && tsc`, and restarts systemd services.

Full playbook: [docs/ops/DEPLOYMENT_PLAYBOOK.md](docs/ops/DEPLOYMENT_PLAYBOOK.md)

## Tech Stack

| Component | Technology |
|---|---|
| Frontend | [React](https://react.dev/) + [Vite](https://vite.dev/) + [Tailwind](https://tailwindcss.com/) — real-time SSE dashboard |
| Audit pipeline | TypeScript + [Hono](https://hono.dev/) — inventory, LLM static analysis, Docker sandbox |
| LLM | [DeepSeek V4 Flash](https://openrouter.ai/deepseek/deepseek-v4-flash) via OpenRouter (OpenAI-compatible) |
| Fiat payment | [Stripe](https://stripe.com/) checkout + webhook |
| Crypto payment | Solidity contract on [Base Sepolia](https://docs.base.org/chain/base-contracts) + WalletConnect v2 |
| Contract tooling | [Foundry](https://book.getfoundry.sh/) — compile, test (fuzz), deploy, Basescan verification |
| Chain RPC | [Alchemy](https://alchemy.com/) Base Sepolia (+ public fallback) |
| Storage | Local filesystem (`data/reports/<pkg>/<version>.json`) as source of truth, with optional Pinata + ENS publication for demos |
| CLI | TypeScript, zero blockchain deps in the binary — wallet signs, engine verifies |
| Hosting | [DigitalOcean](https://www.digitalocean.com/) + nginx + Let's Encrypt |

## Team

See the repo contributors.
