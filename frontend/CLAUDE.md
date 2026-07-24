# frontend — CLAUDE.md

React 19 + Vite + plain CSS (keyline design language) + Zustand + CodeMirror 6 +
react-router. **No Tailwind. Light-mode only.** Read `../.claude/worktrees/frontend-v2/frontend/DESIGN.md`
(the keyline design guide) before touching styles. This app is built against the
**dev / Python engine** — its wire contract differs from the old TS engine (see
Gotchas).

## Run

```bash
# from the repo ROOT (npm workspace — installing in this subdir acts on root;
# binaries hoist to <repo>/node_modules/.bin, NOT frontend/node_modules/.bin):
npm install

cd frontend
npm run dev        # :3000, proxies /api/* → engine :8000 (VITE_API_TARGET overrides)
npm run build      # tsc -b && vite build → dist/ (the engine serves this in prod)
npm run typecheck  # tsc -b --noEmit
npm test           # vitest units — clone-and-run, nothing running
npm run test:e2e   # Playwright boots the REAL Python engine (uvicorn :8055, demo mode) + vite :3100
npm run gate       # typecheck && test && test:e2e
```

## Architecture (the spine — do not re-derive stream state in components)

- `src/lib/engine-types.ts` — the wire contract, hand-written **from evidence**
  (the engine's route/emit code + `shared/contract/contract.schema.json`), NOT
  imported from `@npmguard/shared`. Engine contract change ⇒ this file changes.
- `src/lib/audit-fold.ts` — the **pure** SSE reducer `foldAuditEvent`. All
  audit-stream state transitions live here (one `switch(event.type)`) — never in
  components, never inline in the store. Idempotent under cursor replay (dedup by
  `seq`); tolerates unknown/dead event types (never throws).
- `src/lib/sse.ts` — the audit stream: **named** SSE events (one listener per
  type; `onmessage` never fires). Reconnect resumes from a seq cursor (native
  `EventSource` sends `Last-Event-ID`; engine also accepts `?since=`). The
  EventSource ctor + backoff are injectable for tests.
- `src/lib/api.ts` / `src/lib/api-base.ts` — one typed fn per engine route;
  errors are `ApiError{status, body}`; branch on `status`, never on message text.
- `src/stores/auditStore.ts` — thin shell: SSE connection lifecycle, start
  orchestration (free/demo/Stripe/crypto), file fetch, post-verdict report
  hydration. No fold logic here.
- `src/lib/report-helpers.ts` — pure helpers over the schemaVersion-2 report.
- `src/lib/wallet.ts` — injected-wallet (window.ethereum) crypto payment. The
  wallet signs; the engine verifies. No private-key path may ever exist here.
- `src/styles/base.css` — tokens + primitives (single source of design truth),
  reused verbatim from keyline. One sheet per cluster/page
  (`audit|report|landing|registry|pay|cli.css`) — each owned by one builder,
  compose the primitives, never re-derive them.
- Pages in `src/pages/`; cluster components in `src/components/{audit,report}/`.

## Gotchas (inherited from the DEV engine contract)

- **Verdict is exactly `{SAFE, DANGEROUS}`.** Audit failure is an `audit_error`
  event / ERROR state — **never** a SAFE verdict. Don't synthesize green from a
  crash.
- **Report is schemaVersion 2**: `{schemaVersion:2, verdict, rationale, counts,
  confirmedHypIds, hypotheses[], fileSummaries[], dealbreaker, trace[]}`. There
  is **no** `proofs[]` / `runtimeEvidence` / top-level `capabilities` (that was
  the stale TS shape). `verdict_reached` carries `{verdict, rationale, counts,
  confirmedCount}`, not `{capabilities, proofCount}`.
- **The engine emits 17 event types.** The 7 typed `agent_thinking`,
  `agent_tool_call`, `agent_tool_result`, `agent_reasoning`, `finding_discovered`,
  `verify_started`, `verify_test_result` events are **dead** — the dev engine
  never emits them. The fold tolerates them (forward-compat / legacy replay) but
  build **no UI** around them. It emits 3 events not in the typed union:
  `dependencies_provisioned`, `intent_extracted`, `graph_built`. The
  "investigation" is hypothesis-centric: the orchestrator streams
  `hypothesis_resolved` (CONFIRMED/REFUTED/DEFERRED), not an agent transcript.
- SSE wire framing: `id: {seq}\nevent: {type}\ndata: {json}\n\n`; the `data`
  JSON has `{type,auditId,timestamp,seq}` **flattened** in with the payload.
  Ignore `: keep-alive` comment frames.
- Resolve `latest`/empty versions via `GET /resolve/:name` **before**
  `POST /audit/stream` — the engine rejects non-semver.
- Scoped package names keep their slash: `/package/*` and `/resolve/*` are splat
  routes — never `encodeURIComponent` the whole name.
- On verdict, `App` canonicalizes `/audit/:id` → `/package/<name>` with raw
  `history.replaceState` so the router never remounts the live view. Do not
  replace with `navigate()`.
- Payment is verified **server-side only** (`engine/npmguard/payments.py`). The
  wallet signs; the engine verifies. WalletConnect (mobile QR) lives in the CLI;
  the web app uses an **injected** browser wallet only — no private-key path
  (grep-enforced). Crypto contract + fee come from `GET /config/public`
  (`crypto: {chain:"base-sepolia", chainId:84532, contract, auditFeeWei}`),
  never hardcoded.
- Every route is mirrored under `/api`; app code hits `apiBase()` = `/api`.
- Demo / e2e determinism: `GET /demo/packages` + `POST /demo/start` replay
  committed recordings (`engine/demo-data/*.json`) with zero LLM/docker.
  `NPMGUARD_DEMO_SPEED` (engine knob) fast-plays them for Playwright. An empty
  demo list must render honestly (a package input, not a fake dropdown).
- React 19 without an ErrorBoundary renders a **blank page** on a component
  crash — `main.tsx` mounts the one (`components/ErrorBoundary.tsx`) on day one.

## Testing

Two pillars (see the v2 `TESTING.md` for the full discipline): blackbox
class-mapped **units** (fold replay-idempotence is a mandatory class, not an
edge case) and **e2e** that never mocks the engine — Playwright boots the real
uvicorn engine in demo mode (engine :8055, vite :3100, `NPMGUARD_DEMO_SPEED`
÷N, hermetic `.e2e-data`). Assert structure + lifecycle, never captured LLM
prose. Stable locators are `aria-label`s planted at build time.
