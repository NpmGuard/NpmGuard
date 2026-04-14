# CLAUDE.md

Read `README.md` first. Scope changes to one subproject. Each has its own `CLAUDE.md` with gotchas:

- [`cli/CLAUDE.md`](cli/CLAUDE.md) — package manager detection, ESM, WalletConnect flow, SSE streaming
- [`engine/CLAUDE.md`](engine/CLAUDE.md) — payment verification, chain config, report-store versioning
- [`contracts/README.md`](contracts/README.md) — Foundry setup, deploy + verify on Base Sepolia

## Rules

- Prefer configuration over new abstraction (especially for OpenAI-compatible LLM services).
- When a flow depends on on-chain state, verify external state (Basescan, receipt) before blaming code.
- Keep secrets out of logs, commits, and agent context. Never paste private keys into chats.
- The CLI package (`cli/`) must stay crypto-dep-minimal but cannot be fully crypto-free — it uses `viem` to encode calldata and wait for receipts, and `@walletconnect/sign-client` for session management. Never add a private-key path to the CLI: the wallet signs, the CLI observes.
- Payment verification is a trust boundary. Anything that gates audit execution must happen **server-side** in `engine/src/chain.ts` (or the Stripe equivalent), never in the CLI.
- Reports are stored on disk under `data/reports/<pkg>/<version>.json`. Keep `report-store.ts` as the single source of truth — do not reintroduce IPFS, ENS, or any external pinning service.
