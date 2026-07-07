# Spec: GitHub Repo Panel — Audit & Protect

_2026-07-07 · brainstormed with user · status: approved-pending-review_

## 1. Goal

Turn NpmGuard from a per-package demo into a repo-level product: sign in with
GitHub, install the NpmGuard GitHub App on an org, see your repos in a panel,
and per repo choose **Audit** (scan the full lockfile once) or **Protect**
(continuous: rescan on dep-changing pushes **and** proactively audit new
versions of your deps the moment they're published to npm).

**Out of scope:** billing/subscriptions (free beta, sold manually), SSO/SAML,
roles beyond GitHub org membership, GitLab/Bitbucket, `bun.lockb`,
server-side range resolution for lockfile-less repos, dep-tree visualization,
the GitHub Action (superseded by the App for now), mainnet payments. The CLI
and per-package paid audits are untouched.

## 2. Approach selection

Three orthogonal architectures were considered:

| | Approach | Optimizes | Key tradeoff |
|---|---|---|---|
| **A (chosen)** | **Panel-in-engine monolith** — auth, webhooks, panel API, job queue, and registry-watch all live in the existing Hono engine; the existing React SPA grows a dashboard. One SQLite DB next to the report store. | Shared report cache + SSE natively; fastest path to an enterprise demo on the single-box deploy | Panel load and audit load share one process/box |
| B | Separate panel service — new web app + own DB, talks to the engine over HTTP | Isolation (panel bugs can't destabilize the audit engine) | Two services + cross-service auth on one Hetzner box; report cache accessed remotely; slowest to ship |
| C | GitHub-native first — lean on GitHub UI (checks, annotations) with a minimal web panel | Distribution speed, near-zero frontend work | User explicitly wants a panel; registry-watch needs server-side state anyway, so the "thin" promise is false |

**Why A:** the moat is the shared `(pkg, version)` report cache — every repo
scanned makes the next customer's scan cheaper. A keeps that cache, the SSE
event system, and the pipeline in-process. B's isolation is the right
long-term shape but wrong for a single-box free beta; revisit when load or
team size demands it. C fails the user's core requirement (a panel).

## 3. Architecture

```mermaid
flowchart TD
    subgraph GH["GitHub"]
        OAUTH[OAuth sign-in]
        APP[NpmGuard GitHub App<br/>installed per org, repo picker]
        HOOK[push / installation webhooks]
        CHECKS[Checks API]
    end

    subgraph ENGINE["engine (Hono, one process)"]
        AUTH[routes/auth.ts<br/>login · callback · me]
        PANEL[routes/panel.ts<br/>orgs · repos · scan · protect]
        GHOOK[routes/gh-webhooks.ts<br/>signature-verified]
        SCAN[scan/ repo-scan orchestrator<br/>lockfile fetch → parse → diff → enqueue]
        JOBS[jobs/ DB-backed queue<br/>cheap lane (N workers) · deep lane (1)]
        WATCH[watch/ registry poller<br/>ETag poll of indexed packages]
        ALERT[alerts/ checks + email]
        PIPE[existing audit pipeline]
        CACHE[(data/reports/&lt;pkg&gt;/&lt;ver&gt;.json<br/>shared report cache — unchanged)]
        DB[(data/npmguard.db — SQLite<br/>users · sessions · installations · repos<br/>repo_deps · scans · jobs · watches · usage)]
    end

    subgraph FE["frontend SPA (react-router)"]
        DASH[/dashboard — repo list<br/>Audit · Protect buttons/]
        REPO[/repo/:owner/:name — rollup verdict<br/>dep table · SSE progress · re-sync/]
    end

    OAUTH --> AUTH
    APP --> HOOK --> GHOOK
    GHOOK -->|lockfile touched| SCAN
    DASH --> PANEL --> SCAN
    SCAN --> JOBS -->|cache miss| PIPE --> CACHE
    JOBS --> WATCH
    WATCH -->|new version of indexed dep| JOBS
    PIPE -->|DANGEROUS| ALERT --> CHECKS
    ALERT -->|email on DANGEROUS| SMTP[SMTP]
    SCAN <--> DB
    FE <-->|SSE + JSON| ENGINE
```

**Data flow, Audit:** panel button → fetch lockfile via App installation token
(contents API) → parse to normalized `[(name, version, direct)]` → upsert
`repo_deps` → for each pair: report-cache hit = instant verdict; miss =
enqueue audit job → rollup recomputed as jobs complete → SSE progress to the
repo page.

**Data flow, Protect (two triggers, complementary):**
1. *Push webhook* — push touches a lockfile → diff new lockfile vs
   `repo_deps` → audit only added/changed pairs → post a GitHub check on the
   head commit → update index. The webhook is also what keeps `repo_deps`
   fresh — it is the substrate registry-watch alerts from.
2. *Registry-watch (the headline)* — poller checks npm for new versions of
   every distinct package in any protected repo's `repo_deps`. New version →
   audit it proactively. DANGEROUS → dashboard alert + email to the org,
   annotated with which repos are exposed (version satisfies a range they
   use) vs merely-related (pinned elsewhere). No GitHub check — there is no
   commit to attach one to. The CLI already guards the install moment; this
   guards the publish moment, before anyone installs.

## 4. User-confirmed design decisions

| # | Decision | User's choice |
|---|---|---|
| 1 | GitHub connection model | **GitHub App + OAuth sign-in on top** (the Vercel pattern: OAuth = identity, App install = repo access, webhooks, checks) |
| 2 | Audit scope | **Full lockfile (direct + transitive), cache-first**; pipeline's built-in triage governs per-package depth |
| 3 | Billing v1 | **Free beta, sell manually.** GitHub login is the gate; CLI per-audit payments untouched |
| 4 | Alert surface | **GitHub check on the commit + dashboard always + email on DANGEROUS** |
| 5 | Visibility | **Org-shared:** any member with access to the installation sees that org's repos/scans/Protect state |
| 6 | Results UI | **Rollup verdict (worst-dep-wins) + counts + filterable per-dep table** linking to existing package report pages; live SSE progress |
| 7 | Rescan semantics | **Diff-only** — never full rescans on push |
| 8 | Registry-watch | **In v1 — it's the core of Protect** ("we kind of want v2 first; the CLI already guards install-time") |
| 9 | Beta limits | **Soft caps per org** (protected repos, package-audits) with a "talk to us" wall; hitting the cap is a sales signal |
| 10 | Missed webhooks | **Daily reconcile job** (re-read HEAD lockfile, diff, heal) + manual Re-sync button |
| 11 | No parseable lockfile | **Clear failure state:** "commit package-lock.json / pnpm-lock.yaml / yarn.lock" — no server-side resolution in v1 |
| 12 | Check policy | **Fail only on DANGEROUS.** SUSPECT (when 4-state lands) = passing check with warning annotation; pending while audits run |

## 5. Technical decisions

Each with the options considered and the pick.

### 5.1 Persistence — **SQLite via `better-sqlite3`, hand-written migrations**
- *Postgres* — right if multi-node; pure ops overhead on one box.
- *JSON files + in-memory maps (status quo)* — cannot express sessions, jobs, or the dep index transactionally; restarts lose Protect state.
- **SQLite** — zero-ops, transactional, lives at `data/npmguard.db` beside the report store. No ORM (repo rule: configuration over abstraction); a 30-line migration runner (`schema_version` pragma) + typed row mappers. The report store stays the single source of truth for reports — the DB stores *everything that is not a report*.

### 5.2 Sessions — **DB-backed opaque token in an HttpOnly cookie**
- *JWT* — stateless but revocation requires a denylist, which is a DB anyway.
- *Encrypted cookie (iron-session style)* — no server state but same revocation problem.
- **Opaque 32-byte token, `sessions` table, `HttpOnly Secure SameSite=Lax`**, 30-day sliding expiry. Logout = row delete. Trivially revocable, no crypto to get wrong.

### 5.3 GitHub client — **`@octokit/app` + `@octokit/webhooks`**
- *Hand-rolled (jose + fetch)* — unnecessary JWT/signature crypto risk.
- *Probot* — a framework that wants to own the server; conflicts with Hono.
- **Octokit libs** — App JWT, installation-token minting/caching, and webhook signature verification are all solved, maintained code. Engine-side only (CLI stays crypto-dep-minimal per repo rules).

### 5.4 Job queue — **DB-backed `jobs` table + in-process worker pool, two lanes**
- *BullMQ + Redis* — new infrastructure on a single box for no gain.
- *Extend the in-memory queue* — loses queued Protect scans on every restart; reconcile would paper over data loss we caused ourselves.
- **`jobs` table** (id, kind, payload, org_id, state, attempts, timestamps) polled by an in-process pool. **Cheap lane** (tarball + inventory + LLM triage) at `NPMGUARD_SCAN_CONCURRENCY` (default 4); **deep lane** (investigation + Docker sandbox) stays concurrency 1 — same resource envelope as today. Round-robin across orgs so one big install can't starve others. Jobs survive restarts; `attempts` caps retries at 3. The existing `/audit` in-memory queue keeps working for CLI/CRE; migration of that path into the jobs table is a follow-up, not v1.

### 5.5 Lockfile parsing — **npm v2/v3 + pnpm first-class; yarn classic best-effort**
- *Snyk's `nodejs-lockfile-parser`* — heavy dep tree for what is mostly JSON/YAML reading.
- *npm only* — bounces pnpm-heavy orgs, common in exactly the modern-stack companies we're selling to.
- **Own thin parsers** in `engine/src/lockfile/`: `package-lock.json` v2/v3 (JSON walk of `packages`), `pnpm-lock.yaml` (yaml dep walk), `yarn.lock` classic (`@yarnpkg/lockfile`). Output normalized `{ name, version, direct }[]`. Unsupported format → the decision-11 failure state naming what we *do* support.

### 5.6 Registry-watch mechanism — **per-package ETag polling**
- *npm replicate `_changes` feed* — historically unreliable/deprecated surface; a firehose when we care about a bounded set.
- *Third-party feeds* — external dependency for core product function.
- **Poll `registry.npmjs.org/<pkg>` with `If-None-Match`** for every distinct package in protected repos' `repo_deps` (typically low thousands), every `NPMGUARD_WATCH_INTERVAL_MIN` (default 15). 304s are free; on change, diff the versions list vs `watched_packages.known_versions`, enqueue audits for new ones (cheap lane, org attribution = all exposed orgs). Bounded, reliable, cheap.

### 5.7 Email — **nodemailer + SMTP URL config**
- *Resend/Postmark SDK* — nicer API, but binds to a vendor; SMTP config covers them all anyway (repo rule: configuration over abstraction).
- *Defer email entirely* — user confirmed email-on-DANGEROUS is v1.
- **`nodemailer` with `NPMGUARD_SMTP_URL`**, one template: package, version, verdict, exposed repos, report link. Sent to the emails of users in the affected org (from their GitHub profile at sign-in; overridable per-org alert address later).

### 5.8 Frontend routing — **adopt `react-router` (library mode)**
- *Extend the regex approach* — already strained at 4 routes; dashboard adds ~5 more plus auth redirects.
- *TanStack Router* — stronger types, heavier adoption cost for this codebase size.
- **react-router v7 library mode.** Existing paths (`/`, `/audit/:id`, `/packages`, `/package/*`, `/benchmark`) become routes with behavior preserved (including the checkout `session_id` and verdict-canonicalization effects); new: `/dashboard`, `/repo/:owner/:name`, `/auth/complete`. Mechanical migration of `App.tsx`.

### 5.9 Token storage — **AES-256-GCM-encrypted user tokens in SQLite**
- *Don't store; re-derive per request* — user OAuth tokens are needed by the reconcile job when the user is offline.
- *Plaintext rows* — dependency lists of private repos are sensitive; the DB file must not be a credential dump.
- **Encrypt user access/refresh tokens with `NPMGUARD_ENCRYPTION_KEY`** (32-byte, env). Installation tokens are ephemeral (~1h) — minted on demand via the App key and cached in memory only. The App private key lives on disk outside the repo, path via env.

### 5.10 Rollup + check mapping (forward-compatible with 4-state)
Severity order `DANGEROUS > SUSPECT > UNKNOWN > SAFE`; repo verdict = max over
dep verdicts, alongside counts `{dangerous, suspect, unknown/pending, safe}`.
Today reports emit 2-state — the mapping degrades gracefully. GitHub check
conclusion: any DANGEROUS → `failure`; else audits pending → stay
`in_progress`; else → `success` (SUSPECT, when it exists, → `success` +
warning annotation). Never block on suspicion (decision 12).

## 6. Changes

| File | Change |
|---|---|
| `engine/src/db.ts` | **new** — better-sqlite3 open, migration runner, typed accessors |
| `engine/migrations/*.sql` | **new** — users, sessions, installations, repos, repo_deps, scans, jobs, watched_packages, org_usage, alerts |
| `engine/src/github/app.ts` | **new** — octokit App client, installation-token cache |
| `engine/src/github/content.ts` | **new** — fetch lockfiles/manifest via contents API |
| `engine/src/github/checks.ts` | **new** — create/update check runs per §5.10 |
| `engine/src/routes/auth.ts` | **new** — `/auth/github/login`, `/auth/github/callback`, `/auth/logout`, `/me` |
| `engine/src/routes/gh-webhooks.ts` | **new** — `POST /webhooks/github`: signature verify; `installation`, `installation_repositories`, `push` handlers |
| `engine/src/routes/panel.ts` | **new** — `GET /panel/orgs`, `GET /panel/repos`, `GET /panel/repo/:id`, `POST /panel/repo/:id/scan`, `POST /panel/repo/:id/protect`, `DELETE .../protect`, `POST .../resync`; all session-gated, installation-membership-checked |
| `engine/src/lockfile/{npm,pnpm,yarn,index}.ts` | **new** — parsers → normalized dep list |
| `engine/src/scan/repo-scan.ts` | **new** — orchestrator: fetch → parse → diff vs repo_deps → enqueue → rollup; emits SSE via existing `events.ts` session pattern |
| `engine/src/jobs/{queue,workers,reconcile}.ts` | **new** — jobs table polling, two lanes, org round-robin; daily reconcile of protected repos |
| `engine/src/watch/poller.ts` | **new** — ETag polling, new-version detection, audit enqueue, exposure computation |
| `engine/src/alerts/{email,notify}.ts` | **new** — nodemailer template; dashboard alert rows; DANGEROUS fan-out |
| `engine/src/caps.ts` | **new** — org_usage counters, soft-cap checks (`NPMGUARD_BETA_MAX_PROTECTED_REPOS`=10, `NPMGUARD_BETA_MAX_AUDITS_MONTH`=5000) |
| `engine/src/index.ts` | mount new subrouters on `/` (same namespace — `/api/*` mirror constraint holds); start workers, poller, reconcile timer |
| `engine/src/config.ts` | new env vars (see §7) |
| `engine/package.json` | + `better-sqlite3`, `@octokit/app`, `@octokit/webhooks`, `nodemailer`, `yaml`, `@yarnpkg/lockfile` |
| `frontend/src/main.tsx` + `App.tsx` | react-router adoption; existing routes preserved |
| `frontend/src/pages/Dashboard.tsx` | **new** — installations → repo list; status chips; Audit / Protect buttons; cap banner |
| `frontend/src/pages/RepoDetail.tsx` | **new** — rollup banner, counts, filterable dep table (name, version, verdict, direct/transitive, report link), SSE scan progress, Protect toggle, Re-sync, alerts feed |
| `frontend/src/components/Header.tsx` | sign-in/avatar/sign-out |
| `frontend/src/stores/panelStore.ts` | **new** — session, repos, scan progress |
| `deploy/` + `docs/ops/DEPLOYMENT_PLAYBOOK.md` | nginx route for `/webhooks/github`; env provisioning; note: **deploys currently manual** |

## 7. New environment variables

`NPMGUARD_GITHUB_APP_ID`, `NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH`,
`NPMGUARD_GITHUB_CLIENT_ID`, `NPMGUARD_GITHUB_CLIENT_SECRET`,
`NPMGUARD_GITHUB_WEBHOOK_SECRET`, `NPMGUARD_ENCRYPTION_KEY`,
`NPMGUARD_SMTP_URL`, `NPMGUARD_ALERT_FROM`, `NPMGUARD_PANEL_BASE_URL`,
`NPMGUARD_SCAN_CONCURRENCY` (4), `NPMGUARD_WATCH_INTERVAL_MIN` (15),
`NPMGUARD_BETA_MAX_PROTECTED_REPOS` (10), `NPMGUARD_BETA_MAX_AUDITS_MONTH` (5000).

**Manual prerequisite (user):** register the GitHub App (name, homepage,
OAuth callback `https://npmguard.com/auth/github/callback`, webhook URL
`https://npmguard.com/webhooks/github` + secret; permissions: Contents:read,
Checks:write, Metadata:read; events: push, installation,
installation_repositories), generate the private key, provision prod `.env`.
Prod deploys are manual until the deploy webhook is fixed.

## 8. Implementation phases

1. **Foundation** — DB + migrations, auth routes, sessions, App install
   handshake, `/dashboard` listing repos. *Demo: sign in, see your repos.*
2. **Audit** — lockfile fetch/parse, repo-scan orchestrator, jobs table +
   cheap/deep lanes, rollup, RepoDetail page with SSE progress, caps.
   *Demo: click Audit, watch 1,200 deps resolve to a verdict.*
3. **Protect (commit path)** — push webhook, lockfile diff, delta scans,
   GitHub checks, dep index maintenance, daily reconcile + Re-sync.
4. **Protect (publish path — the headline)** — registry poller, proactive
   audits of new versions, exposure computation, dashboard alerts + email on
   DANGEROUS.

Phases 3+4 ship together as "Protect"; 4 is the pitch, 3 is its substrate.

## 9. Tests

1. **Lockfile parsers** — fixtures for npm v2, npm v3, pnpm, yarn classic → identical normalized output; scoped packages; unsupported format → typed error.
2. **Lockfile diff** — add/remove/version-change produce exactly the changed `(name, version)` pairs; no-op push → zero jobs.
3. **Webhook signature** — invalid HMAC → 401, no side effects; valid `push` not touching lockfiles → index untouched.
4. **Cache-first scan** — repo whose deps are all cached → scan completes with zero pipeline invocations; mixed → jobs only for misses.
5. **Rollup** — 1 DANGEROUS among 1,200 SAFE → repo DANGEROUS; pending audits → UNKNOWN counts, rollup not SAFE until resolved.
6. **Check policy** — DANGEROUS → `failure`; all SAFE → `success`; pending → `in_progress`; (future) SUSPECT → `success` + annotation.
7. **Registry-watch** — poller detects new version vs `known_versions`, enqueues exactly one audit across N exposed orgs; DANGEROUS verdict → alert rows + one email per org; exposure = range-satisfaction per repo.
8. **Reconcile** — mutate HEAD lockfile without a webhook → daily job detects drift, triggers diff scan, index converges.
9. **Caps** — org at audit cap → new scan rejected with "talk to us" payload; protect cap → toggle rejected; counters reset monthly.
10. **Sessions** — login sets HttpOnly cookie; `/panel/*` without session → 401; logout revokes; user without installation access → 403 on that org's resources.
11. **Job durability** — kill process with queued jobs → restart resumes; job failing 3× → marked failed, scan rollup shows it as UNKNOWN, not silently SAFE.
12. **No-lockfile repo** — Audit returns the decision-11 failure state naming supported formats; nothing enqueued.

## 10. Open items deliberately deferred

- 4-state verdict cascade (PLAN.md #2) — this spec consumes it when it lands.
- Migrating CLI/CRE `/audit` path onto the jobs table.
- Per-org alert address + strictness knob (fail-on-SUSPECT opt-in).
- Registry-watch upgrade from polling to a changes feed if a reliable one exists.
- Billing (Stripe subscriptions) once manual enterprise deals define the SKU.
