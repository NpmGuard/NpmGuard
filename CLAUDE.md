# CLAUDE.md

Read `README.md` first. Scope changes to one subproject. Each has its own `CLAUDE.md` with gotchas:

- [`cli/CLAUDE.md`](cli/CLAUDE.md) — package manager detection, ESM, WalletConnect flow, SSE streaming
- [`engine/CLAUDE.md`](engine/CLAUDE.md) — payment verification, chain config, report-store versioning
- [`contracts/README.md`](contracts/README.md) — Foundry setup, deploy + verify on Base Sepolia
- [`frontend/CLAUDE.md`](frontend/CLAUDE.md) — empty vs degraded states, the token layer, contract parsing
- [`bench/README.md`](bench/README.md) — pinned corpora, reproducibility identifiers, live-malware handling

## Start here to understand the system

- [`docs/architecture/AUDIT_CORE_EXPLAINED.md`](docs/architecture/AUDIT_CORE_EXPLAINED.md)
  — **the audit core, first principles, traced with a real recorded audit.**
  Everything else in the product is a consumer of this: the CLI, the web app, the
  GitHub panel, and the benchmark all differ only in *which* `(package, version)`
  pairs they ask about and who pays. Read this before anything else — and read
  **§24.0 before acting on anything in §24**: it is the per-finding status
  (fixed / tracked / superseded) and it records where §24's own analysis was
  wrong. Acting on a finding that has already been fixed is the mistake that
  section exists to prevent.
- [`docs/specs/2026-07-24-platform-v3-system-design.md`](docs/specs/2026-07-24-platform-v3-system-design.md)
  — the v3 platform design: requirements, entities, APIs, the architectural
  rework (R-1…R-7), the decisions log (D-1…D-9), and the phase plan. §8's goals
  table carries per-goal status against a named commit; §1 is a **dated
  snapshot** and is marked as such — do not read it as current state.

## Rules

- Prefer configuration over new abstraction (especially for OpenAI-compatible LLM services).
- When a flow depends on on-chain state, verify external state (Basescan, receipt) before blaming code.
- Keep secrets out of logs, commits, and agent context. Never paste private keys into chats.
- The CLI package (`cli/`) must stay crypto-dep-minimal but cannot be fully crypto-free — it uses `viem` to encode calldata and wait for receipts, and `@walletconnect/sign-client` for session management. Never add a private-key path to the CLI: the wallet signs, the CLI observes.
- Payment verification is a trust boundary. Anything that gates audit execution must happen **server-side** in `engine/npmguard/payments.py`, never in the CLI.
- Reports are stored on disk under `data/reports/<pkg>/<version>.json`. Keep `engine/npmguard/report_store.py` as the single source of truth — do not reintroduce IPFS, ENS, or any external pinning service.
- No ephemeral facts in the repo: no server IPs, hosting providers, deploy targets, or "currently running/deployed" status notes — they drift. Deploy material stays platform-agnostic (`deploy/README.md`); where things run lives outside the repo.
- Bench fixtures under `sandbox/test-fixtures/test-pkg-bench-dd-*` are live malware from the Datadog corpus. Never `npm install` or execute them outside the Docker sandbox; never commit them.
- `sandbox/` is deliberately **not** an npm workspace — its deps are installed at bench time so fixture installs can't reach the repo root.
