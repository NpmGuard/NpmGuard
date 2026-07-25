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

## Comments and prose

A comment earns its place by carrying what the reader **cannot get from the code
and that stays true**. Two questions, and it must pass both:

1. Could I learn this by reading the code beside it? → delete it.
2. Will this still be true in six months without anyone maintaining it? → if no,
   delete it or restate it as the rule it implies.

**Keep:** invariants; the failure a guard exists to prevent; a measured number
that sizes a constant; trust boundaries; why the obvious alternative is wrong.

**Cut, every time:**

- *Archaeology.* "used to", "previously", "the old X", "this replaces", "was a
  FINDING", "what the recomposition changed", "N was removed in R-1". The reader
  is looking at the current code; the diff is in git.
- *Change-log headers.* Dated pass narratives (`Adversarial pass: 2026-07-23/W6 — …`)
  above a test's CLASS MAP. The map says what each class pins; that is the durable
  half. How the file grew is not.
- *Status.* "not yet", "landed", "Phase 2 migrates to this", "tracked", counts of
  what is fixed. Status is false the moment it is true.
- *Drifting citations.* `service.py:184, :246`, `dist/index.mjs:154`, "31 committed
  artifacts", bare requirement IDs (`R-1`, `N-3`, `F-G7`) the reader has no
  document for. Name the module, or state the substance.

**The rewrite move** is almost always tense, not deletion — the *fact* under the
archaeology is usually the load-bearing part:

> ~~the dead `sin_addr="…"` regex returned addr=None on every inet connect ever
> captured and looked exactly like "no address available"~~
> → returning addr=None shows the judge `connect socket` for a named endpoint,
> which is indistinguishable from "no address available"

Keep a measurement when it justifies a choice, as a ratio rather than a corpus
count that moves: "~14% of real `bin` targets ship extensionless", not "13 of 94".

This applies to `CLAUDE.md`, `README.md` and every comment and docstring. It is
the same rule as "no ephemeral facts in the repo" above, one level down.
