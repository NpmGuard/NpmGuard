# cli — CLAUDE.md

## Goal

CLI tool (`npmguard-cli`) that lets developers audit npm packages from the terminal. No crypto/ENS/IPFS — all audits go through the NpmGuard engine HTTP API.

## Commands

- `npmguard audit <package>[@version]` — pay for and run a security audit
- `npmguard check [--path ./project]` — check all dependencies of a project against existing audits

## Audit flow

1. User runs `npmguard audit express`
2. CLI calls `POST /checkout` → gets a Stripe Checkout URL
3. CLI displays the payment link (clickable in terminal) + QR code (fallback for SSH)
4. CLI polls `GET /checkout/:sessionId/status` until payment confirmed
5. Audit starts automatically, CLI streams results via SSE (`GET /audit/:id/events`)
6. CLI displays verdict (SAFE / DANGEROUS) with score and summary

## Tech

- TypeScript, ES modules
- Zero heavy deps — commander, chalk, ora, qrcode-terminal
- Talks to engine API at `https://npmguard.com` (configurable via `--api` flag or `NPMGUARD_API_URL` env)

## Engine endpoints used

- `POST /checkout` — create Stripe checkout session (returns `{ url }`)
- `GET /checkout/:sessionId/status` — poll payment status (TODO: add to engine, ~5 lines)
- `POST /audit/stream` — trigger audit with `{ stripeSessionId }` (returns `{ auditId }`, deduplicates with webhook)
- `GET /audit/:id/events` — SSE stream of audit progress (supports late-join replay)
