# Invariant map + adversarial audit — `d1c4cd7` and `ced29f2`

Read-only audit of two commits against the project's own standards (N-0, N-3, N-4,
N-7, §4.4, D-9). Nothing in this document was fixed; it is a findings ledger.

## 0. Method, provenance, and how to reproduce

Methodologies applied, all three read in full before starting:

- `~/.claude/skills/code-quality/SKILL.md` — Phase 1 doc discovery → Phase 2 audit
  against project standards → Phase 4 summary. Phase 3 (execute changes) is
  deliberately **not** performed: this run is read-only, so its output is the
  ranked task list Phase 3 would have consumed.
- `~/.claude/skills/invariant-map/SKILL.md` — §1 below is its prescribed output:
  a leverage-ranked boundary table, ending with the one boundary to hand
  `invariant-audit` first.
- `~/.claude/skills/invariant-audit/SKILL.md` — §2 below is its Phase 4 report
  format (invariant / enforcement / branches removed / counterexample), applied
  *retrospectively* to invariants the two commits already landed.

Context read: `AUDIT_CORE_EXPLAINED.md` §24 + §24.0, §15, §18; the v3 design doc
§3 (N-0…N-14), §4.4, §8c D-9 and D-5; `engine/CLAUDE.md`; `engine/TESTING.md`;
`shared/src/panel.ts`; `engine/scripts/gate.sh`.

All code was read from an **isolated worktree at `ced29f2`** (the shared tree has
five other agents writing to it, and its `docs/` and `engine/` already diverge —
`§24.0` in the working tree describes a `stubUrl` fix that does not exist at
`ced29f2`). Every claim below is against `ced29f2`.

Empirical verification used two independent methods, both in throwaway worktrees
deleted afterwards: **ten probe tests** exercising real production objects, and a
**revert pass** that restored each fix's production hunk to its pre-commit
semantics and re-ran the new tests to see whether they actually fail (N-7). Where
a commit replaced an API wholesale, the revert was behaviour-only — new signatures
kept, old semantics restored — since a plain revert would test the rename rather
than the claim. Findings are labelled:

- **CONFIRMED** — I executed code that produced the stated wrong output, or the
  path is a direct read of unambiguous code with no reachability question left.
- **PLAUSIBLE** — reasoned from code but not executed end to end.

The two labels are never blurred. Where a finding is confirmed, the probe output
is quoted verbatim.

---

## 1. Invariant map — panel verdict domain + evidence rendering

`27` `INVARIANT:` markers across 15 engine modules; the two commits added 10 of
them. 9 boundaries examined; ranked by how much complexity a single *missing*
invariant is still causing.

| rank | boundary (file:sym) | symptom | candidate invariant | home |
|---|---|---|---|---|
| 1 | `panel/scan/repo_scan.py:405 refresh_scan_progress` → `api.py:703 finalize_check` | a finished set with **nothing concluded** is representable, and the only branch for it is "leave the GitHub check open forever" | "a set that reaches `status=done` has an outcome, or `total == 0` is itself a terminal outcome" | **this** (the transition owns it) |
| 2 | `evidence.py:474 _describe` (canary correlation) | absence of the `carries planted env` clause carries two incompatible meanings — "checked, absent" and "not checked" | "a rendered negative states its own coverage; a canary is a high-entropy nonce, not any env value ≥ 8 chars" | **UPSTREAM: `experiments.py:_set_env`** (the bait must be minted, not inherited) |
| 3 | `panel/scan/repo_scan.py:452` (`scans.status` writer) | `status='failed'` has **zero writers**; every UI branch for it is dead, and a wedged scan stays `running` forever and 409s all future manual scans | "`scans.status` ∈ {running, done}" — *or* give `failed` the producer `shared/src/panel.ts:112` says Phase 1 owes it | **this** |
| 4 | `panel/verdict_index.py:219 rebuild` | the one place that sees every row declines to reconcile a foreign one; enforcement is deferred to a per-request read that 500s | "after `rebuild`, every `package_verdicts` row is landable" (delete, don't `continue`) | **this** |
| 5 | `panel/routes/panel.py:708` (repo posture rollup) | `cached` is fabricated from the predicate that `compute_rollup` asserts about it, so the assert is a tautology *and* the wire field means something different here than on a scan | "`cached` means 'resolved from a stored report' at every producer" | **this** |
| 6 | `panel/routes/public_repos.py:237` (SQL severity `CASE`) | the outcome ordering is hand-mirrored into SQL, a second copy of `OUTCOME_SEVERITY` with different numbers and an extra interleaved rank | "one severity ladder; the SQL sort derives from it" | **this** (N-12 class) |
| 7 | `graph.py:150 add_or_merge` | the merge predicate is re-asserted 5 lines below itself; the real open question (is `claim` discriminating enough? it is 13×6 values) is unasserted | "two nodes merge only if one run answers both" — needs a *discriminating* question key, not a re-check | **this** |
| 8 | `frontend/.../tone.tsx:22 outcomeTone` | `default:` silently absorbs any out-of-domain wire value into the "no information yet" tone; no zod parse at the store boundary, no `never` exhaustiveness check | "the panel wire is parsed at the boundary; the tone map is exhaustive over `Outcome \| null`" | **this** |
| 9 | `cli/src/stream.ts:23` / `install.ts:41` | `UNKNOWN` is the initial value, the missing-field fallback, **and** the rendered coverage-gap label — three facts under one name, with a live branch on it | the same §4.4 split the engine got | **this** |
| 10 | `sensors.py:139` (peer-address parse) | an optional regex group exists only to keep a test's imaginary line shape matching, defended by a comment whose `-yy` claim is false | "the parser accepts exactly what strace emits" — then the branch and the test both delete | **this** |
| 11 | `panel.py:668 scan_rollup` / `repo_scan.py:182 rollup_items` | the seam extracted to stop three readers classifying one row differently has **no direct test**; its own headline bug is unpinned | (test seam, not an invariant) — the boundary is right, the proof is missing | **this** |

**Covered, verified still holding:** `panel/jobs.py:371` (worker exits only
between jobs — the pooled-connection leak); `graph.py:100` (no unarmed `OPEN`
node — enforced with `raise`, so it survives `-O`); `evidence.py:156`
(no `require` event is the instrument's — enforced with `raise`, and its failure
really does DEFER: `orchestrator.py:284`'s `except Exception` arm transitions the
one hypothesis to `DEFERRED` with `Internal error (AssertionError): …` and logs
the traceback, so the audit ERRORs rather than concluding); `docker.py:145`
(fragment order is the mechanism).

**Hand `invariant-audit` rank 1 first.** It is the only boundary on this list
whose missing invariant is currently visible to a *customer's* CI as a check that
never finishes, it is reachable from an ordinary `package.json` edit, and closing
it is a three-line decision at one transition.

---

## 2. The invariant ledger as landed — `invariant-audit` Phase 4, applied retrospectively

Every assert the two commits added (`git diff a05a541 ced29f2 -- engine/npmguard/`
→ 1 `raise AssertionError`, 8 bare `assert`).

| # | invariant | site | enforcement | earns its keep? |
|---|---|---|---|---|
| I-1 | no `require` event is the instrument's own | `evidence.py:156` | `raise AssertionError` + 8-line comment | **yes.** Hostile-producer boundary, survives `-O`, failure DEFERs with a located cause. The best-placed assert in either commit. |
| I-2 | stored verdict ∈ {SAFE, DANGEROUS} (write) | `verdict_index.py:125` | bare `assert` | **yes**, correct home. But both existing callers already filter (`jobs.py:346`, `verdict_index.py:226`) — pre-existing filters, not added here — so it guards only *future* producers, and no DB `CHECK` backs it. |
| I-3 | stored verdict ∈ {SAFE, DANGEROUS} (read) | `verdict_index.py:65` | bare `assert` | **yes, and it can fire** (see F-4). Wrong home though: the read is a per-request path, so the failure is a 500 on a user's dashboard forever. The boot rebuild (rank 4) is the site that could reconcile. |
| I-4 | `cached ⇒ a landed verdict` | `repo_scan.py:156` | bare `assert` | **split.** Load-bearing on the two DB paths (`scan_items.cached`, `public_repo_scan_items.cached`); a **tautology** at `panel.py:710`, where `cached` is computed as `outcome in LANDABLE_VERDICTS` — the assert's own predicate. |
| I-5 | item outcome ∈ OUTCOMES ∪ {None} | `repo_scan.py:147` | bare `assert` | **no.** Every production caller reaches it through `rollup_items` → `item_outcome`, which already guarantees it (I-3 + a total mapping). N-4 rule 5 forbids exactly this re-check. Fires only for a hand-built `RollupItem`, which happens only in tests. |
| I-6 | counters partition the set | `repo_scan.py:176` | bare `assert` | **no.** Unconditional arithmetic: each item does `total += 1` then exactly one of four increments. It cannot fail on any input — it is a unit test spelled as an assert. |
| I-7 | a non-null outcome is a panel outcome | `checks.py:55` | bare `assert` | **no.** The next line `_CONCLUSION[outcome]` raises `KeyError` on the same input; the assert only improves the message, and its input is already `Rollup.outcome`. |
| I-8 | `outcome_severity`'s arg is an outcome | `verdict_index.py:75` | bare `assert` | **no.** Same shape as I-7 (`OUTCOME_SEVERITY[outcome]` would `KeyError`), and its sole caller asserted the domain 25 lines earlier. |
| I-9 | merged nodes asked the same question | `graph.py:166` | bare `assert` | **no — pure tautology.** `duplicate` was selected by a generator whose predicate *is* `_asked_question(node) == question` (`graph.py:155`). The assert cannot fail unless someone edits the five lines above it. |

**Score: 3 of 9 load-bearing (one only partially), 1 arithmetic self-check,
5 tautologies or re-checks of an upstream guarantee.**

The pattern is sharp and worth naming: **both asserts that can actually fire on
foreign or hostile data are written as `raise AssertionError`** (I-1, plus the
pre-existing `graph.py:100`), **and every assert written as a bare `assert` is
either a tautology or a re-check** — except I-2/I-3/I-4, which are the ones that
matter and are also the ones a bare `assert` is the weakest tool for.

Confirmed with a probe (`python -O`):

```
$ python -O -c "from npmguard.panel.verdict_index import item_outcome; \
                print('UNKNOWN ->', item_outcome('UNKNOWN', pending=False))"
UNKNOWN -> UNKNOWN
```

Under `-O` the entire enforcement layer of `d1c4cd7` evaporates and the retired
4-state domain flows again — `compute_rollup` then counts `UNKNOWN` in the
`error` bucket (`repo_scan.py:170`'s `else:` arm) before `outcome_severity`
raises an unlocated `KeyError`. No `-O`/`PYTHONOPTIMIZE` exists anywhere in the
repo (checked `deploy/`, `run.sh`, `scripts/`, `pyproject.toml`), so this is
**PLAUSIBLE, not confirmed, as a production risk** — but the systemd unit does
`EnvironmentFile=…/engine/.env`, which is gitignored and therefore unauditable
from here. The point is structural rather than operational: N-4 rule 3
("delete-iff-asserted") licenses deletion on the strength of an assert, and a
bare `assert` is a *conditionally compiled* license. A DB `CHECK (verdict IN
('SAFE','DANGEROUS'))` — absent from both `tables.py:191` and
`0005_create_panel_state.py:163` — would make I-2 unconditional.

---

## 3. Findings, ranked by consequence

Ranked by consequence, not by count — section order *is* the rank. F-1…F-3b can
produce a wrong answer or a wrong absence of one in production today; F-4…F-5 are
reachability and reasoning defects; F-6 onward are correctness debt with no wrong
output today. Two notes on reading the ranking: **F-2 is the one that can produce
a false `DANGEROUS`**, which is the most expensive error this product can make,
and **F-6a is the most instructive** — a production regex widened to accommodate
an input the same commit proved impossible — even though its consequence today is
nil.

### F-1 · A finished scan with nothing concluded leaves the GitHub check `in_progress` forever — **CONFIRMED**

`repo_scan.py:446-450` → `api.py:703-708` → `checks.py:51`.

An empty item set satisfies `rollup.pending == 0`, so the scan finalizes to
`done`, and `rollup.outcome` is `None`, so `finalize_check` maps it to
`in_progress` and returns without touching GitHub. The check run opened on the
head commit (`gh_webhooks.py:292`) is never concluded.

Reachable from an ordinary push. `_handle_push` requires only
`touches_dependencies(payload)` — "did this push add/modify/remove a ROOT
lockfile or `package.json`" (`gh_webhooks.py:73`) — and then
`delta_repo_scan` audits only pairs **new vs. the index**
(`repo_scan.py:391`). So every one of these produces a zero-item scan:

- an edit to `package.json` that touches no dependency (a `scripts` entry, a
  `description`, `engines`);
- **removing** a dependency;
- reverting to a lockfile whose every pair is already indexed;
- a `package-lock.json` reformat or `lockfileVersion` bump.

Probe (isolated sqlite, real `RepoScanEngine`, `finalize_check` captured):

```
PROBE2 scan row: {... 'trigger_kind': 'push', 'status': 'done', 'total': 0,
                  'check_run_id': 777, 'finished_at': '…'} items: 0
        finalize outcomes: [None]
PROBE1 check_conclusion(None) = in_progress
PROBE1 check_summary(None)   = "NpmGuard audit in progress."
```

Consequence: if NpmGuard is a **required** check, the PR is blocked
indefinitely, and the block is invisible — GitHub shows a spinner, not a
failure. This is the exact symptom `d1c4cd7`'s own message claims to have
retired ("a GitHub check stuck at `in_progress`"). It fixed the `UNKNOWN`
*cause* of that symptom and left the empty-set cause, which is far more common
than a crashed audit.

Per N-4 rule 1 this is the textbook incoherent state: the set axis says
*finished*, the outcome axis says *nothing concluded*, and the code's only
response is a branch that does nothing. `§4.4`'s state diagram has no arrow for
it — `running → {SAFE, DANGEROUS, ERROR}` is claimed exhaustive, and a
zero-item set takes none of them. The fix is a decision the owner has to make
(is "nothing to audit" a `success` or a `neutral`?), not a guard.

The haziness is visible in the comment at `api.py:700-702`: *"only a set with
NOTHING concluded (outcome `None`) leaves the check open"*, and `checks.py:49`'s
*"`None` (nothing concluded **yet**)"*. The word "yet" is doing all the work and
is not guaranteed by anything — `outcome is None` means "nothing concluded",
full stop, and whether a result is still coming is the *other* axis
(`rollup.pending`), which is `0` at the only site that calls this. The code
matches its comment exactly; the comment quietly assumes a fact the caller has
already falsified. `refresh_scan_progress` has `rollup.pending` in scope on the
line above, so the distinction is available at zero cost right where it is
needed.

### F-2 · The canary clause manufactures citations from ordinary strings — a path to a **false `DANGEROUS`** — **CONFIRMED**

`evidence.py:287-290` (bait set) and `evidence.py:474` (the match).

```python
bait = {k: v for k, v in (artifact.setupApplied.env or {}).items()
        if len(v) >= _MIN_BAIT_CHARS}          # _MIN_BAIT_CHARS = 8
...
carried = sorted(key for key, seed in bait.items() if seed in value("url") + body)
```

The bait set is *every* planted env value of 8+ characters, and the match is a
plaintext substring over the URL **concatenated with** the body. The recorded
corpus already plants values that are ordinary strings — extracted from the
committed experiments:

| planted (real, recorded) | occurrences | len |
|---|---|---|
| `HOME=/home/node` | 4 | 10 |
| `MYAPP_DATA=db://localhost/admin` | 2 | 20 |
| `MY_PREFIX=somevalue` | 2 | 9 |
| `MYAPP_DB_HOST=localhost` | 2 | 9 |

Probes, verbatim:

```
BENIGN crash report + recorded HOME bait:
  e1  net  POST https://sentry.example.com/api/store  body[57b]
      {"stack":"Error: ENOENT at /home/node/app/index.js:3:11"}  · carries planted env HOME

No body at all, planted 'localhost' matched from the URL:
  e1  net  GET http://localhost:9999/health  · carries planted env MYAPP_DB_HOST

Ordinary value cited as a planted canary:
  e1  net  POST https://api.example.com/t  body[28b] {"prefix":"somevalue","v":2}
      · carries planted env MY_PREFIX
```

The second is the sharpest: **a GET with no captured body at all** is rendered
as carrying a planted canary, purely because the planted value appears in the
request's own URL. The judge is evidence-bound (§18.3) and this clause is
written to be citable — "the payload carries planted env HOME" is exactly the
corroboration a judge needs to CONFIRM, and CONFIRM is `DANGEROUS`
(`graph.py:314-321`), with no second opinion required (§24.9: one confirmation
carries the whole verdict). A false `DANGEROUS` on a popular benign package is
the most expensive error this product can make, and `d1c4cd7` has just wired
`DANGEROUS` to a **blocking** GitHub check (`checks.py:35`).

Two design errors compound here:

1. `_MIN_BAIT_CHARS` is a **length** floor where the discriminator needs to be
   **entropy/uniqueness**. It correctly rejects `CI=1` and misses `/home/node`.
2. The bait is *inherited* from whatever the model chose to plant rather than
   *minted*. Nothing forces a planted value to be a nonce. The invariant belongs
   upstream at `experiments.py:81 _set_env` (rank 2 in §1): a canary the renderer
   is allowed to cite must be a value the engine generated and can prove is
   unguessable.

`render_timeline` also reads `HOME` out of the same dict for path shortening
(`evidence.py:282`), so `HOME` being present in `setupApplied.env` is *expected*,
not exotic.

### F-3 · A canary-negative is unqualified: silence means both "checked, absent" and "not checked" — **CONFIRMED**

Same site, opposite direction. `carried` is computed over the *captured prefix*
only. The instrument keeps `_BODY_CAP = 2048` bytes per request and
`_BODY_TOTAL_CAP = 65536` per run (`instrumentation-monkey.js:38-40`), and the
renderer emits nothing at all when `carried` is empty. Three shapes where the
canary **was** exfiltrated and the timeline is silent:

```
TRUNCATED (canary WAS sent, at offset 3000 of 4096; kept prefix = first 2048):
  e1  net  POST http://localhost:9999/exfil  body[4096b] aaaa…(200 chars)…a…
COMPLETE (canary genuinely absent):
  e1  net  POST http://localhost:9999/exfil  body[4b] ok=1

URL-ENCODED canary present in payload:
  e1  net  POST https://api.example.com/t  body[34b] tok=npm_1234%2F5678%2Bsecret%3D%3D
BASE64 canary present in payload:
  e1  net  POST https://api.example.com/t  body[28b] bnBtXzEyMzQ1c2VjcmV0dG9rZW4=
```

and a fourth, once the 64 KiB run budget is spent (`room <= 0`, so 0 bytes are
kept but `bodyBytes` still reports the truth):

```
Run body-budget exhausted (0 bytes kept, 5000 sent):
  'e1    net      POST http://evil.test/x  body[5000b]'
```

That last row states a 5000-byte body and then shows nothing — a judge can read
it as an empty payload. `evidence.py:196-201`'s comment argues the data
distinguishes these cases ("`len(body) < bodyBytes` means the instrument's cap
truncated it"), and it does — but **the judge sees only the render**, and the
render never says how much of the body the canary check covered. Nothing in the
row contains `2048`, `truncated`, `partial`, or `of 4096`.

This is the same class as §24.8 (`hyp-0004` refuted because "the POST request is
recorded but its payload is not specified"). The fix converts *payload not
specified* into *payload specified, canary silent*, which reads to a judge the
same way: grounds to refute. Encoded exfil — base64 or urlencode, the ordinary
shape — defeats the plaintext substring outright, at any size. And the fifth
shape is domestic: `_MIN_BAIT_CHARS = 8` drops the suite's own default bait
(`test_evidence.py:55` plants `NPM_TOKEN="CANARY"`, 6 chars) from the bait set
entirely, so a payload echoing it verbatim renders no clause.

The honest form is a **positive statement about the check**: "canary check: none
of {NPM_TOKEN} in the first 2048 of 4096 submitted bytes". N-3 requires exactly
that ("a component that cannot get its data says so"); silence is the forbidden
fabricated zero.

### F-3b · The commit's headline fix — the "real silent green" — shipped with **zero** regression coverage — **CONFIRMED**

`d1c4cd7`'s message leads with this:

> It found a real silent green. `panel.py` rolled up the repo-wide dep index and
> reported it as *the scan's* verdict, so a delta scan whose only item was
> DANGEROUS or ERROR returned SAFE. The scan outcome now comes from the scan's
> own items.

The fix is correct (`panel.py:667-669`, `_scan_summary(last_scan,
last_scan_outcome)`). Nothing pins it. An independent revert pass restored the
pre-fix expression — the repo-wide dep-index rollup reported as the scan's
outcome — and ran the **whole** suite: `505 passed, 3 skipped, 70 deselected,
1 xfailed`, then `-m e2e`: `66 passed, 4 skipped`. Not one test goes red. The
same pass demonstrated the bug numerically on a DB seeded the way the route
reads it (dep index = one SAFE dep; delta scan whose only item is a DANGEROUS
pair *outside* the index):

```
PRE-FIX  scan.outcome (repo dep-index rollup) = SAFE
FIXED    scan.outcome (scan's own items)      = DANGEROUS   (dangerous: 1)
```

I confirmed the coverage gap independently at the reference level. At `ced29f2`,
searching all of `engine/tests`:

- `scan_rollup` — **no call site in any test.** The two textual hits are a test
  *name* (`test_panel_scans.py:127 test_s_scan_1_cache_hit_scan_rollup_and_sse`)
  and `test_panel_public_repos.py`, which exercises `compute_public_scan_rollup`
  — the **public** analogue, a different function.
- `rollup_items`, `scan_item_states`, `last_scan_outcome` — **zero references
  anywhere in tests.** These are the seam `d1c4cd7` extracted specifically so
  that "the scan counters, the wire projection and the check-run cannot classify
  the same row differently" (`repo_scan.py:184-187`). The seam that exists to
  prevent the bug has no direct test.

Why the existing tests cannot catch it: `test_panel_rollup.py` C19 covers the
adjacent `refresh_scan_progress` → check-run path, not the route. The e2e
`test_panel_scans.py:199` asserts `detail["scan"]["outcome"] == "DANGEROUS"`, but
its scan covers **all** the repo's deps, so the index rollup and the scan rollup
agree by construction and the two expressions are indistinguishable. The missing
case is the one the commit message names: **a delta scan whose item set differs
from the dep index.**

Note the asymmetry: the public path's rollup *is* pinned
(`test_panel_public_repos.py:299`, C18). The repo path's is not.

This is an N-7 violation at the sharpest possible location — the fix the commit
leads with, on the invariant `engine/CLAUDE.md` states as law ("audit failure is
an ERROR, never a SAFE verdict or hidden coverage gap"). N-7 says a regression
test that cannot fail against the pre-fix code is theater; here there is no test
at all, so nothing stops the exact silent green from being reintroduced by the
next refactor of that route.

### F-4 · The deleted branch *is* reachable — and the argument for deleting it is false as written — **CONFIRMED (producer) / PLAUSIBLE (reaching this schema)**

`d1c4cd7`'s message and `shared/src/panel.ts:75` both assert **"SUSPECT had zero
producers anywhere."** That is factually wrong. An independent falsification
pass found a live producer at the tip of `origin/main` (`05cb1d4`, one day before
this commit):

- `engine/src/proof-quality.ts:613` — `classification: "SUSPECT"` is a live
  return value;
- `engine/src/verdict-index.ts:107-118` — `installReportHook` calls
  `upsertVerdict(packageName, version, assessment.classification, …)`;
- `engine/src/verdict-index.ts:10-15` — a 4-state `SEVERITY` map with `UNKNOWN`
  as the default rank for an unrecognized string;
- `9447ef4:engine/migrations/001_init.sql:117-123` creates
  `package_verdicts(name, version, verdict TEXT NOT NULL, …, PRIMARY KEY(name,
  version))` — **the same table, column, and primary key** as
  `0005_create_panel_state.py:160-166`, with no `CHECK` in either.

`34872f4` (the TS panel) is not an ancestor of `ced29f2`; the two lineages
diverged, and `main` went the *other* way (`df491d4` widened the enum to four
states). So what actually protects the asserts is not the absence of a producer.
It is three narrower facts the commit never states:

1. **Different DB filenames.** TS: `data/npmguard.db` (`NPMGUARD_DB_PATH`);
   Python: `data/npmguard.sqlite3` (`NPMGUARD_DATABASE_URL`). Repointing would
   also have to defeat `alembic upgrade head`, which would fail on an existing
   `package_verdicts`. **Theoretical and self-blocking.**
2. **A `LANDABLE_VERDICTS` write filter that predates the commit.**
   `d1c4cd7^:verdict_index.py:182` and `d1c4cd7^:jobs.py:346` already had it.
   `d1c4cd7` added asserts and deletions on top of a gate that was already doing
   the work.
3. **`data/reports/` is genuinely shared.** `origin/main:engine/src/report-store.ts:6`
   and `report_store.py:9` resolve to the byte-identical path. A TS-authored
   report carrying `"verdict": "SUSPECT"` is directly readable by
   `_saved_reports()` → `rebuild()`. Filter (2) keeps it out of the column.

**But filter (2) does not cover every reader of that directory.** `api.py:592`
`/packages` returns `list_reports()`, and `report_store.py:112-120` filters only
on truthiness before putting `report["verdict"]` on the wire:

```python
if not report.get("verdict"):
    continue
summaries.append({..., "verdict": report["verdict"], ...})
```

`contract/models.py:1104` declares `AuditReport.verdict: Literal['SAFE',
'DANGEROUS']`. So a `SUSPECT` report file on the shared reports path crosses a
public wire in violation of the generated contract, unvalidated. The code path is
**CONFIRMED**; whether such a file exists on any given deployment is
**PLAUSIBLE** and depends on which lineage last wrote there (the audited
checkout's own `data/reports/` holds only `SAFE`×3 and `DANGEROUS`×1).

Second half of the same finding: **`rebuild` only skips.** `verdict_index.py:226`
does `continue`; there is no `DELETE` anywhere in the module. A pre-existing
out-of-domain row is therefore never removed *and* never overwritten (the pair is
skipped, so `upsert` never runs for it), survives every boot forever, and trips
I-3 on the first dashboard read — an `AssertionError` → 500 at `panel.py:686`,
`panel.py:800`, `public_repos.py:290` and `repo_scan.py:190`. The boot rebuild is
the natural home for that invariant and the one place that sees every row; it
declines the job, and the read path pays for it on a user request.

**Verdict on the deletion: it stands; the justification does not.** The honest
comment is "no producer *in this lineage*; the cross-lineage producer on `main`
is separated by the DB filename and filtered on the reports path" — which is a
materially weaker claim than "zero producers anywhere", and it names two
follow-ups (the `CHECK` constraint; reconciling `rebuild`) that the stronger
claim hides.

### F-5 · `scans.status='failed'` has no producer — Phase 1's own contract commitment is unmet, and a wedged scan is permanent — **CONFIRMED**

`shared/src/panel.ts:112-115`, in the contract this commit is the migration to:

> `failed` gains a producer in **Phase 1** — today no writer sets it, so a scan
> whose engine died stays `running` forever and every UI branch for the failed
> state is dead.

`d1c4cd7` **is** Phase 1 (its subject says so) and did not add the producer.
Confirmed: `repo_scan.py:452` is the only writer of `scans.status`, and it writes
only `'done'`; nothing writes `scans.error` or `public_repo_scans.error`; there
is no stale-scan reaper anywhere (`panel_jobs` gets `reset_stale()` at boot,
`scans` gets nothing).

Consequences, all live:

- `ScanStatus.tsx:44` and `tone.tsx:53` branch on `status === "failed"` — dead
  branches, the precise cost `d1c4cd7` invoked to justify deleting `SUSPECT`
  ("a reserved-but-unreachable state that nevertheless forced a branch"). The
  commit removed unreachable values on the outcome axis and left one standing on
  the progress axis it introduced.
- A scan wedged in `running` is **permanent**, and `panel.py:490-494` then 409s
  every manual scan for that repo (`"A scan is already running"`). The repo
  becomes un-scannable through the UI with no operator recourse.
- `_scan_summary` (`panel.py:449`) suppresses the outcome unless
  `status == "done"`, so a wedged scan renders as the running progress meter —
  **a spinner waiting for a result that is never coming**, the exact phrase
  `d1c4cd7`'s message uses for what it eliminated. The claim is true at *item*
  level (`item_outcome` reports ERROR) and false at *set* level.

Reachable by the commit message's own path #1: if `enqueue_many` aborts on a
concurrent `IntegrityError`, the whole batch rolls back after `scan_items` were
already committed in a previous transaction, and the exception propagates out of
`create_scan` **before** `refresh_scan_progress` is reached. The scan then has
items, no jobs, and nothing that will ever nudge it — `refresh_scans_touching`
only fires when a worker settles a job covering one of its items, and there are
none. **PLAUSIBLE** (I did not force an `IntegrityError`); the reachability of
the *wedge* given no jobs is CONFIRMED by reading.

### F-6 · The test-quality cluster: the diagnosed theater test survives, defended by a widened regex — **CONFIRMED**

`§24.0` closes with the lesson of this whole exercise:

> the C2 test in `test_sensors.py` **asserted a line shape strace never emits**
> (`sin_addr="1.2.3.4"`). A whitebox test written against an imagined format is
> how a dead regex stays green for its whole life. The replacement class uses
> lines copied verbatim from a committed artifact's `raw`.

**(a) The replacement was added; the original was not removed.** At `ced29f2`,
`test_sensors.py:70-74` still reads:

```python
def test_strace_log_normalizes_security_relevant_fields() -> None:
    '1700000002.000000 connect(7, {sin_port=htons(443), sin_addr="1.2.3.4"}, 16) = 0\n'
```

and the new regex was **widened so that it keeps passing** (`sensors.py:139`):

```python
address = re.search(r'sin6?_addr=(?:\w+\()?"([^"]+)"', args) or ...
```

The `(?:\w+\()?` group exists to match the bare form. The comment defending it
(`sensors.py:138`) says *"the bare form is kept for hand-written/`-yy` lines"*,
and an independent check against real `strace 7.0` on this host found **zero**
occurrences of a bare `sin_addr="` in plain or `-yy` output — `-yy` annotates the
*file descriptor* (`3<TCP:[1898152]>`), not the sockaddr. So the `-yy` half of the
justification is false, and the "hand-written" half is circular: the only
hand-written lines in existence are in the very test being accommodated.

This is the audit's most instructive finding. The commit correctly diagnosed a
test asserting an imaginary format, wrote that diagnosis into the explainer as
the closing lesson of the section, and then **added an optional group to the
production regex so the imaginary format would continue to match** — an `if`
written to accommodate a state the author had just proven impossible, which the
project's own discipline calls a defect that should be a deletion. The wrong
belief now has a code branch and a comment defending it, which is strictly worse
than before: the next reader has documentation telling them the shape is real.

**(b) `test_stored_verdict_domain_is_two_state` is tautological.**
`test_panel_verdict_index.py:211-222`:

```python
"""C15/C16 (DB-level): after the only writer runs, the column holds nothing
but SAFE|DANGEROUS — asserted against the database, not the response."""
await index_engine.upsert("a", "1.0.0", "SAFE")
await index_engine.upsert("b", "1.0.0", "DANGEROUS")
...
assert stored == {"SAFE", "DANGEROUS"}
```

It writes SAFE and DANGEROUS, then asserts the column contains SAFE and
DANGEROUS — true for any writer that stores what it is given, with no adversarial
write anywhere. Verified empirically: it **passes with the `upsert` assert, the
`item_outcome` assert and the `outcome_severity` assert all deleted**. Its
docstring claims the N-9 style ("against the database, not the response"), which
is the right instinct applied to a claim it does not test.
`test_upsert_rejects_non_landable_verdict` already does the real work.

**(c) The body-capture test asserts a `(body, bodyBytes)` pair its producer cannot
emit.** `test_evidence.py:206-234`:

```python
tail = "z" * 400
{"body": '{"pad":"' + tail + '","tok":"npm_12345secrettoken"}',
 "bodyBytes": 4096}
```

The instrument keeps `min(2048, total)` bytes
(`instrumentation-monkey.js:84`), so a request whose true size is 4096 always
yields a `body` of **exactly 2048** bytes, never ~440. The test proves a real
property (matching survives the 200-char *display* cut) and does fail against
pre-fix code — but because the shape is imagined it never reaches the case the
producer actually generates, a canary past the 2048-byte *capture* cap, which is
F-3 and silently returns the wrong answer. Same signature as (a): the test and
the code share one belief about the producer's output.

**(d) One new sensor literal is not from the corpus.** The C2b docstring claims
lines "copied verbatim from a committed artifact's `raw`". Three of the four are
byte-exact matches against the 31 committed runartifacts; the `AF_INET6`
`inet_pton` line is **not in the corpus** and was hand-written. It was
independently validated against real `strace 7.0` output and the load-bearing
token is correct (it omits only a cosmetic `sin6_flowinfo=htonl(0),`), so the v6
axis is real — but the provenance claim is overstated for that line. Worth noting
that artifact `raw` is itself a reconstruction (`f"{syscall}({args}) = {result}"`
with the errno tail dropped), so "verbatim from a committed artifact" is one step
removed from "verbatim from strace" for all four.

**What is good here, and it is most of it.** An independent revert pass over
every new test found the large majority genuinely discriminating: the `sensors.py`
peer-address fix, the `parse_l4_trace` raise, the parentless-require naming, the
`add_or_merge` merge rule and severity max (3 tests), `item_outcome`'s ERROR
derivation and both domain asserts, the `checks.py` ERROR→neutral mapping
(4 tests), and 5 of the 10 real-node L4 tests all fail when their hunk is
reverted. `test_panel_rollup.py`'s C1–C19 class map partitions the input space
explicitly. `test_connect_never_claims_a_file_as_its_peer` (C14b) is
`xfail(strict=True)` and xfails at baseline — an open finding correctly pinned,
not a passing test. Three tests pass against pre-fix code because the old URL
builder is *accidentally* correct on those inputs (no port supplied, no body),
which is honest coverage of a boundary rather than theater. One,
`test_a_bodyless_network_event_renders_no_body_clause`, is a mutation-guard
rather than a regression test (it fails if `if body_bytes:` is made
unconditional) — a legitimate guard against the obvious wrong fix.

**(e) The real-node tier works but is not gated.** `test_instrumentation_l4.py`
genuinely runs the real instrument under real node (10 collected, 10 passed,
`node` on PATH here; proven live by the reverts above) and covers `_BODY_CAP` at
C3. It is the right structural answer to this whole class. Two gaps around it,
both CONFIRMED:

- `engine/scripts/gate.sh` provisions a throwaway Postgres specifically so the
  DSN-gated classes "actually run … without docker they skip **LOUDLY**", and
  does **nothing** for node. The class is `pytest.mark.skipif(shutil.which("node")
  is None)`, unmarked, in the default tier. On a runner without node, the only
  coverage for all three JS defects silently disappears.
- `engine/TESTING.md`'s tier table does not mention the new tier at all, though
  `engine/CLAUDE.md` points there for "tiers, class maps".

### F-7 · `cached` means two different things on one wire field, and the assert about it is a tautology at that site — **CONFIRMED**

`panel.py:708-713`:

```python
rollup = compute_rollup([
    RollupItem(outcome=outcome, cached=outcome in LANDABLE_VERDICTS)
    for outcome in outcomes
]).as_wire()
```

`compute_rollup`'s I-4 assert is `not item.cached or item.outcome in
LANDABLE_VERDICTS` — literally the expression that just produced `cached`. Probe:
all four outcomes (`SAFE`/`DANGEROUS`/`ERROR`/`None`) pass without raising, by
construction.

The semantic half is the real cost. `AuditSetRollup.cached` means "resolved from
an existing report" on a scan (`repo_scan.py:333`, a real column) and "every dep
that concluded" on a repo (here, so `cached == safe + dangerous` always). One
generated contract field, two meanings, chosen by which route answered — and the
frontend cannot tell them apart. The docstring acknowledges the divergence
("`cached` is every dep concluded from a stored verdict, which here is all of
them") which makes it haziness-by-consent rather than an oversight, but N-12
exists to make exactly this impossible rather than commented.

Minor, same site: `compute_rollup`'s docstring says `cached` is "a subset of the
concluded **three**" while I-4 enforces a subset of **two** (ERROR excluded).

### F-8 · `add_or_merge`'s coverage invariant holds, but its question key is coarser than the doc implies — **PLAUSIBLE**

The merge rule now requires `similar_description(≥0.88 Jaro-Winkler)` **and**
byte-identical `experiment` **and** identical `claim`. Two checks confirm the
strong part:

- `compile_experiment(experiment: list[ToolCall])` (`experiments.py:311`) is a
  **pure function of the tool-call list**, so "declared-identical ⇒
  compiled-identical" is sound and the docstring's "the compiled experiment" is
  accurate.
- `graph.add` (`graph.py:100-105`) raises on an `OPEN` node with an empty
  `experiment`, so the key is never compared over unarmed nodes — the merge
  cannot degenerate into "similar prose + same claim" during the hypothesize
  fan-out. This was the most likely way to reopen the coverage lie and it is
  closed.

So: **the coverage lie is closed for the case the commit describes.** One run
plus one claim genuinely resolves both nodes, and unioning focus regions is
honest under the design's own definition (the judge is evidence-bound and never
reads the focus source, so a region is a pointer to a *suspicion*, not a claim
about what executed).

Two residual observations, neither a coverage lie:

1. **`claim` is a very coarse key.** `Claim` is `{kind: one of 13, gating: one of
   5 | null}` (`contract/models.py`) — 78 possible values, no free text, no
   region reference. The discriminating work is therefore done almost entirely by
   the byte-identical `experiment`, and the `claim` term adds little. The
   docstring's "the SAME question" oversells what the key measures.
2. **The survivor's description is kept and the absorbed node's is discarded**,
   while its focus regions are absorbed. A report can therefore carry a
   hypothesis whose prose names one file and whose `focusFiles` lists another
   that the prose never mentions, with the survivor's judge reason attached to
   both. A reporting incoherence, not a coverage claim.

Also correct and worth recording: the change makes audits *more* likely to
exhaust the orchestrator budget, and the over-budget path DEFERs with a reason
(`orchestrator.py:166-177`) which `pipeline.py:390-398` converts to
`AuditIncompleteError` when nothing confirmed. Stricter merging therefore trades
silent coverage lies for visible ERRORs — the correct direction under N-3, and
the direction `d1c4cd7` just made visible on the panel.

### F-9 · The domain collapse stopped at the engine and frontend; `cli/` still runs the retired vocabulary — **CONFIRMED**

`cli/src/stream.ts:23,52`, `cli/src/commands/install.ts:41,189`,
`cli/src/render.ts:25,48`, `cli/src/api.ts:21`.

```ts
let verdict = "UNKNOWN";                                     // stream.ts:23
verdict = (data.verdict ?? "UNKNOWN").toString().toUpperCase();  // stream.ts:52
return (reportField<string>(report, "verdict") ?? "UNKNOWN").toUpperCase();  // install.ts:41
if (verdict === "UNKNOWN") { … }                             // install.ts:189
```

In the CLI, `UNKNOWN` is the initial value (*not started*), the missing-field
fallback (*no verdict frame arrived*), **and** the rendered label for a coverage
gap — three facts under one name, with a live branch on it. That is verbatim the
defect §4.4 uses to justify the whole change, still standing in the one surface a
paying user actually runs. `SUSPECT` is now genuinely dead there (the engine's
`Literal['SAFE','DANGEROUS']` cannot produce it) yet `render.ts:25` still
documents "the 4-state verdict" and `install.ts:321` still routes it.

Mitigating, and worth stating plainly: the CLI's handling is *honest* —
`exitCode = verdict === "SAFE" ? 0 : 1` and the copy reads "Coverage gap …
This is NOT a clean bill of health." No silent green. And `d1c4cd7`'s message
scopes itself to "the engine and frontend now comply". This is a scope gap
truthfully declared, not a misstatement — but §4.4's cost estimate omitted the
CLI, so the phase will read as done while the incoherent name survives.

### F-10 · The frontend absorbs an out-of-domain outcome silently, where the engine fails loud — **CONFIRMED**

`frontend/src/components/panel/tone.tsx:22-32`. `outcomeTone` is a `switch` with
`default: return "unknown"`, and `unknown` is documented as "the absence of
information (nothing concluded, no scan yet) — **never a conclusion**". The
`default` arm is needed for `null`, but it also absorbs any foreign string. There
is no zod parse in `panelStore.ts` (checked: no `parse`, no `Schema`, not even a
`json()` call site validating) and no `never` exhaustiveness guard anywhere in
the panel components.

So the same wire value that trips a located `AssertionError` in Python renders in
the browser as "nothing concluded yet" — a pending spinner standing in for
corrupt data. The invariant is enforced on one side of a boundary the commit
describes as two-sided. `tone.tsx`'s own header comment claims the fix ("The
param is no longer widened to `string` … a widened param silently accepted values
the map had no arm for") — narrowing the *type* does not narrow the *value* at a
JSON boundary.

### F-11 · A second severity ladder, hand-mirrored into SQL — **CONFIRMED, no wrong output today**

`public_repos.py:237-242`:

```python
severity = sa.case(
    (package_verdicts.c.verdict == "DANGEROUS", 3),
    (package_verdicts.c.verdict == "SAFE", 0),
    (active_exists, 1),
    else_=2,
)
```

`OUTCOME_SEVERITY` is `{SAFE: 0, ERROR: 1, DANGEROUS: 2}`. This is a second copy
with different numbers and an extra interleaved rank for "pending", bypassing
both `item_outcome` and `outcome_severity`. The relative order of the three
outcomes agrees, so there is no wrong output today. Two costs: it is the
hand-mirrored duplicate N-12 exists to abolish, and its `else_=2` **silently**
ranks a foreign verdict as ERROR — the same value that will trip the assert 50
lines later at `public_repos.py:290`. The comment above it claims the arms are
exhaustive "so the two extra arms this CASE used to carry (SUSPECT, UNKNOWN)
could not match any row", which is the F-4 argument restated and inherits its
weakness.

### F-12 · `lastScan` is still hardcoded `None` in the function this commit rewrote — **CONFIRMED**

`panel.py:726`: `"lastScan": None,` against `engine-types.ts:378`'s
`lastScan: ScanSummary | null`. The v3 design doc names this exact field as one
of its five live examples of **haziness** ("a field whose declared type promises
what the code can never supply", §3 N-4). `d1c4cd7` rewrote
`panel_repo_detail` — adding `last_scan_outcome`, the dep outcome derivation, and
the posture rollup — and left the cited example in place, while the real summary
ships beside it under a different key (`scan`).

### Nothing found at these severities

- **No weakening of the payment or admission trust boundary.** Neither commit
  touches `payments.py`, `caps.py`, `service.py`, or `persistence.py` (checked by
  name against both commits' file lists). In `repo_scan.py` the diff does not
  touch a single line matching `caps|budget|admit|enqueue|consume`, so
  `create_scan`'s ordering is unchanged: `assert_audit_budget` before any row is
  written, `consume_audit_budget(inserted)` charging only jobs actually inserted.
  `jobs.py` gained exactly one `else:` logging branch, after `admit`. The
  cache-hit short-circuit still precedes `admit`, so no work launches early, and
  `AuditService.admit` remains the single capacity owner (N-2). `d1c4cd7`'s only
  `api.py` change is renaming `verdict` → `outcome` in `finalize_check`.
- **No silent-green path introduced by either commit.** Every new coverage gap I
  found lands on ERROR or DEFERRED, never SAFE: a job that completes without a
  landable verdict writes no row and reads as ERROR (`jobs.py:355-366`); a
  misattributed require DEFERs (`orchestrator.py:284`); over-budget hypotheses
  DEFER and then raise `AuditIncompleteError`. F-1 and F-5 are wrong-output
  findings about *progress reporting*, not about a green verdict, and F-2 errs
  toward false-DANGEROUS.
- **`compute_rollup`'s counter math is correct.** The partition holds
  unconditionally, `outcome` is the max over concluded items only, pending never
  contributes, and the four `scans` columns are derived from it so they cannot
  disagree with the wire — including `audited = safe + dangerous - cached`, which
  is non-negative precisely because I-4 holds on the DB paths.

---

## 4. Direct answers to the six questions

**1 · Are the asserts in the right places?** Mostly no. §2: 3 of 9 are
load-bearing, 5 are tautologies or re-checks of a guarantee established upstream
in the same call chain (N-4 rule 5 forbids the latter explicitly), 1 is
unconditional arithmetic. `graph.py:166` re-checks its own selection predicate
five lines above it. `repo_scan.py:156` is load-bearing on the two DB paths and a
tautology at `panel.py:710`, where the value it asserts about is *computed from
the assert's predicate*. The one assert at a genuine hostile-producer boundary
(`evidence.py:156`) is also the one written as `raise` rather than `assert`, and
it is the best work in either commit. Placement is also wrong in one case that
matters: I-3 guards the per-request read while the boot rebuild is the site that
sees every row and could reconcile it (F-4).

**2 · Is any deleted branch actually reachable?** The branch is dead in this
lineage, but the commit's stated reason for believing so is false. A live
`SUSPECT` producer exists at the tip of `origin/main`, writing into an
identically-named table and column with no `CHECK` on either side, and the two
lineages share `data/reports/` byte-for-byte. What protects the asserts is the DB
*filename* plus a `LANDABLE_VERDICTS` filter that predates the commit — and that
filter does not cover `/packages` (`api.py:592` → `report_store.py:112-120`),
which will put a `SUSPECT` verdict on a public wire in violation of
`contract/models.py:1104`. See F-4.

**3 · Where is an incoherent state still representable?** Four, ranked: a
**finished set with no outcome** (F-1, the check-run consequence is customer
visible); a **`running` scan with no possible resolution** (F-5, plus a permanent
409 on re-scan); a **`cached` item whose flag was fabricated from its outcome**
(F-7, plus one wire field with two meanings); and a **`failed` job alongside a
landed verdict**, which is representable *by design* and correctly documented at
`panel.py:425-434` — I looked for a lie there and found an honest comment.

**4 · Did the merge-rule change close the coverage lie completely?** Yes for the
case it describes, and I could not construct a remaining path: `compile_experiment`
is a pure function of the tool-call list, and `graph.add`'s unarmed-OPEN guard
prevents the key from ever being compared over nodes without experiments — which
was the plausible way back in. The residue is that `claim` is a 78-value enum
carrying no region reference, so the docstring's "the SAME question" is broader
than what is actually compared, and the absorbed node's description is discarded
while its regions are kept (F-8). Both are reporting-fidelity issues, not
coverage claims.

**5 · Are the new tests testing behaviour or restating the implementation?**
Mostly behaviour — a revert pass over every new test found the large majority fail
when their hunk is reverted (F-6, closing paragraph). Four exceptions, and the
first is the serious one:

- **The theater test that caused the whole incident is still green, and the fix
  widened the production regex to keep it that way** (F-6a). `sensors.py:139`'s
  `(?:\w+\()?` group exists solely to match `sin_addr="1.2.3.4"`, a shape verified
  absent from real `strace 7.0` in both plain and `-yy` output — and the comment
  defending it cites `-yy`, which annotates the fd, not the sockaddr. The commit
  diagnosed the pattern, wrote it up as the section's closing lesson, and then
  accommodated it in code.
- **`test_stored_verdict_domain_is_two_state` is a tautology** (F-6b): it writes
  SAFE and DANGEROUS and asserts the column holds SAFE and DANGEROUS, and passes
  with all four of the commit's guards deleted, while its docstring claims a
  DB-level domain proof.
- **`test_evidence.py:206` asserts a `(body, bodyBytes)` pair the instrument
  cannot emit** (F-6c) — a 440-byte body with a 4096-byte true size where the cap
  guarantees exactly 2048 — so it never reaches the case that silently returns the
  wrong answer (F-3).
- **`test_rollup_rejects_foreign_outcome` is only partially discriminating**: with
  `compute_rollup`'s own domain assert removed it still passes, because `SUSPECT`
  falls through to the `else` arm and `outcome_severity`'s assert then raises with
  a message that also matches `"outcome"`. It proves *some* guard exists, not the
  one it documents (which is I-5, the redundant one).

Separately, the sharpest gap is not a weak test but a **missing** one: the fix
`d1c4cd7` leads with — the real silent green at `panel.py:667` — has no
regression coverage at all, and reverting it leaves all 505 unit and 66 e2e tests
green (F-3b). `scan_rollup`, `rollup_items`, `scan_item_states` and
`last_scan_outcome` have zero test references between them.

The tests that *are* hand-built over unreachable inputs are honestly labelled as
guards rather than regressions in most cases: `RollupItem` domain/cached asserts
cannot be produced by `rollup_items`, and `'SUSPECT'` has no producer in this
lineage (though see F-4 for why that phrasing is too strong). One,
`test_connect_renders_the_peer_it_dialled`, hand-builds `addr: "127.0.0.1"` for a
renderer branch the commit did not change, and before the sensors fix the real
producer emitted `addr: null` for **all 22 distinct connect `raw`s in the
corpus** — but C2b asserts byte-identically the same dict that
`parse_strace_log` now produces, so the two tests do close the chain across the
seam. That is the right construction and it is worth copying.

The remaining weakness is the gate, not the tests: `gate.sh` provisions a
throwaway Postgres specifically so its DSN-gated classes cannot silently skip, and
does nothing equivalent for node — leaving the only coverage of all three JS
defects behind a silent `skipif` (F-6e).

**6 · Does anything weaken the payment or admission trust boundary?** No. See
"Nothing found at these severities" for what I checked.

---

## 5. Do the two commits honour N-4, or only claim to?

**They honour the hard half and skip the cheap half — the opposite of the usual
failure.**

The hard half is *earning the deletion* (rule 4). The falsification pass was
real, it produced three counterexamples that changed the code, and one of them —
"not concluded ⟹ a live job XOR a terminal failed job" — was **refuted and
recorded as a comment rather than asserted**, with the three reachable paths
named. That is the discipline working exactly as designed: an invariant that
fails falsification becomes documentation, not an assert, and not a deletion.
Very little code gets this right. `ced29f2` matches it: the one fix that would
have been correct is *not landed*, with the reason (a metered re-record), the
blast radius (9 of 14 artifacts, 2 pinned citations), and an `xfail(strict=True)`
so it flips green when the cost is paid. Both commit messages also correct their
own prior analysis, which is rule 4's spirit applied to prose.

The cheap half is *assert where it earns its keep* (rule 5) and
*delete-iff-asserted* (rule 3), and both are weaker than they look. Five of nine
asserts re-check what an upstream invariant in the same call chain already
guarantees, or re-check the selection predicate immediately above them — rule 5
names this as reintroducing the work the invariant exists to remove. And every
deletion licensed by `d1c4cd7` rests on a bare `assert`, which `python -O`
removes; the enforcement is conditionally compiled, and no DB `CHECK` backs the
one column that a second live producer can reach.

N-7 is the weakest of the three. The commits' *own* framing is that a test which
cannot fail against pre-fix code is theater, and by that standard the body of new
tests is good — most of them do fail on revert. But the fix `d1c4cd7` leads with
has no test at all (F-3b), one new test is a pure tautology while claiming a
DB-level proof (F-6b), and the test whose failure mode this whole exercise is
named after was left alive and given a production regex branch to keep it green
(F-6a). That last one is not a lapse in rigour; it is rigour applied to the
diagnosis and then not carried into the fix, which is the harder half to notice.

The gap that actually matters is not in the rules the commits followed but in the
scope they drew. §4.4's decision table has three outcomes and no row for "the set
was empty"; the commits implemented the table faithfully and inherited its hole,
so a finished-with-nothing-concluded set has no defined behaviour and the code's
answer is to leave a GitHub check open forever (F-1). Similarly, `d1c4cd7` is
Phase 1, `shared/src/panel.ts:112` assigns Phase 1 the job of giving
`status='failed'` a producer and states the consequence of not doing it, and the
commit shipped the rest of Phase 1 without it (F-5). Both are cases where the
*outcome* axis was made rigorous and the *progress* axis it was split from was
left carrying the incoherence — including one reserved-but-unreachable value
forcing two dead frontend branches, which is verbatim the cost the commit cites
to justify deleting `SUSPECT`.

So: N-4 is honoured in method and under-applied in reach. The invariants that
were established are real; the claim that closes `d1c4cd7`'s reasoning ("zero
producers anywhere") is the one place where confidence outran the falsification
that was actually performed, and it is exactly the sentence a future reader will
trust instead of re-deriving.

---

## 6. Scope of what was checked

Read in full at `ced29f2`: `panel/verdict_index.py`, `panel/jobs.py`,
`panel/tables.py`, `panel/scan/repo_scan.py`, `panel/scan/public_repo_scan.py`,
`panel/github/checks.py`, `panel/routes/panel.py`,
`panel/routes/public_repos.py`, `panel/routes/gh_webhooks.py`, `graph.py`,
`evidence.py` (diff + all touched functions), `sensors.py` (diff),
`observation.py` (diff), `docker.py` (diff), `experiments.py`
(`compile_experiment`, `compose`, builders, `TOOL_CATALOG`), `orchestrator.py`
(budget + error arms), `pipeline.py` (graph → verdict), `report_store.py`
(`list_reports`), `api.py` (lifespan wiring, `/packages`),
`assets/instrumentation-monkey.js`, `assets/instrumentation-require-hook.js`,
`tests/test_panel_rollup.py`, `tests/test_evidence.py` (new classes),
`tests/test_panel_verdict_index.py`, `tests/test_sensors.py`,
`tests/test_panel_public_repos.py`, `tests/e2e/test_panel_scans.py`,
`tests/test_graph.py`, `tests/test_panel_checks.py`,
`tests/test_instrumentation_l4.py`, `scripts/gate.sh`,
`frontend/.../{tone.tsx,ScanStatus.tsx}`, `frontend/src/lib/engine-types.ts`,
`shared/src/panel.ts`, `cli/src/{stream.ts,render.ts,api.ts,commands/install.ts}`.

Standards applied: N-0 (quality over shortcuts), N-2 (one capacity owner), N-3
(honest degradation), N-4/N-4b (invariants, all seven rules), N-7 (discriminating
tests), N-11 (storage portability), N-12 (one contract), N-14 (total gating);
§4.4 (two-axis verdict model); D-9 (evidence fidelity before measurement);
`engine/CLAUDE.md` ("audit failure is an ERROR, never a SAFE verdict or hidden
coverage gap"; the payment-gate rules); `engine/TESTING.md` (tiers, class maps,
fixture pinning). No LLM call was made; no fixture was re-recorded; no
`test-pkg-bench-dd-*` fixture was installed or executed.
