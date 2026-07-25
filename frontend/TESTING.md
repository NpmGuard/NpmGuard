# Testing

Two pillars, mirroring `engine/TESTING.md`: **prove the logic** (blackbox units
over equivalence classes) and **prove the artifact** (e2e — the real browser +
vite talking to the real Python engine across real boundaries). A component you
can't verify is a sketch, not a component.

**Clone-and-run rule:** `npm test` passes on a fresh clone with nothing running
(units, jsdom, seconds). E2e is the per-change gate (minutes) and boots the real
engine itself. Anything needing infra gates with a visible reason.

## What is NOT a test here

The bar is behaviour a user could feel. These shapes were deleted from this suite
rather than maintained, and a new one matching them is bloat, not coverage:

- **A test of the library.** Radix's focus trap, roving tabindex, Escape handling
  and `aria-*` wiring; tailwind-merge's conflict groups; clsx's flattening;
  react-query's request dedupe. Test the decision *we* made on top of it: which
  ARIA role a stateful menu item carries (`menuitemcheckbox` for column
  visibility, `menuitemradio` for density — three checkboxes tell a screen-reader
  user they can pick two, which is a lie about the control), which token
  namespaces `cn` was told to extend, what our retry policy classifies as
  terminal.
- **A restatement of a source file.** Reading `tokens.css` and asserting it
  declares the tokens it declares; reading `base.css` to build a class list and
  asserting components don't use it; asserting a deleted stylesheet is deleted.
  The token contract earns its place only because it **recomputes** something the
  file does not state — WCAG contrast over every ink × surface pair.
- **A migration checkpoint.** `theme-coherence.test.tsx` rendered ten components
  in both themes to assert a recomposition had finished, and asserted
  `styles/panel.css` no longer exists. That is a fact about one commit. The
  per-page "renders under an explicit `.dark` stamp" tests were the same class:
  jsdom loads no Tailwind, so they could only ever assert that the same markup
  renders twice.
- **A pinned exact value where a bound is the real rule.** `toBe(15.59)` fails on
  a palette edit that is still legal; `toBeGreaterThanOrEqual(4.5)` fails only
  when the product becomes illegible. Pin an exact value when the *specific*
  number is the contract (the two deliberate sub-floor exceptions), not otherwise.

Test count is not a coverage measure. 424 tests became 321 by deleting the above,
and the token contract covers strictly more of the palette than before.

## Pillar A — blackbox units over equivalence classes

The unit is every **exported** function/class; private helpers are covered
through the public I/O that uses them. Blackbox: assert only inputs, outputs,
and observable effects — **a test that breaks under a behavior-preserving
refactor is a wrong test**.

Coverage is measured in **equivalence classes**, not test count: partition the
input space into regions where the unit must behave the same, test one
representative per class plus the boundaries. Every test names its class in the
first line of its description (`C3: …`), so the test list is the class map.
Implementation-created boundaries (reconnect budget, backoff) are exposed as
injectable parameters and covered as classes.

The units and the classes they must cover:

| unit (`src/lib/…`) | classes (representative) |
|---|---|
| `audit-fold.foldAuditEvent` | **replay/idempotence** (fold an event twice, and re-fold a full buffer, is a no-op via the seq guard — a first-class class, not an edge); dedup; one class per real transition (audit_started, phase_started/completed, dependencies_provisioned, file_list, inventory_meta, intent_extracted, file_analyzing, triage_progress, hypothesis_emitted, file_verdict, triage_complete, graph_built, hypothesis_resolved, verdict_reached, audit_error); terminal freeze (post-verdict non-terminal ignored); unknown/**dead** type tolerated (agent_*/verify_*/finding_discovered never throw); hypothesis upsert-in-place by hypId; DANGEROUS/ERROR never coerced to SAFE |
| `sse.connectAuditStream` | named-listener registration per `AUDIT_EVENT_TYPES`; delivered event → onEvent + attempt reset; onerror → reconnect w/ injected backoff; `isDone()` true → stop (terminal close); malformed JSON frame skipped, never thrown; `close()` idempotent (injectable ctor + backoff — no real timers/network) |
| `api.*` | each route's happy path (the URL, method and payload the engine expects); `ApiError{status,body}` on non-2xx; status-branch classes (402/404/501/500); a 200 that violates the schema is a `ContractViolationError`, never a healthy read. msw handlers registered **origin-relative** (`http.get("/api/…")` — jsdom origin) |
| `report-helpers.*` | confirmedHypotheses (confirmedHypIds ∪ state===CONFIRMED, severity-sorted); verdictHeadline honest (dealbreaker wins; N confirmed; "No known threats" for SAFE; never a fabricated 0); capabilitiesFromReport dedupe; claimLabel fallback |
| `format.*` | byte/duration/wei boundaries (wei trailing-zero trim); `formatDate` → "—" on null/invalid |
| `types.*` | parsePackageInput (scoped names via last `@`); parseLineRanges (garbage dropped); riskContributionToStatus thresholds; fileFromFileLine |
| `query-state.*` | the only mapping from react-query into `LoadState`: three states → three arms; data surviving a failed *refetch* stays `ok` tagged with `asOf`; every failure NAMED; `allLoaded` is a product (one failure fails the composite, and names every failure); a 402 yields `null` so a call site cannot double-report a cap |
| `query-client.*` | the cross-cutting HTTP policy, built from the real `createQueryClient()`: 401-reauth redirect from a query AND a mutation (a plain 401 must not redirect); 402 → paywall + in-place entitlements patch; `retryable()` classification |

**Parity (the frontend's contract test).** The audit types are generated from
`@npmguard/shared`, but the fold's handled union can still drift from what the
engine emits. `contract-audit.test.ts` parses every frame in the committed
`engine/demo-data/*.json` recordings against `AuditEventSchema` and asserts
`EVENT_TYPES` is exactly the schema's discriminant set — real captured producer
output, event **types** only (`seq`/`timestamp` are nondeterministic; never
byte-golden a frame).

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
- **Edge classes** — heartbeat `: keep-alive` frames ignored; a scoped package
  name (`@scope/pkg`) routes with its slash intact; `prefers-reduced-motion`
  disables entrances (no motion assertions depend on animation).

If an `audit_error` recording exists, **S8**: the error renders a
`role="alert"` banner with the code — an audit failure is an ERROR, **never** a
SAFE verdict.

## The honesty invariants, and what enforces them

These are the claims this app exists to keep, so they get the densest coverage —
and they are the reason the deletions above cost nothing.

- **Empty and degraded are different facts.** `load-state.test.ts` asserts the
  negatives with `@ts-expect-error`, so weakening the `ReadSucceeded` brand fails
  **`npm run typecheck`**, not merely a test. `data-region.test.tsx` covers the
  rendering halves: a failed read renders the degraded state and the caller's
  empty copy is *absent from the document*, the two states carry distinct
  `data-state` and roles, and only the degraded one offers a retry.
- **A number is never fabricated.** `honest-display.test.tsx`: an unknown meter
  value drops `role="meter"` rather than rendering `0`; an unmetered plan draws no
  bar; an indeterminate progress bar exposes no `aria-valuenow`; a pending
  severity segment is hatched, never coloured; a StatTile with no value renders an
  em-dash and a failed one renders the degraded field.
- **Degradation never cries wolf.** `DegradedState` is `error` violet and never
  `danger` red — red is reserved for claims about *packages*. Pinned in
  `stamp.test.tsx` (ERROR wears the error slot) and asserted per page.
- **A page degrades in parts.** `Dashboard.test.tsx` / `RepoDetail.test.tsx` fail
  one read at a time and assert the half that worked still renders while the half
  that failed NAMES itself — including the pairs that read alike to the eye (zero
  repositories → empty; a failed repositories read → degraded).
- **The wire is checked at the boundary.** `api.test.ts` C5 asserts a 200 whose
  body violates the schema raises `ContractViolationError` and *not* an
  `ApiError`, because a 200 must never reach a component as a healthy read.

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
| parity | the fold's handled union drifted from the engine's emitted shapes | fix the fold, pin against the recorded frames |
| unit | a bug — or a missing equivalence class | fix the code; if a class was missing, add its test **first** |
| e2e | a real wiring/boundary bug | heal the locator, never the intent; fix the seam, never mock it away |

Never weaken a test to pass. If a test encodes the wrong convention, change this
document first.

## The gate

`npm run gate` — cheap first: `tsc -b` (typecheck) → `vitest run` (units) →
`playwright test` (e2e, which boots the real engine). The e2e tier needs `uv`
(the engine) on PATH and the committed demo recordings in `engine/demo-data/`.
Run the e2e suite **twice** before trusting a green — a scenario that passes
once but not twice is a determinism bug, not a pass.
