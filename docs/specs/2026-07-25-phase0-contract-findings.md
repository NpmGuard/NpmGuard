# Phase 0 — contract reconciliation findings + authoring decisions

Two independent read-only reconciliations were run against the two hand-kept
copies of the wire contract (engine route dicts / `shared/src/*.ts` zod, vs
`frontend/src/lib/engine-types.ts`). This file records what they found and, for
each finding, the decision that `shared/src/{panel,replay,bench}.ts` is authored
against. It is the authoring spec for task #8.

Every finding is a **reachable state the code cannot act on coherently** — the
N-4 lens. They are grouped by whether the fix belongs in the contract, the
engine, or the frontend.

---

## A. Audit-core: is the zod accurate?

**Verdict: the report is ACCURATE; the events are PARTIALLY STALE.**

All 9 `AuditReport` fields (`shared/src/backend.ts:21-32`) and every referenced
sub-model (`Hypothesis`, `Claim`, `HypothesisCounts`, `FileSummary`,
`DealBreaker`, `PhaseLog`, `FocusRange`, `EvidenceRef`, `ToolCall`) match the
engine's construction *and* a real dumped report
(`engine/demo-data/test-pkg-env-exfil.json`). The frontend's hand-written copy is
a faithful transcription, **not** a correction.

★ **This retires the stated premise for hand-writing.** `engine-types.ts:12-19`
justifies itself by claiming the shared contract is stale relative to the Python
engine. For the report that is false — the zod already *is* schemaVersion 2,
already *is* `{SAFE, DANGEROUS}`, already carries `hypotheses[] + counts` and no
`proofs[]`. Every "IMPORTANT" bullet in that header describes what shared already
says. The hand-written copy bought nothing there and cost a drift surface.

Where hand-writing *did* pay off: the events. Which is exactly why the fix is
"make the contract correct and verify it at runtime", not "keep hand-writing".

### A1 ★ `suspiciousLines` is `.optional()` but the wire sends `null`

`shared/src/models.ts:110` declares `suspiciousLines: z.string().optional()`.
The engine sets it to `None` (`pipeline.py:104`) and `events.py:15` dumps with
`exclude_none=False`, so **every clean file emits explicit `null`**. Confirmed on
the wire in `engine/demo-data/chalk.json`. `z.string().optional()` accepts
`undefined`, **not `null`** — so `FileVerdictSchema.parse()` throws on every
clean file. This would have broken boundary validation on day one.

The comment at `models.ts:109` justifies `.optional()` with *"MiniMax rejects
union types like `["string","null"]`"*. **I verified that justification is
stale**, two independent ways:

1. `FileVerdict` is constructed by the engine at `pipeline.py:100` and is
   **never** an LLM output schema — the only `output=` passed to the LLM is at
   `phases.py:680`, and it is not this.
2. The engine's own strict-schema projector states the opposite requirement:
   `kit_llm/schema.py:45-49` instructs *"express optionality as `| None`"*. And
   the generated Pydantic already says `str | None = None`
   (`contract/models.py:137`), so the constraint the comment protects isn't even
   achieved on the Python side.

**Root cause:** a schema that used to be an LLM output kept an LLM-driven
constraint after becoming a pure wire shape, and the comment fossilised the
reason. Classic haziness — an assertion about what "must" hold that no longer
does, which stops the next reader from judging it.

**DECISION:** wire shapes use `.nullable()`. General rule to encode, because
this is systemic: **`events.py:15` dumps `exclude_none=False`, so every Optional
engine field appears on the wire as explicit `null`. A wire schema must therefore
never express nullability as `.optional()`.** Same fix for `FocusArea.lines`
(`models.ts:91`), which carries the identical stale comment.

### A2 `inventory_meta.metadata` understates 7 fields as 4

`shared/src/events.ts:151-156` inlines `{name, version, description, license}`,
but `pipeline.py:234` emits `inventory.metadata`, a `PackageMetadata`
(`backend.ts:56-64`) with 7 fields — `homepage`, `keywords`, `repository` are
dropped. Zod strips unknown keys so it parses; the type just lies. **The frontend
makes the identical mistake** (`engine-types.ts:167-172`), so this is a genuine
shared-side fix, not a disagreement.

**DECISION:** reference `PackageMetadataSchema`, don't inline.

### A3 ★ LIVE BUG — the dependency counts always render zero

`frontend/src/lib/audit-fold.ts:235-236` reads
`meta.dependencies["dependencies"]` and `["devDependencies"]`. The engine's group
keys are `prod` / `dev` / `optional` / `peer` (`inventory.py:120-123`, confirmed
on the wire). Both lookups are permanently `undefined`, so the pipeline log
renders **"0 prod · 0 dev dependencies" for every package, always.**

The type didn't catch it because both sides declare an unkeyed map
(`events.ts:145`: `z.record(z.record(z.string()))`).

**DECISION:** fix the fold, and **key the schema** `{prod, dev, optional, peer}`
so the class can't recur. A discriminating test must fail on the old code.

### A4 Three emitted events have no schema; seven schemas are dead

Emitted but unschematised: `dependencies_provisioned` (`pipeline.py:193`),
`intent_extracted` (`pipeline.py:278`), `graph_built` (`pipeline.py:359`). All
three appear in every committed SSE skeleton.

Dead (zero emit sites; only vestigial entries in `demo.py:25-32`'s playback
delay map): `agent_thinking`, `agent_tool_call`, `agent_tool_result`,
`agent_reasoning`, `finding_discovered`, `verify_started`, `verify_test_result`.
`sse.ts` registers one listener per declared name, so **seven listeners are
permanently dead**, and the fold carries ~7 dead switch arms.

Engine emits **17** types; `shared/events.ts` declares 21; the frontend declares
24. All three CLAUDE.md claims about this were verified **exactly true**.

**DECISION:** add the 3 missing schemas. **Delete the 7 dead ones** — an
unreachable state is pure cost: it can't be tested, can't be trusted, and every
reader must re-derive that it's dead. Forward-compat is not a justification for
seven fictional members of a union that the fold, the listener registration, and
the type surface all pay for. (N-4: make it unreachable, don't handle it.)

### A5 `TriageHypothesisSchema` isn't exported, so codegen mangled it

`shared/src/events.ts:55` declares it as a non-exported `const`, so
`contract-export.ts:14-18` (which collects only exported `*Schema` values)
inlined it — which is why the generated Python class is named `Hypothes`
(`contract/models.py:335`). The frontend needs the type (`audit-fold.ts:23`).

**DECISION:** export it.

### A6 Two report-construction sites

`_report()` (`pipeline.py:111`) and the dealbreaker early-return
(`pipeline.py:250-260`). Same shape, so no contract impact — but any field
addition must touch both. Worth an `INVARIANT:` note rather than a silent trap.

---

## B. Panel: what the engine actually emits

### B1 ★★ `lastScan` is dead, and it takes three dashboard surfaces with it

Worse than a dead field. `"lastScan": None` is hardcoded at `panel.py:259`
(`/panel/repos`) and `panel.py:688` (repo detail), while the frontend declares
`ScanSummary | null` and **five components read it**:

- `RepoCard.tsx:23,42,60` — running state, accent colour, the entire `ScanStatus` widget
- `Dashboard.tsx:30,136,143` — so **the "Attention" filter can never match**, and **"Not audited" always matches every repo**
- `PortfolioPosture.tsx:22,34` — the posture rail and the "N audited" counter, **always 0**

The data is right there: `_last_scan_row` already exists (`panel.py:439-461`).

**DECISION (resolves O-4):** keep the field, **fix the engine**. The dashboard's
whole triage story is inert without it, so deleting it would mean deleting the
triage. Note the cost: `/panel/repos` needs one scan row per repo — a window
function or lateral join, not N queries.

### B2 Hardcoded constants of the same shape

| What | Site | Reality |
|---|---|---|
| `PublicScan.commitSha` | `public_repos.py:424` passes `commit_sha=None` unconditionally | **always null** — and a snapshot without a commit sha is not reproducible. The value is in hand at `public_repos.py:347`. |
| `PublicScan.error` | `public_repos.py:146` reads it; **nothing ever writes** `public_repo_scans.error` | always null → `PublicAuditReportDialog.tsx:128` is dead UI |
| `scans.error` | never written either | not on the wire at all (fine, but note `ScanSummary` has no `error` while `PublicScan` does) |

**DECISION:** populate `commitSha` (engine fix). For `error`: it only becomes
meaningful once scans can actually fail — see B3, and they're one decision.

### B3 ★ `ScanSummary.status: "failed"` is unreachable — a crashed scan runs forever

Only two writers exist: `repo_scan.py:199` sets `"running"`, `repo_scan.py:326`
sets `"done"`. **No `"failed"` writer anywhere.** So a scan whose engine died
stays `running` in perpetuity, and five UI branches for the failed state are
dead (`ScanStatus.tsx:44-51`, `tone.tsx:48`, `RepoDetail.tsx:290-296`,
`Dashboard.tsx:32`, `PortfolioPosture.tsx:26`).

The *intent* is real and the UI is already built for it. What's missing is the
engine transition.

**DECISION:** keep `"failed"` in the contract and **implement the transition**.
This is the same shape of bug as B1 — a declared state with no producer — and the
same fix direction: the type is the intent, the emission is the defect. Pairs
with B2's `error` field, which is what a failed scan would populate.

### B4 ★ `scan.verdict` is computed over the wrong dep set

`panel.py:675` computes the rollup from **`repo_deps`** (the repo's *current*
index) and `panel.py:692` then reports it as *that scan's* verdict. But a scan's
coverage is its `scan_items`, and a **delta** scan covers only changed pairs
(`repo_scan.py:271`); `repo_deps` may also have been wholly replaced since
(`repo_scan.py:443-471`).

The engine already computes the correct thing elsewhere — `repo_scan.py:329`
rolls up `_scan_item_states` for the GitHub check-run. **So there are two
different answers to "what was this scan's verdict" in the same codebase.**

**DECISION:** the scan's verdict is the rollup over **its own items**. One
function, used by both the check-run and the wire. This is precisely the R-1
duplication thesis showing up as a correctness bug rather than just repetition.

### B5 Same fact, two wire names, and one side lossy

| Fact | Repo detail | Public detail | Decision |
|---|---|---|---|
| `package_verdicts.reason` | `verdictReason` (`panel.py:668`) | `reason` (`public_repos.py:286`) | **`verdictReason`** — more specific |
| active job state | `jobState`: `queued\|running\|failed\|null` (`panel.py:671`) | `active`: **boolean** (`public_repos.py:289`) — collapses the same predicate and **throws the `failed` signal away** | **`jobState`** — the public side is strictly lossier; `PublicAuditReportDialog.tsx:16` literally cannot tell queued from failed |

### B6 The verdict domain, measured

Per-dep is factually **`SAFE | DANGEROUS | null`** — `LANDABLE_VERDICTS`
(`verdict_index.py:32`) gates every write into `package_verdicts`. Rollup adds
`UNKNOWN`. **`SUSPECT` is unreachable everywhere**: `rollup.suspect` can only
increment from a `SUSPECT` dep verdict, which cannot exist — so `Rollup.suspect`
is **always 0**.

`UNKNOWN` conflates three distinct facts: not audited yet, audit failed, audit
inconclusive. (Inconclusive audits never land — they become `null` +
`jobState: "failed"`.)

Dead handling that exists solely for the phantoms: `verdict_index.py:28`,
`public_repos.py:222-224` (SQL `CASE` arms for both, where `else_=2` already
covers it), `checks.py:31-45`, `tone.tsx:23-24`, and ~11 sites in
`RepoDetail.tsx` / `Dashboard.tsx` / `PortfolioPosture.tsx` /
`PublicAuditReportDialog.tsx`.

**DECISION (confirms §4.4):** contract declares outcome `SAFE | ERROR |
DANGEROUS` with progress on a separate axis. Independent confirmation: the
reconciliation reached the same conclusion unprompted — the 3-state shape "matches
the emission better than the current 4-state wire."

### B7 Alerts: three smaller drifts

- **`verdict` typed bare `string`** (`engine-types.ts:430`) while `notify.py:248`
  only ever inserts `"DANGEROUS"`. That widening is what forced `tone.tsx:15` to
  accept `string`. → narrow it.
- **`message`** declared non-null but the column is nullable
  (`tables.py:288`); the only writer always supplies one. → declare `string`
  **and** tighten the column, so the schema isn't a lie a hand-inserted row can
  expose.
- **`kind` mislabels public audits.** `jobs.py:352` derives
  `"watch" if job.scan_id is None else "scan"`, and public-repo audits
  deliberately enqueue with `scan_id=None` (`public_repo_scan.py:255`) — so a
  DANGEROUS finding from a *public repo audit* is filed as `"watch"`. → the
  origin belongs on the job, which is exactly what R-1's `origin` field provides.
- **`repoId` nullability is real but its stated reason is false.**
  `panel.py:822-825` claims the watcher raises package-level alerts with no repo;
  every alert actually goes through `_collect_exposure` (`notify.py:117-208`) and
  always carries a `repo_id`. The nullability comes from `ON DELETE SET NULL`.
  → keep nullable, fix the comment.

### B8 `RepoDetailResponse.rollup` is emitted and never read

`panel.py:691` emits it; the only consumer `RepoDetail.tsx:176-192`
**recomputes the identical counters client-side** and never reads it (zero reads
repo-wide). A third independent implementation of the same rollup.

**DECISION:** one server-side rollup, consumed by the client. Deleting the client
recompute also deletes the `SUSPECT`/`UNKNOWN` counters it hand-rolls.

### B9 Untyped shapes the store sniffs structurally

No type exists for: `{error}` (~20 sites, 9 statuses), `{error, reauth: true}`
(sniffed at `api-base.ts:41-50`), the 409 `{error, scanId}` (sniffed at
`panelStore.ts:210-216`), the 503 App-disabled body (**unhandled entirely**),
`{ok, updated}` (`updated` dropped), and the `{scanId}` / `{ok}` / `{url}`
wrappers (inline literals in `panel-api.ts`).

**DECISION:** name all of them. Structural sniffing is the symptom of a missing
type — `typeof body["scanId"] === "number"` is a runtime guess at a fact the
contract should state.

### B10 `panelStore.triggerScan` mishandles a live scan as an error

The repo-scan 409 (`panel.py:478`) is structurally identical to the public-repo
409 (`public_repos.py:369`). `panelStore.ts:210-216` treats the public one as
**success** (a scan is already running — that's fine, stream it);
`triggerScan` (`panelStore.ts:264-280`) does **not**, so a concurrent repo scan
surfaces as a red error banner while a scan is live and streamable.

Naming the 409 body forces both call sites to handle it.

### B11 A stale test fixture hides TS-engine-era drift

`stores/panelStore.test.ts:79-93` builds a `PanelRepo` with `githubRepoId`,
`htmlUrl`, `accountLogin`, `lockfilePath`, `scan`, and a `rollup` containing
`total` — none of which the current contract has — and silences the mismatch with
`as unknown as PanelRepo`. A cast that wide is a test asserting against a shape
the engine never emits.

**DECISION:** the cast goes. Generated types make it a compile error, which is
the point.

### B12 Request-validation contracts disagree for the same field

`installationId` is validated strictly in `public_repos.py:323` (real `int`, not
`bool`, `> 0`) and leniently in `billing.py:45-51` (`int(value)` accepts `"123"`
and `True`). The frontend always sends a number, so it's latent.

**DECISION:** strict, one shared parser.

---

## C. Intra-engine duplication (the R-1 evidence base)

The reconciliation found **eleven** duplications. This is much stronger evidence
for R-1 than the three-table observation the design doc was built on:

1. **Dep projection ×3** with divergent names and types (`panel.py:661-674`,
   `panel.py:765-775`, `public_repos.py:278-292`) — plus a 4th off-wire
   projection with a 5th naming at `verdict_index.py:191-197`.
2. **Rollup: 4 call sites over 3 different dep sets** — the direct cause of B4.
3. `_cap_response` — **byte-identical** in `panel.py:271-282` and
   `public_repos.py:78-88`.
4. `_not_signed_in` ×3 + a 4th inline copy.
5. `_user_has_installation` ×3, with **three different signatures**.
6. **Repo projection ×3** — and the two camelCase copies are how `lastScan: None`
   got duplicated into both routes. B1 is a *consequence* of this duplication.
7. Installation projection doubles as DB input, with the account-fallback logic
   re-implemented in the webhook path.
8. **Scan-progress finalization duplicated wholesale** —
   `refresh_scan_progress` vs `refresh_public_scan_progress`, `_scan_item_states`
   vs `_public_item_states`, `refresh_scans_touching` vs
   `refresh_public_scans_touching`.
9. Dedupe helper ×2 (`_dedupe` / `_unique_deps`) — identical.
10. Active-job predicate ×4.
11. Rollup recomputed client-side (B8).

**Every one of these collapses under R-1's `audit_sets` + one projection per
shape.** Findings B1, B4, B7-kind, and B5 are all *consequences* of items on this
list — which is the strongest possible argument that R-1 is a correctness fix, not
a tidiness exercise.

---

## C2. The target shape — `AuditSet` (authored now, per D-5)

The generalized entity R-1 migrates the tables to. Authored in the contract
first so Phase 1 and R-1 have a fixed target.

### The key move: the set is uniformly *progress*; its subject lives outside it

The obvious generalization is a discriminated union on `origin`, so a
`repo_scan` set carries a repo and a `bench_run` set carries a corpus. That's
worse: it makes every consumer of progress destructure a union to read a counter.

Instead — **an `AuditSet` is only ever "a set of `(name, version)` being audited,
and how far along it is". What the set is *about* belongs to the enclosing
response.** Repo detail returns `{repo, set, deps, alerts}`; a public scan returns
`{repo, set, deps}`; a bench run returns `{corpus, set, items}`. No union, one
uniform progress/rollup type, and adding `dep_tree` adds no wire complexity at
all.

```ts
AuditSetOrigin  = "repo_scan" | "public_repo_scan" | "dep_tree" | "bench_run" | "watchlist"
AuditSetTrigger = "manual" | "push" | "reconcile" | "publish"
AuditSetStatus  = "running" | "done" | "failed"   // `failed` gains a producer (B3)
Outcome         = "SAFE" | "ERROR" | "DANGEROUS"  // §4.4; null until concluded
```

### One counters object, with a stated invariant

Today a scan carries `{total, cached, audited, failed}` **and** a separate
`Rollup` carries `{verdict, dangerous, suspect, unknown, safe}`. Two objects
counting the same items, and neither sums to anything checkable — which is how
`unknown` came to mean three different things.

```ts
AuditSetRollup = {
  outcome:   Outcome | null,   // max severity over CONCLUDED items; null if none concluded
  total:     number,
  safe:      number,
  dangerous: number,
  error:     number,           // audits that could not conclude
  pending:   number,           // not yet concluded (unaudited | queued | running)
  cached:    number,           // resolved from an existing report (subset of concluded)
}
```

**INVARIANT: `safe + dangerous + error + pending == total`.** That is the whole
point — it is checkable, it is assertable server-side, and it makes the old
`unknown` bucket impossible to reintroduce because every item is in exactly one
of four states. `cached` is deliberately orthogonal (a subset of the concluded
three), so it is excluded from the sum.

Severity for `outcome`: `DANGEROUS > ERROR > SAFE`, computed over concluded items
only. `pending` never contributes to the outcome — a half-finished set is not
"unknown", it is "SAFE so far, N pending", and the UI can say exactly that.

### The set itself

```ts
AuditSet = {
  id:         number,
  origin:     AuditSetOrigin,
  trigger:    AuditSetTrigger,
  status:     AuditSetStatus,
  rollup:     AuditSetRollup,
  commitSha:  string | null,   // populated for repo origins (fixes B2)
  error:      string | null,   // populated when status === "failed" (B2/B3)
  startedAt:  string,
  finishedAt: string | null,   // non-null iff status !== "running"
}
```

`status` vs `rollup.outcome` are the §4.4 two axes at set level: `status` is
progress (did the *set* finish), `outcome` is the verdict over its items.

### One dep shape, the richer of the two

Per B5, unify on the repo-detail names — `verdictReason` and `jobState` — and
delete the lossy public variant (`reason`, `active`):

```ts
AuditSetItem = {
  name: string, version: string,
  direct: boolean, range: string | null,
  outcome: Outcome | null,          // SAFE | DANGEROUS today; ERROR when B3 lands
  verdictReason: string | null,
  evidenceCount: number,
  auditedAt: string | null,
  jobState: "queued" | "running" | "failed" | null,
  cached: boolean,
}
```

### Error bodies get names (B9)

`ApiError {error}`, `ReauthRequired {error, reauth: true}`,
`CapExceeded {error, cap: true, resource, installationId, entitlements}`,
`ScanAlreadyRunning {error, scanId}`, `AppNotConfigured {error}`. Naming the 409
is what forces `triggerScan` to stop treating a live scan as a red error (B10).

## D. Authoring order

1. **Audit-core shared fixes** (A1, A2, A4-add, A5) + the keyed dependencies
   schema (A3) — these gate anything importing shared. Regenerate
   `contract/models.py`; it is imported by 12 engine modules, so this is not
   frontend-local.
2. **Frontend fold fix** (A3) with a discriminating test.
3. **Delete the 7 dead events** (A4) — contract, fold arms, listener names.
4. **Author `shared/src/panel.ts`** at target shape: generalized audit-set,
   3-state outcome, `verdictReason` + `jobState` everywhere, every error body
   named, `lastScan` kept.
5. `shared/src/replay.ts`, `shared/src/bench.ts`.
6. Frontend imports from shared; `engine-types.ts` keeps only what has no schema.
7. Boundary validation in the API layer.

Engine *behaviour* fixes surfaced here (B1 populate `lastScan`, B2 `commitSha`,
B3 the `failed` transition, B4 scan-own-items rollup, B7 column tightening) are
**Phase 1 / R-1 work** — Phase 0 authors the contract that makes them required,
and each one then has a failing boundary to fix against.
