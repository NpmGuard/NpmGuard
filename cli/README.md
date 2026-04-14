# npmguard-cli

Security-gated npm install. Runs every package through NpmGuard's audit
engine before it touches your `node_modules`.

```bash
npx npmguard-cli install express
```

- **SAFE** → installs immediately
- **DANGEROUS** → warns, shows findings, asks before installing
- **No audit yet** → offers to pay for one (Stripe or crypto), then streams
  the results in real time

## Install

No install required — `npx` pulls the latest from npm:

```bash
npx npmguard-cli@latest install <pkg>
```

Or install globally:

```bash
npm install -g npmguard-cli
npmguard install <pkg>
```

## Commands

### `npmguard install <package>[@version]`

The main command. Runs the full gate-then-install flow.

```bash
npmguard install express
npmguard install lodash@4.17.21
npmguard install @types/node@22

# Force install even if the package is flagged DANGEROUS
npmguard install left-pad --force
```

The command auto-detects your package manager (`npm` / `pnpm` / `yarn`) from
lockfiles and runs the correct add command (`npm install`, `pnpm add`,
`yarn add`).

**Flow**:

1. Resolves the version (`latest` if omitted)
2. Asks the engine if the package has an existing audit
3. **Found + SAFE** → runs `<pm> add <pkg>` directly
4. **Found + DANGEROUS** → shows findings + capabilities, prompts `y/N`
   (bypass with `--force`)
5. **Not found** → asks how you want to pay for the audit:
   - Stripe (credit card) — browser checkout via QR
   - WalletConnect — mobile wallet signs a tx on Base Sepolia (~$0.30)
   - Install without audit (yolo)
   - Cancel
6. Streams audit events live (phases, findings, verdict)
7. Runs the install if the verdict is SAFE, or prompts otherwise

### `npmguard audit <package>[@version]`

Run a standalone audit without installing. Returns the verdict and exits.

```bash
npmguard audit is-number
npmguard audit express@5.2.1
```

Same payment flow as `install` if the package hasn't been audited yet.

### `npmguard check [--path <dir>]`

Walk `package.json` in the given directory and check every dependency
against NpmGuard's audit database. Useful for auditing an existing project.

```bash
cd my-project
npmguard check
# or
npmguard check --path /path/to/other-project
```

## Payment options

When a package hasn't been audited yet, an audit run costs real compute
(LLM calls, sandbox execution). Two ways to pay:

### Stripe (fiat)

Opens a Stripe checkout page in the browser. After payment, the engine
triggers the audit automatically. Works from any machine, no wallet
required.

### WalletConnect (crypto)

The CLI generates a WalletConnect v2 QR code in the terminal. Scan it with
any mobile wallet (MetaMask, Rainbow, Coinbase Wallet, etc.) and confirm
the transaction.

- **Chain**: Base Sepolia (testnet — free ETH from
  [Alchemy faucet](https://www.alchemy.com/faucets/base-sepolia))
- **Fee**: `0.0001 ETH` per audit
- **Contract**: [`0xBF562626e4Afb883423Ec719e0270DB232bcB9eD`](https://sepolia.basescan.org/address/0xbf562626e4afb883423ec719e0270db232bcb9ed)

Flow:

1. CLI reads the fee from the contract
2. You approve the tx in your wallet
3. Engine verifies the receipt on Base Sepolia via Alchemy
4. Audit starts, CLI streams events

The on-chain event `AuditRequested(packageName, version, requester, feePaid)`
acts as the payment proof. The engine decodes it and matches the args
against your request before launching the audit.

## Configuration

The CLI talks to `https://npmguard.com` by default. You can override the
API URL for local development:

```bash
# via flag
npmguard --api http://localhost:8000 install lodash

# via env
export NPMGUARD_API_URL=http://localhost:8000
npmguard install lodash
```

No blockchain config is required from the user — the CLI reads the
contract address + chain from its own code. Your wallet's RPC handles the
broadcast.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Audit passed, package installed |
| 1 | Audit failed / install aborted / network error |

## Dependencies

Intentionally minimal:

- `commander` — CLI arg parsing
- `chalk`, `ora`, `qrcode-terminal` — terminal UI
- `eventsource` — SSE client for audit events
- `viem` — read contract, encode calldata, wait for receipt
- `@walletconnect/sign-client` — WalletConnect v2 session

No private key handling in the CLI. The wallet signs and broadcasts; the
CLI only observes.

## Development

```bash
cd cli
npm install
npm run build

# Test against local engine
node dist/index.js --api http://localhost:8000 install is-number
```

## Release

```bash
npm version patch   # or minor / major
npm run build
npm publish --access public
```
