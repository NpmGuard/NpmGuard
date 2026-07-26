# frontend — CLAUDE.md

React 19 + Vite + TypeScript. **Tailwind v4** (CSS-first `@theme`, light **and**
dark) over a vendored Radix primitive layer. Server state is
`@tanstack/react-query`; UI state is a ~50-line zustand store. CodeMirror 6 for
source, react-router for routes.

There is **one** style substrate. The eight plain-CSS "keyline" page sheets are
gone and so is the Google Fonts request; `styles/base.css` is 105 lines of
element defaults, down from 798.

Design authority: [`docs/specs/2026-07-25-frontend-design-direction.md`](../docs/specs/2026-07-25-frontend-design-direction.md)
— §2 is the token spec's *structure* (inventory, floors, ladders, enforcement);
the palette **values** are the paper-and-lacquer identity authored in
`styles/tokens.css` itself (warm cream light / lacquer-gold dark,
Space Grotesk + JetBrains Mono), and that file wins where a §2 hex disagrees.
§3.4 is the empty-vs-degraded rule this app enforces in types.

This app talks to the **Python engine**. Contract gotchas are at the bottom.

## Run

```bash
# from the repo ROOT (npm workspace — installing here acts on root; binaries
# hoist to <repo>/node_modules/.bin, NOT frontend/node_modules/.bin):
npm install

cd frontend
npm run dev        # :3000, proxies /api/* → engine :8000 (VITE_API_TARGET overrides)
npm run build      # tsc -b && vite build → dist/ (the engine serves this in prod)
npm run typecheck  # tsc -b — NOT --noEmit; see below
npm test           # vitest + jsdom — clone-and-run, nothing running
npm run test:e2e   # Playwright boots the REAL engine (uvicorn :8055, demo mode) + vite :3100
                   # + the panel fixture server :8056 (GitHub App/OAuth stub) so
                   # the dashboard specs run against a panel-ENABLED engine
npm run gate       # typecheck && test && test:e2e
```

`typecheck` is `tsc -b`, deliberately without `--noEmit`: the wire contract is a
tsconfig **project reference** to `shared/`, and a referenced project requires
its declarations to exist. `--noEmit` leaves a stale (or absent) `shared/dist`
and the failure reads as "the schema I just wrote doesn't exist".

---

## The five things that are load-bearing

Everything below breaks a guarantee if violated. Everything *not* below is a
preference — style it how you like.

### 1. Empty and degraded are different facts, enforced at the type level

Read this before you try to simplify anything. The bug class it kills: a fetch
fails, the catch leaves the collection at `[]`, and the view renders a confident
"No dependencies audited yet". The user reads *absence of threats* where the
truth was *absence of knowledge*. In a security product that is the product
lying.

`components/ui/load-state.ts` is the **one** vocabulary — `loading` / `ok{data,
read, asOf?}` / `failed{failure}` — and it is not a convention:

- The `failed` arm has **no `data` field at all**. Not `[]`, not `null`. So
  `catch { setItems([]) }` has nothing to reach for and no identifier in scope
  to render.
- `ReadSucceeded` is branded with a module-private `unique symbol`. Its only
  mint is `loaded(data)` — you must be holding data you actually read.
  `EmptyState` requires one, so "render the empty state on error" is a type
  error.
- `DegradedState` requires a `Failure`, whose `what` is **required**. There is
  no path to "Something went wrong".
- `isEmpty(state, …)` takes the *state*, not the data: a failed read is never
  empty, and the predicate is not even consulted.

**What enforces it:** `load-state.test.ts` C2/C3 assert the negatives with
`@ts-expect-error`. A directive that stops erroring is itself an error under
`tsc`, so weakening the brand fails **`npm run typecheck`**, not merely a test.
`honest-display.test.tsx` covers the component halves.

`lib/query-state.ts` is the **only** mapping from react-query into this
vocabulary. Do not add a second: a hook returning `{data, isLoading, error}`
hands every call site the same three fields the old store did, and the bug class
comes straight back. Two judgement calls are recorded there rather than per
component — holding data wins over a failed *refetch* (carried by `asOf`
instead), and `asOf` is set only on `isRefetchError`, never merely past
`staleTime`, so a staleness chip keeps meaning something.

Rendering rule, at the point of use: a region with a visible empty state worth
showing → `<DataRegion>` (exhaustive switch; `children` is a function of the
**narrowed** data; `failed` is checked *before* emptiness, because
`catch{[]}`-then-`length===0` is the historical bug in order form). Where the
honest empty rendering is *nothing* — an alert banner, a plan ledger for an
account with no plans — switch on `state.status` at the call site and render
`<DegradedRegion>`; `DataRegion` would demand empty copy that can never show,
and dead copy is its own small lie.

### 2. Server state is not application state

`lib/query-client.ts::createQueryClient()` owns caching, refetch, dedupe,
polling, staleness and retry as **configuration**, not code. Nothing wraps
react-query — a wrapper that added nothing over the library would be the god
store with a new name.

- `retryable(error)` is the retry policy, and every `false` in it is a claim
  that the response is a deterministic function of the request (contract drift,
  a 503 from an unconfigured GitHub App, a 404). The same classification decides
  whether a `Failure` offers a Retry button, so the two cannot disagree.
- Genuinely cross-cutting HTTP policy lives once in the query/mutation cache
  `onError`: the reauth redirect, and 402→(open paywall + patch the billing
  ledger from the entitlements the 402 already carries). The old store called
  the cap handler from four places with a fifth that forgot.
- `stores/panelStore.ts` is UI state **only**. The bar for a field: it must not
  be a server read, and it must be needed by two components that are not each
  other's ancestor. Its docstring lists what was deleted and why — read it
  before adding anything.
- Feature modules are `features/{session,repos,alerts,billing}/{keys,api,hooks,components}`.
  Keys are factories with prefix handles, so "patch whichever detail pages are
  open" is expressible without knowing which ones they are.
- A live stream is a **writer into the query cache** (`setQueryData`), never a
  second store. The stream and the query describe one fact; two homes for one
  fact eventually disagree, which is what a component-local `useState` mirror of
  a fetched response always becomes.

**What enforces it:** query-layer tests build their client from the real
`createQueryClient()` via `lib/test-harness.tsx` (only retry *count* is
overridden), so the policy under test is the one that ships.

### 3. One wire contract, checked at the boundary

Contract shapes live in `@npmguard/shared` (zod). The engine's
`contract/models.py` is generated from the same source by
`scripts/gen-contract.sh`. **Author a new wire shape in `shared/src/*.ts` and
regenerate** — never hand-write one here.

- **Nothing in this app declares a wire shape.** Every type crossing the engine
  boundary is imported from `@npmguard/shared` **directly**, and there is no
  local module re-exporting them — `lib/engine-types.ts` is deleted, not emptied,
  because a surviving re-export file is an invitation to add "just one"
  hand-written shape beside it. The hand-written copies it held had already
  drifted — `price.currency` was `string` where
  the schema says `string | null` (would have thrown in a formatter), and
  `audit_error` declared all three of `{error, code, retryable}` optional-nullable
  where the contract and every emit site say required non-null (which bought an
  unreachable fallback and a unit test asserting on unemittable traffic).
  Three contract names differ from the old local ones, and the contract name
  wins: `VerdictEnum`, `AuditEventUnion`, `EVENT_TYPES`.
- `lib/api-base.ts` is the transport: non-2xx throws `ApiError{status, body}` —
  branch on `status`, never on message text. The named body sniffers
  (`capBody`, `isReauth`, `scanAlreadyRunning`) exist so a policy is recognised
  in one place rather than by string matching at four call sites.
- `lib/wire.ts` `safeParse`s every panel response and raises
  `ContractViolationError` on drift. Deliberately **not** an `ApiError`: the
  request succeeded, so `status` would be 200 and every status-based branch
  would treat it as a healthy read. Drift is never retried.
- Two resolution paths, neither able to serve a stale `dist`: vite aliases the
  package to `shared/src`, typecheck goes through the project reference. Do not
  add a tsconfig `paths` mapping to src as well — a referenced project requires
  its declarations, so the two conflict (TS6305).
- SSE frames are checked too, not just HTTP responses. Both streams `safeParse`
  every frame (`AuditEventSchema` / `ScanStreamFrameSchema`) and treat a violation
  as terminal — closed, reported, never reconnected, because drift is
  deterministic and a retry just replays the same bad frame. The audit stream
  keeps its forward-compatibility guarantee *despite* that strictness, and the
  reason is structural rather than a special case: it subscribes to NAMED events,
  so an event type the engine adds has no listener and is dropped by EventSource
  before any validation runs. Strictness applies only to the 17 names we asked
  for. See `audit-fold.ts`'s header.
- The audit routes' **HTTP envelopes** were the last hand-written shapes and are
  now `shared/src/audit-api.ts` (`StartAuditResponse`, `AuditAcceptedResponse`,
  `ResolveResponse`, `DemoPackagesResponse`, `PackageSummary`/`PackageIndexResponse`,
  `PackageReportResponse`, `PublicConfig`/`CryptoConfig`, `CheckoutResponse`,
  `CheckoutStatus`). Every one is parsed with `getWire`/`postWire` in `lib/api.ts`
  — there is no `getJson<T>` cast left on an audit route — and the engine builds
  each response from the generated model via `api.py::_wire`, so both sides read
  one author. `CryptoConfig` is the shape to imitate when authoring a new one: it
  has no nullable fields, because "we cannot take a crypto payment" is expressed
  once by the parent being null rather than by three fields that might each be
  missing.
- **Two verdict domains, not aliases.** Audit `VerdictEnum` is `{SAFE, DANGEROUS}`
  because a failed audit emits an `audit_error` event. Panel `Outcome` is
  `{SAFE, ERROR, DANGEROUS}` because a rollup must *count* failures. Do not
  widen either to match the other.

### 4. Stream state is folded in one pure function

`lib/audit-fold.ts::foldAuditEvent` — one `switch(event.type)`, and every
audit-stream transition is in it. Never in a component, never inline in a store.
It is idempotent under cursor replay (dedup by `seq`), freezes after a terminal
event, and never throws on an unknown type. `stores/auditStore.ts` is the thin
shell around it: connection lifecycle, start orchestration, report hydration.

`lib/sse.ts` holds two clients, one convention apart:

| | audit stream `/audit/:id/events` | panel progress `/panel/scan/:id/events` |
|---|---|---|
| framing | **named** events, one listener per type; `onmessage` never fires | **unnamed**; `onmessage` only, per-name listeners get nothing |
| resume | `id:` line → `Last-Event-ID` (engine also accepts `?since=`) | same — frames carry `id:` too |
| replay safety | the fold's `seq` guard | every frame is a snapshot, so replay is inherently idempotent |

**One** progress stream serves every origin: an owned-repo scan and a
public-repo audit are the same entity, so `scanId` is an audit-set id and there
is no public-scan polling loop. The EventSource ctor and backoff are injectable,
so unit tests drive a fake with no timers and no network.

**What enforces it:** `audit-fold.test.ts` treats replay-idempotence as a
mandatory class, not an edge case; `sse.test.ts` drives both clients through the
injected ctor.

### 5. One style substrate, and a short list of things that stay true

Tailwind v4 is CSS-first: **no config file, no PostCSS step**.
`@tailwindcss/vite` is the whole integration — adding a `postcss.config.*` gives
Tailwind a second, slower entry point that silently shadows it.

R-5b finished the migration D-3 started. What used to be here — the two-tier
`base.css`, the `.ng-root` opt-in marker, the rule that a page sheet dies *with*
its page — described a transition that is over. The rules that survive:

- `styles/tokens.css` is the token layer: primitives in `:root` /
  `@media (prefers-color-scheme: dark)` / `.dark`, mapped into Tailwind's
  namespaces with `@theme inline`. `inline` is what makes one class work in both
  themes *and* under a `.dark` stamped on a subtree.
- **Every primitive is `--ng-`-prefixed.** The original reason (a collision with
  the legacy `:root` block) is gone, but the prefix stays: it makes a token
  reference greppable and unmistakable in a codebase that also has CodeMirror
  and Radix custom properties in scope.
- Components use **utilities** (`bg-surface`, `text-text-2`). Raw CSS — a
  keyframe, an SVG `fill`, an inline style, a `calc()` — reads the **primitive**
  (`var(--ng-surface)`). `var(--color-surface)` resolves to nothing: an
  `@theme inline` key is substituted into the utility at build time and is never
  emitted as a custom property.
- ★ **A bare-element rule in `base.css` must be inside `@layer base`.** This is
  the one cascade rule worth memorising, and it cost the project real damage:
  an unlayered `button { background: none; border: 0; padding: 0 }` beats
  `.bg-accent`, `.border` and `.px-3` in `@layer utilities` no matter their
  specificity, because **unlayered always wins over layered**. Every `<Button>`
  in the design system rendered as unstyled text for the whole of R-6b, and
  `a { color: inherit }` ate every link-colour utility beside it. jsdom does not
  implement `@layer`, so no rendering test can see this — it is pinned as a text
  contract in `styles/base-layer.test.ts`.
- **`.ng-root` is no longer a migration marker.** It is the class that says "v3
  styling applies here", and it is still needed for exactly one reason: Radix
  portals dialogs, popovers and dropdowns *outside* the app root, and those
  subtrees need the same typography and focus ring. Keep it on portalled content.
- **One page-scoped sheet exists**, `styles/how-it-works.css`, and its header
  states the rule it is the exception to: *a surface may own a stylesheet for
  what is genuinely singular about it, and may never own one for what the design
  system already provides.* That line is the durable version of "no page sheets"
  — R-6's finding was about eight sheets **re-deriving** buttons, cards and
  pills, not about CSS existing. A new surface starts with zero CSS; if it earns
  some, it earns it for its own bespoke narrative and never for a primitive.
- `lib/cn.ts` is the single `cn`. Its `extendTailwindMerge` **theme** extension
  is not optional: tailwind-merge groups a class by validating its *value*, so a
  custom `h-control` has no conflict group and `cn("h-control","h-control-lg")`
  returns both — handing the override to stylesheet order instead of call order,
  which is the guarantee the whole component contract rests on. `text-figure` is
  worse than unmerged: it is misgrouped as a colour, so a size silently loses to
  a colour. Adding a `--spacing-*` / `--text-*` / `--ease-*` / `--shadow-*`
  token means adding it here too.
- Reach for an existing `components/ui/` primitive before writing behaviour.
  They are Radix-backed where Radix covers the pattern, and hand-built with
  correct semantics where it does not. Hand-rolling a focus trap, escape
  handling, a portal and ARIA is four places to be invisibly wrong, and subtly
  wrong accessibility is the failure nobody notices until a user cannot operate
  the app. Radix 1.1.x deliberately emits no `aria-modal`;
  modality comes from the rest of the page being `aria-hidden`. Don't hand-add
  the attribute.
- One meaning per seam: `focus.ts` is the one ring (`:focus-visible` only, with
  a `forced-colors` outline fallback); `hatch.ts` is the one texture and it means
  "no signal here". `DegradedState` is `error` violet and never `danger` red —
  red is reserved for claims about *packages*, so the UI can never cry wolf
  about its own plumbing.

**The two axes, and where they are enforced.** §0 of the design direction is the
product's whole credibility argument, and three components carry it so no page
has to remember it:

- `ui/verdict-stamp.tsx::VerdictHeadline` takes a **required** `counts` prop, so
  a headline verdict cannot render without the coverage it was drawn from, and
  SAFE always renders "No confirmed threat found. Not a proof of absence."
  Overstating a clean result is a credibility failure; this is the mechanism.
- `VerdictStamp` / `ProgressStamp` keep outcome and progress on separate axes.
  Anything on the progress axis is **achromatic** (§2.2 rule 2) — a green
  "completed" dot is a verdict colour on a non-verdict fact, which is how the
  phase rail once read as a running tally of SAFE findings.
- `ERROR` is `error` violet, never red, and shares that slot with `DegradedState`
  and a DEFERRED hypothesis. All three mean *we don't know*. A failed audit shown
  in red tells the user the package is dangerous, which is a false positive
  manufactured by a stylesheet.

`SUSPECT` and `UNKNOWN` are deleted from the product. Do not reintroduce either
as a visual state.

**What enforces it:** `styles/token-contract.test.ts` reads `tokens.css` as text
and **recomputes** WCAG contrast over every ink × surface pair against the floors
(not against pinned ratios — a palette edit that stays legal is not a
regression), asserts the two dark blocks are byte-equal after parsing (CSS cannot
share a declaration list, so they are written twice), asserts every `@theme
inline` key aliases a primitive that exists and inlines no literal, and asserts
the vocabulary is **closed** (Tailwind's default palette, extra type steps,
`font-serif` all cleared) so an off-system value cannot be spelled as a utility.
`styles/base-layer.test.ts` pins the layering rule above and asserts `base.css`
never regrows a component library. `cn.test.ts` pins each extended namespace, so
a token added to CSS but not to `cn.ts` fails a test rather than degrading a
layout.

---

## Engine contract gotchas

- **Verdict is exactly `{SAFE, DANGEROUS}`.** Audit failure is an `audit_error`
  event / ERROR state — **never** a SAFE verdict. Don't synthesize green from a
  crash.
- **The report is schemaVersion 2**: `{schemaVersion:2, verdict, rationale,
  counts, confirmedHypIds, hypotheses[], fileSummaries[], dealbreaker, trace[]}`.
  There is **no** `proofs[]` / `runtimeEvidence` / top-level `capabilities`.
  `verdict_reached` carries
  `{verdict, rationale, counts, confirmedCount}`.
- **The audit event union is exactly 17 types**, and `EVENT_TYPES`
  (`shared/src/events.ts`) is the one list — the engine registers its emit names
  and the client its listeners from the same source. The seven
  `agent_*` / `verify_*` / `finding_discovered` types that never had an emit site
  are **deleted** from the union; the fold still reaches `default` without
  throwing if a legacy replay carries one (`audit-fold.test.ts` C2). Build no UI
  on a name outside `EVENT_TYPES` — a name there the engine never emits is a
  permanently dead listener. The investigation is hypothesis-centric
  (`hypothesis_resolved`: CONFIRMED / REFUTED / DEFERRED), not an agent
  transcript.
- SSE wire framing: `id: {seq}\nevent: {type}\ndata: {json}\n\n`; the `data`
  JSON has `{type,auditId,timestamp,seq}` **flattened** in with the payload.
  Ignore `: keep-alive` comment frames.
- Resolve `latest`/empty versions via `GET /resolve/:name` **before**
  `POST /audit/stream` — the engine rejects non-semver.
- Scoped package names keep their slash: `/package/*` and `/resolve/*` are splat
  routes — never `encodeURIComponent` the whole name.
- On verdict, `App` canonicalizes `/audit/:id` → `/package/<name>` with raw
  `window.history.replaceState` so the router never remounts the live view. Do
  not replace it with `navigate()`.
- Payment is verified **server-side only** (`engine/npmguard/payments.py`): the
  wallet signs, the engine verifies. WalletConnect (mobile QR) lives in the CLI;
  the web app uses an **injected** browser wallet only, and no private-key path
  may exist in `lib/wallet.ts`. That last rule is **UNENFORCED** — an earlier
  version of this file called it grep-enforced, and no such grep, lint or test
  exists in the repo. Crypto contract + fee come from `GET /config/public`
  (`crypto: {chain, chainId, contract, auditFeeWei}`, or `crypto: null`), never
  hardcoded.
- Every engine route answers under `/api`, and that is the only surface with no
  ambiguity. App code reads `apiBase()` (`lib/config.ts`), never
  `import.meta.env` — the same built artifact must run behind the vite proxy,
  the engine's static server, and the e2e harness.
- **A page path and a root API path cannot both exist.** In production the engine
  serves `dist/` itself, so its own routes are matched before the SPA fallback: a
  root route named like a page wins, and a hard navigation, a refresh or a pasted
  link gets JSON. `/replays` and `/packages` are therefore `/api`-only
  (`api.py::client_owned_router`), and `/audit/{id}` is a page while everything
  below it is API. Vite is blind to all of this — it serves the SPA for every path
  and proxies only `/api` — so the guard is `e2e/static-serving.spec.ts`, the one
  Playwright project pointed at the engine origin.
- Demo / e2e determinism: `GET /demo/packages` + `POST /demo/start` replay
  committed recordings (`engine/demo-data/*.json`) with zero LLM and zero
  docker; `NPMGUARD_DEMO_SPEED` (an engine knob) fast-plays them. An empty demo
  list must render honestly — a package input, not a fake dropdown.
- React 19 without an ErrorBoundary renders a **blank page** on a component
  crash. `main.tsx` mounts the one (`components/ErrorBoundary.tsx`) outside both
  providers, and creates the QueryClient outside render (a client built inside a
  component is a new cache every render).

## Testing

See [`TESTING.md`](TESTING.md) for the class maps. Two pillars: blackbox
class-mapped **units** (fold replay-idempotence is a mandatory class, not an
edge case) and **e2e** that never mocks the engine — Playwright boots the real
uvicorn engine in demo mode (engine :8055, vite :3100, the panel fixture server
:8056, hermetic `.e2e-data`, `workers:1` because audit sessions and the SSE hub
are in-process engine state). The panel is proved against the same engine with
its five GitHub App credentials set and GitHub served by
`engine/tests/support/panel_e2e_server.py` — with them absent every panel route
503s, so a dashboard spec failing on "element not found" with no server error is
almost always a missing credential, not a selector.
Assert structure and lifecycle, never captured LLM prose. Stable locators are
`aria-label`s planted at build time.
