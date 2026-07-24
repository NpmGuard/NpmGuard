# Testing

Two pillars, mirroring `~/zen/lab/kit/TESTING.md` and `engine/TESTING.md`:
**prove the logic** (blackbox units over equivalence classes) and **prove the
artifact** (e2e — the real browser + vite talking to the real Python engine
across real boundaries). A component you can't verify is a sketch, not a
component.

**Clone-and-run rule:** `npm test` passes on a fresh clone with nothing running
(units, jsdom, seconds). E2e is the per-change gate (minutes) and boots the real
engine itself. Anything needing infra gates with a visible reason.

## Pillar A — blackbox units over equivalence classes

The unit is every **exported** function/class; private helpers are covered
through the public I/O that uses them. Blackbox: assert only inputs, outputs,
and observable effects — a test that breaks under a behavior-preserving refactor
is a wrong test.

Coverage is measured in **equivalence classes**, not test count: partition the
input space into regions where the unit must behave the same, test one
representative per class plus the boundaries. **Class map:** every test file
opens with the enumeration of its unit's input classes; every test names its
class in the first line of its description (`C3: …`). Review checks the map, not
the count. Before a map is trusted, an **adversarial pass** (different session /
model) asks *which dimension is missing?* Implementation-created boundaries
(reconnect budget, backoff) are exposed as injectable parameters and listed as
classes.

The units and the classes they must cover:

| unit (`src/lib/…`) | classes (representative) |
|---|---|
| `audit-fold.foldAuditEvent` | **replay/idempotence** (fold an event twice, and re-fold a full buffer, is a no-op via the seq guard — a first-class class, not an edge); dedup; one class per real transition (audit_started, phase_started/completed, dependencies_provisioned, file_list, inventory_meta, intent_extracted, file_analyzing, triage_progress, hypothesis_emitted, file_verdict, triage_complete, graph_built, hypothesis_resolved, verdict_reached, audit_error); terminal freeze (post-verdict non-terminal ignored); unknown/**dead** type tolerated (agent_*/verify_*/finding_discovered never throw); hypothesis upsert-in-place by hypId; DANGEROUS/ERROR never coerced to SAFE |
| `sse.connectAuditStream` | named-listener registration per `AUDIT_EVENT_TYPES`; delivered event → onEvent + attempt reset; onerror → reconnect w/ injected backoff; `isDone()` true → stop (terminal close); malformed JSON frame skipped, never thrown; `close()` idempotent (injectable ctor + backoff — no real timers/network) |
| `api.*` | each route's happy path; `ApiError{status,body}` on non-2xx; status-branch classes (402/404/501/500). msw handlers registered **origin-relative** (`http.get("/api/…")` — jsdom origin) |
| `report-helpers.*` | confirmedHypotheses (confirmedHypIds ∪ state===CONFIRMED, severity-sorted); verdictHeadline honest (dealbreaker wins; N confirmed; "No known threats" for SAFE; never a fabricated 0); capabilitiesFromReport dedupe; claimLabel fallback |
| `format.*` | byte/duration/wei boundaries (wei trailing-zero trim); `formatDate` → "—" on null/invalid |
| `types.*` | parsePackageInput (scoped names via last `@`); parseLineRanges (garbage dropped); riskContributionToStatus thresholds; fileFromFileLine |

**Parity (the frontend's contract test).** `engine-types.ts` is hand-written
from the engine's payloads, so it can drift. A parity unit asserts the fold's
handled event union **⊇** the types the engine actually emits, cross-checked
against the committed `engine/tests/fixtures/sse/*.skeleton.json` (event **types
only** — `seq`/`timestamp` are nondeterministic; never byte-golden a frame). A
skeleton type the fold doesn't handle is contract drift — fix `engine-types.ts`
+ the fold, then pin.

## Pillar A2 — the GitHub panel, proven on the mocked boundary

The panel/dashboard cluster (`pages/Dashboard`, `pages/RepoDetail`, the
`components/panel/*` cluster, `panelStore`) has **no demo-replay** — its data
comes from live GitHub via OAuth, so a hermetic real-engine e2e is impossible.
Its "prove the artifact" pillar is therefore **component-integration** tests:
the REAL page + REAL store + REAL react-router, rendered in jsdom, talking to
**MSW handlers over the exact `/api/panel/*` HTTP boundary the app crosses in
prod** (`api-base.ts` → `ApiError{status,body}` branches, `capBody`/`isReauth`
dispatch, the SSE dep-patch). Only the network peer is a mock; every seam
between the component and that peer is real. This is the honest analogue of
Pillar B where the counterpart backend can't be booted deterministically.

**Harness** (`src/test/`): `panel-server.ts` (MSW `server` + `panelHandlers`
happy-path factory, origin-relative + jsdom-origin-pinned), `panel-fixtures.ts`
(benign-by-default builders for every panel wire shape — overrides state only
the class under test), `render.tsx` (`renderRoute` = MemoryRouter with sink
routes for navigation assertions, `resetPanelStore`/`authedSeed` for singleton
isolation, `installMockEventSource` since jsdom has no `EventSource`). Same
class-map discipline as Pillar A: each file opens with its `C<n>` enumeration;
each test names its class. Assert rendered output + observable effects (nav,
store state, a POST-then-reload, an SSE patch) — never internals or CSS beyond
stable `aria-label`/role hooks. The honest-verdict invariants are pinned here
too: a DANGEROUS dep/scan is never coerced to SAFE (even when a scan summary
reports SAFE); a 402 cap opens the paywall, never a silent failure; pending
(verdict `null`) is distinct from a real verdict; an error/empty is an honest
empty-state, never a fabricated posture.

The panel units + their representative classes:

| unit | classes (representative) |
|---|---|
| `pages/Dashboard` | login gate (no session → sign-in, never blank); auth boot streams repos; grid filters (all/protected/unscanned/attention) + counts + search; empty classes (no-install / no-repo / no-match); public-audit CTA gated on billing; `?billing=success/cancelled` banners; error+retry; paywall dialog |
| `pages/RepoDetail` | load phases (loading/ready/404-missing/500-error); the 7 posture-label branches; counts-rail + tiles; review queue (alerts vs flagged-dep fallback + nav); inventory search/filter/severity-sort/pagination; actions (audit/protect-optimistic/resync) with busy/action-error/cap-paywall; running-scan SSE dep-patch |
| `panel/*` components | RepoCard scan-summary states + action wiring; PlanLedger free/pro buckets + checkout/portal; PortfolioPosture aggregation buckets; AlertsNotice unseen→mark-seen; PublicAudit dialog/history/report (cap, 409-already-running-as-success, truncation); UpgradeDialog per-resource copy + close; tone verdict→tone map; AllowanceMeter quota states |

## Pillar B — e2e: the artifact, proven

E2e means the **exact artifact prod ships** — the built React app in a real
chromium, talking to the **real Python engine** over real HTTP + SSE. **Never a
mocked engine.** The engine runs in its deterministic **demo-replay** mode
(`POST /demo/start` replays a committed recording — zero LLM, zero docker),
paced fast by `NPMGUARD_DEMO_SPEED`.

**Harness** (`playwright.config.ts`): engine on **:8055** (`uv run uvicorn
npmguard.api:app`, payment off, hermetic `.e2e-data`, `NPMGUARD_DEMO_SPEED`) +
vite on **:3100** (proxying `/api` → the engine); `workers:1 retries:0` (audit
sessions + the SSE hub are in-process engine state — a flaky spec is a bug, not
a retry). Node ≥ 22 has native `EventSource`, so the app runs unmodified.

**Scenarios are equivalence classes of the integration surface** (`S<id>
[C<claims>]` in each spec's first line), not a re-test of endpoint edges.
Locators are **stable `aria-label`s** planted at build time
(`aria-label="watch demo audit of <pkg>"`, `"view full audit of <pkg>"`).
Assertions target **structure + lifecycle**, never captured LLM prose
(recordings carry real text — re-recording would rot content assertions). Demo
package names are **discovered** via `GET /demo/packages` so the suite is
name-agnostic.

The scenario map (a stream's classes mirror kit's stream list — cold connect,
replay, live, reconnect-resume-without-duplicates, idle survival):

- **S1 clean SAFE** — Landing → start the SAFE demo → the live view streams
  phases/files/hypotheses → terminal **SAFE** verdict renders → URL canonicalizes
  to `/package/<name>` (no remount).
- **S2 DANGEROUS** — start the DANGEROUS demo → a hypothesis resolves to
  CONFIRMED (state pill) → terminal **DANGEROUS** verdict; the reveal shows the
  confirmed threat. Never SAFE.
- **S3 reconnect / replay idempotence** — reload mid-stream (`DEMO_SPEED` tuned
  so the reload lands while live) → the view reconnects via the `Last-Event-ID`
  cursor and resumes **without duplicate rows**; the final verdict is identical.
- **S4 durable report** — `/package/<name>?version=` renders the schemaVersion-2
  report (verdict, counts rail, hypotheses, file summaries); a bogus name → an
  honest 404 empty state (not an error, never a fake SAFE).
- **S5 registry** — `/packages` lists audited packages; a row navigates to its
  report; the empty and filter-empty states are reason-aware and honest.
- **S6 payment gate** — `/config/public` gates the `/pay` methods (only
  advertised methods render); the error taxonomy branches on `ApiError.status`.
- **S7 expired session** — `/audit/<bogus-uuid>` → the probe 404s → an honest
  "session expired" state, never a blank view.
- **S9 dashboard gate** — `/dashboard` against the real engine with **no GitHub
  App configured** (the default e2e harness): `/me` 503s, the store resolves
  `user=null`, and the page must render the honest sign-in gate (the "Sign in
  with GitHub" link points at the real `/api/auth/github/login`), never a blank
  view and never a fabricated workspace. The authenticated dashboard stories
  live in Pillar A2 (the panel backend can't be booted deterministically here).
- **Edge classes** — heartbeat `: keep-alive` frames ignored; a scoped package
  name (`@scope/pkg`) routes with its slash intact; `prefers-reduced-motion`
  disables entrances (no motion assertions depend on animation).

If an `audit_error` recording exists, **S8**: the error renders a
`role="alert"` banner with the code — an audit failure is an ERROR, **never** a
SAFE verdict.

## Claims are test targets

Every falsifiable claim in `frontend/CLAUDE.md` maps to a named test or is
deleted. The dev-contract invariants — verdict is `{SAFE, DANGEROUS}`, failure
is an error not a SAFE, the report is schemaVersion 2, the 7 dead events never
render, reconnect is cursor-replay-idempotent — are each pinned by a test above.

## Determinism

No sleep-and-assert — wait on conditions with bounded timeouts (`expect`
auto-retry); latency bounds are named constants, generous, never load-bearing.
`NPMGUARD_DEMO_SPEED` is the injectable pacing (the analogue of injectable
time). Negative assertions ("no duplicate row") are bounded and paired with a
positive probe (the row that *should* be there). Tests share no mutable state;
the engine data dir is wiped at config load.

## Failure protocol

| failure | meaning | the move |
|---|---|---|
| parity | `engine-types.ts` drifted from the engine's emitted shapes | fix the type + fold, pin against the skeleton fixture |
| unit | bug — or the class map missed a class | fix the code; if the map was wrong, add the class **first** |
| e2e | a real wiring/boundary bug | heal the locator, never the intent; fix the seam, never mock it away |

Never weaken a test to pass. If a test encodes the wrong convention, change this
document first.

## The gate

`npm run gate` — cheap first: `tsc -b` (typecheck) → `vitest run` (units) →
`playwright test` (e2e, which boots the real engine). The e2e tier needs `uv`
(the engine) on PATH and the committed demo recordings in `engine/demo-data/`.
Run the e2e suite **twice** before trusting a green — a scenario that passes
once but not twice is a determinism bug, not a pass.
