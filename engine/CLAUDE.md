# engine — CLAUDE.md

- TypeScript + Vercel AI SDK. Run `npm install` then `npx tsx src/index.ts`.
- `.env` is runtime config. All vars prefixed `NPMGUARD_`.
- Reports persist to `data/reports/<pkg>/<version>.json` via `report-store.ts`. Keyed by the **real** version extracted from the tarball metadata, not the requested version. Do not reintroduce `"latest"` fallbacks in save paths.

## Run

```bash
npm install
npx tsx src/index.ts              # dev server on :8000
npm run build && npm start        # production
```

## Payment gate

`/audit/stream` accepts three proofs:

- `stripeSessionId` — verified via the Stripe API
- `txHash` + `chain` — verified via `src/chain.ts` (Alchemy Base Sepolia / mainnet), decodes `AuditRequested` event and matches `(packageName, version)`
- neither (dev mode only, requires `PAYMENT_ENABLED=false`)

Anti-replay is tracked in `src/chain-payment-map.ts` (in-memory, keyed on `(chain, txHash)`). Stripe has its own dedup via `payment-map.ts`.

When adding a new chain:
1. Add env vars (`NPMGUARD_<CHAIN>_CONTRACT`, `NPMGUARD_<CHAIN>_RPC_URL`)
2. Wire it into `chain.ts:makeConfig()`
3. Extend the `SupportedChain` union and the zod enum in `index.ts:StreamAuditRequest`

## Test

```bash
# Inventory only (no LLM, no Docker)
NPMGUARD_INVESTIGATION_ENABLED=false curl -X POST http://localhost:8000/audit \
  -H 'Content-Type: application/json' -d '{"packageName": "test-pkg-env-exfil"}'

# Full pipeline (needs LLM key + Docker)
curl -X POST http://localhost:8000/audit \
  -H 'Content-Type: application/json' -d '{"packageName": "test-pkg-env-exfil"}'

# On-chain payment path (requires NPMGUARD_BASE_SEPOLIA_CONTRACT + valid txHash)
curl -X POST http://localhost:8000/audit/stream \
  -H 'Content-Type: application/json' \
  -d '{"packageName":"is-number","version":"7.0.0","txHash":"0x...","chain":"base-sepolia"}'
```
