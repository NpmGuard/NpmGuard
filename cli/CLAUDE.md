# cli — CLAUDE.md

## Goal

`npmguard-cli` — terminal-first security gate in front of `npm install`. Queries the engine for audit verdicts, blocks/warns on dangerous packages, and triggers paid audits via Stripe or WalletConnect (Base Sepolia) when a package hasn't been audited yet.

Published as [`npmguard-cli`](https://www.npmjs.com/package/npmguard-cli) on npm.

## Commands

- `npmguard install <pkg>[@version] [--force]` — main command: lookup → gate → install
- `npmguard audit <pkg>[@version]` — standalone audit, no install
- `npmguard check [--path <dir>]` — walk `package.json`, check each dep against the audit DB

## Install flow

1. Resolve the version (`latest` via npmjs.org if omitted)
2. `GET /package/<name>/report?version=<v>` to look for an existing audit
3. Branch:
   - **Found + SAFE** → `<pm> add <pkg>` directly (auto-detects npm/pnpm/yarn from lockfiles)
   - **Found + DANGEROUS** → show findings + prompt y/N (or `--force`)
   - **Not found** → prompt: Stripe / WalletConnect / skip / cancel
4. **Stripe path** → delegates to `audit.ts` (`checkoutRaw` → QR → poll → SSE)
5. **WalletConnect path** → `readAuditFee` → `payViaWalletConnect` (QR, tx signing, receipt wait) → `startAuditWithTxHash` → `streamAuditEvents`
6. After the verdict, run the install if SAFE, or prompt otherwise

## Files

- `commands/install.ts` — the install cmd, Stripe + WalletConnect branches
- `commands/audit.ts` — standalone audit, also callable by install with `exit: false`
- `commands/check.ts` — walk package.json
- `wallet/walletconnect.ts` — WalletConnect v2 client, tx signing, receipt wait via viem
- `contract.ts` — ABI + deployed addresses for `NpmGuardAuditRequest`
- `stream.ts` — extracted SSE rendering, used by both `audit` and `install` crypto path
- `utils.ts` — `parsePackageArg`, `prompt` (readline), `resolveLatestVersion`, `detectPackageManager`
- `api.ts` — HTTP client for the engine (all endpoints)
- `render.ts` — terminal output helpers

## Gotchas

- **ESM only** — the package.json has `"type": "module"`. Never use `require()` — it crashes at runtime. Use `import` everywhere.
- **Do NOT depend on `@npmguard/shared`** — the CLI ships to npm with `"files": ["dist"]`, so it must be self-contained at publish time. A workspace dep would resolve locally but break when installed from the registry. Use inline event-narrowing here; the engine + frontend consume shared types, the CLI stays independent.
- **Package manager verb** — `yarn install <pkg>` ignores the arg and reinstalls the whole tree. Use `yarn add` / `pnpm add` / `npm install` depending on `detectPackageManager`.
- **Do not call `auditCommand` after `startAuditWithTxHash`** — `auditCommand` re-runs the full lookup + Stripe checkout flow, which would trigger a second unpaid audit and leak a Stripe session. Use `streamAuditEvents(auditId)` directly.
- **No private key in CLI** — the wallet signs and broadcasts. The CLI only reads the contract fee, encodes calldata, and observes receipts. Never introduce `process.env.PRIVATE_KEY` usage in this package.
- **RPC propagation lag** — the CLI uses public Base Sepolia RPC for `waitForTransactionReceipt`, which confirms a few seconds before Alchemy (engine side) sees the block. The engine already handles this via `waitForTransactionReceipt` with a 30s timeout; do not regress it back to `getTransactionReceipt`.

## Engine endpoints used

- `GET /package/:name/report?version=<v>` — lookup audit (returns null if not found)
- `POST /checkout` — create Stripe checkout session (`{ url, sessionId }`)
- `GET /checkout/:sessionId/status` — poll Stripe payment state
- `POST /audit/stream` — trigger audit. Payload variants:
  - `{ stripeSessionId }` — Stripe-paid
  - `{ packageName, version, txHash, chain }` — on-chain paid
- `GET /audit/:id/events` — SSE stream of audit progress (supports late-join replay)

## Release

```bash
npm version patch   # or minor / major
npm run build
npm publish --access public
```
