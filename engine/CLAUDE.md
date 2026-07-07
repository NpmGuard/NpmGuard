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
- neither (dev mode only, requires `NPMGUARD_PAYMENT_REQUIRED=false`)

Anti-replay is tracked in `src/chain-payment-map.ts` (in-memory, keyed on `(chain, txHash)`). Stripe has its own dedup via `payment-map.ts`.

When adding a new chain:
1. Add env vars (`NPMGUARD_<CHAIN>_CONTRACT`, `NPMGUARD_<CHAIN>_RPC_URL`)
2. Wire it into `chain.ts:makeConfig()`
3. Extend the `SupportedChain` union in `chain.ts` and the `chain` zod enum in `routes/validation.ts:StreamAuditRequest`

## Route layout

`src/index.ts` is just the Hono app setup + CORS + subrouter mounts + `/api/*` mirror + static serving. Handlers live in `src/routes/`:

- `audit.ts` — `/audit`, `/audit/stream` (payment gate is inline by design — it's a trust contract), `/audit/:id/{events,file,report}`, plus the in-memory audit queue for the CRE sync path
- `payment.ts` — `/checkout`, `/checkout/:sessionId/status`, `/webhooks/stripe`, `/config/public`
- `demo.ts` — `/demo/*`
- `registry.ts` — `/packages`, `/package/:name/report`, `/resolve/:name`
- `auth.ts` — `/auth/github/{login,callback}`, `/auth/logout`, `/me` (GitHub App OAuth + DB sessions)
- `panel.ts` — `/panel/{orgs,repos,alerts}`, `/panel/repo/...` scan/protect/resync/detail, `/panel/scan/:id/events` (SSE)
- `gh-webhooks.ts` — `/webhooks/github` (App webhooks: installation, push)
- `validation.ts` — shared zod schemas (`PackageName`, `SemverVersion`, `AuditRequest`, `CheckoutRequest`, `StreamAuditRequest`)

Subrouters are mounted via `app.route("/", subrouter)`. Don't switch to prefix-mounting — the `/api/*` mirror rewrites by calling `app.fetch()`, which relies on everything being on one namespace.

## Repo panel (GitHub App)

Spec: `docs/specs/2026-07-07-github-repo-panel.md`. Everything is gated on
`GITHUB_APP_ENABLED` (all `NPMGUARD_GITHUB_*` vars + `NPMGUARD_ENCRYPTION_KEY`
set) — without it the engine runs exactly as before.

- **DB**: `data/npmguard.db` (better-sqlite3, WAL), migrations in
  `engine/migrations/NNN_*.sql` applied by `src/db.ts` via `user_version`.
  The DB stores everything that is *not* a report. `package_verdicts` is a
  **derived, rebuildable index** of `data/reports/` — report files stay the
  source of truth (kept in sync by the `setReportSavedHook` in report-store,
  rebuilt at boot).
- **Scans**: `src/scan/repo-scan.ts`. Progress and check conclusions compute
  from `scan_items`, never from `repo_deps` (delta scans don't touch the
  index; a push can move `repo_deps` under a live scan) and never from job
  ownership (jobs are deduped across scans by a partial unique index).
- **Jobs**: `src/jobs/` — durable queue, `NPMGUARD_SCAN_CONCURRENCY` workers,
  3 attempts, org round-robin. Stuck `running` jobs are requeued at boot.
- **Registry watch**: `src/watch/poller.ts` — ETag-polls every package used
  by a protected repo; new versions get audited proactively; watch audits are
  NOT charged to org budgets. `watched_packages` is re-synced after every
  index update — call `syncWatchedPackages()` if you add a new writer of
  `repo_deps`.
- **Check policy** (trust contract, spec §5.10): a GitHub check fails **only
  on DANGEROUS**. SUSPECT warns but passes. Don't make suspicion blocking.
- **Secrets**: user OAuth tokens are AES-256-GCM encrypted (`src/crypto.ts`).
  Installation tokens are minted on demand and never persisted. Never log
  either.

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
