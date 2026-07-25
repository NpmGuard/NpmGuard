# The NpmGuard audit core, explained from first principles

**What this document is.** The audit core is the machinery that takes a
`(package name, version)` pair and produces one of exactly two verdicts —
`SAFE` or `DANGEROUS` — or refuses to produce a verdict at all and raises an
error instead. Everything else in the product (the CLI, the web frontend, the
GitHub repo panel, the payment gate) is a consumer of that machinery. This
document explains the whole path, mechanism by mechanism, with `file:line`
citations for every claim.

**Who this is for.** Someone with no prior knowledge of npm, sandboxing, or
this codebase, but who can follow precise logic. Vocabulary is introduced
bottom-up: plain English first, then the exact term, then that term is used
freely.

**Accuracy rule used throughout.** Where the code and a design document
disagree, the code wins and the divergence is called out explicitly
(§20). Where something looks like a bug or an incoherent state, it is listed in
**Observations** (§21) with evidence and *not* fixed.

---

## Table of contents

1. [The one rule the whole system is built around](#1-the-one-rule)
2. [The running example — real committed data](#2-the-running-example)
3. [The whole path at a glance](#3-the-whole-path-at-a-glance)
4. [`AuditService` — admission, queue, workers, ownership](#4-auditservice)
5. [`resolve` — getting the bytes onto disk, safely](#5-resolve)
6. [`deps` — making the program loadable](#6-deps)
7. [`inventory` — reading the package without a model](#7-inventory)
8. [Phase timing, timeouts, and the timeout scale](#8-phase-timing)
9. [The dealbreaker path — a verdict with zero hypotheses](#9-the-dealbreaker-path)
10. [`intent` — establishing the benign baseline](#10-intent)
11. [`flag` — the cheap, high-recall pass](#11-flag)
12. [The zero-flag early return (the `chalk` path)](#12-the-zero-flag-early-return)
13. [`hypothesize` — hypothesis, claim, experiment](#13-hypothesize)
14. [`experiments` — what a tool call compiles into](#14-experiments)
15. [`graph` — the state machine and its guards](#15-graph)
16. [`orchestrator` + `observation` + `sensors` — the full oracle](#16-the-full-oracle)
17. [`evidence` — timeline, sealing, content addressing](#17-evidence)
18. [`derive_graph_verdict` — where the verdict is actually decided](#18-the-verdict)
19. [The failure surface — every way this can not produce a verdict](#19-the-failure-surface)
20. [`events` — the SSE wire](#20-events)
21. [The two report stores](#21-the-two-report-stores)
22. [Who reads what — the contract table](#22-the-contract-table)
23. [Where the code diverges from the design docs](#23-code-vs-design-docs)
24. [Observations](#24-observations)

---

<a name="1-the-one-rule"></a>
## 1. The one rule the whole system is built around

Start with the problem. An npm package is a `.tgz` archive of files that lands
on your machine and can execute code *at install time* — before you have run a
single line of your own program. The question "is this package malicious?"
cannot be answered by pattern-matching source text, because the same code shape
is malicious or benign depending on what the package claims to be: a
configuration loader reading `process.env` is doing its job; a colour-formatting
library reading `~/.ssh/id_rsa` is not.

So the system does not ask "does this code look bad?" It asks a much narrower,
falsifiable question:

> Here is a specific suspected behaviour. Let us construct an environment in
> which that behaviour, if the code really does it, *must* happen. Run the code
> in that environment while recording everything it does. Then decide from the
> recording alone.

That is the founding rule, stated in the design spec as:

> A suspicion is cleared only by evidence from **running** it — never by a model
> **reading** it and calling it fine.
> — `docs/specs/2026-07-10-triage-hypothesis-redesign.md:12-14`

Three consequences follow, and they are worth internalising before any code:

1. **There is no "looks fine" exit.** A model that reads code is only allowed to
   *raise* suspicion, never to dismiss it. `docs/specs/2026-07-10-triage-hypothesis-redesign.md:45-46`
   states it as a hard requirement: "NO benign-dismiss branch."
2. **`SAFE` is a positive claim, not a default.** `SAFE` means: we built a trap
   for every suspicion we raised, ran the code in every trap, and nothing fired.
   `shared/src/models.ts:7-11` encodes this in the schema comment: "SAFE ⟺ every
   suspicion ran and showed no malice (presumption of innocence)."
3. **"We could not check" is not a verdict.** It is an error. If the machinery
   broke — the sandbox would not start, a model call failed, a timer ran out —
   the audit produces a *retryable error*, never a verdict. Same source:
   "An audit that cannot complete is not a verdict — it is a retryable
   `AuditIncompleteError`, so 'we couldn't check' can never leak out as a
   result."

`engine/CLAUDE.md:11-13` restates the same two invariants as house rules:

```
Audit failure is an ERROR, never a SAFE verdict or hidden coverage gap.
A suspicion can be cleared only by running its compiled experiment under the
full oracle. Confirm/refute transitions require evidence.
```

Everything in the rest of this document is the mechanism that makes those three
consequences structurally true rather than merely intended.

---

<a name="2-the-running-example"></a>
## 2. The running example — real committed data

Every value in every diagram below is copied from committed data in this
repository. Nothing is invented. There are two sources, and it matters which is
which:

```
┌─ SOURCE A: the LLM replay fixture bundle ─────────────────────────────────┐
│ engine/tests/fixtures/llm/test-pkg-env-exfil@2.0.1/                        │
│   manifest.json          ← provenance, model ids, prompt hashes            │
│   exchanges/*.json       ← 55 real HTTP request/response pairs to the      │
│                            model provider (prompt text AND model reply)    │
│   sandbox/hyp-00NN.runartifact.json   ← the sealed evidence of each run    │
│   sandbox/hyp-00NN.timeline.txt       ← the rendered timeline the judge saw│
│   hypotheses.json        ← the 14 armed hypotheses                         │
│                                                                            │
│ provenance.source = "prod-jsonl"                                           │
│ provenance.auditIds = ["b184aed2-cddc-4c14-8c71-d9ed27a91cbd"]             │
│ ⇒ this is ONE real production audit, captured off the wire.                │
└────────────────────────────────────────────────────────────────────────────┘

┌─ SOURCE B: the demo replay recording ─────────────────────────────────────┐
│ engine/demo-data/test-pkg-env-exfil.json                                   │
│   { packageName, version, events[68], files{3}, report }                    │
│                                                                            │
│ report.hypotheses / counts / verdict / confirmedHypIds  ← FAITHFUL: byte-  │
│   identical to SOURCE A (same run ids, same judge prose)                    │
│ report.fileSummaries / report.trace / some event payloads ← CURATED for    │
│   the demo. See Observations §24.1. Do not treat as engine output.          │
└────────────────────────────────────────────────────────────────────────────┘
```

Where a value comes from the *model boundary* (a prompt, a model reply, a
timeline, a run artifact) this document cites **Source A**. Where a value comes
from the *final report* (verdict, counts, hypothesis states) it cites **Source
B**, which agrees with A.

### The package under audit

`test-pkg-env-exfil@2.0.1` — three files, all shown in full because the whole
document refers back to them.

```
┌─ package.json ────────────────────────────────────────────────────────────┐
│ {                                                                          │
│   "name": "test-pkg-env-exfil",                                            │
│   "version": "2.0.1",                                                      │
│   "description": "Smart configuration loader with environment detection",   │
│   "main": "index.js",                                                      │
│   "scripts": { "preinstall": "node setup.js" },   ◀── THE ATTACK SURFACE   │
│   "keywords": ["config", "env", "loader", "dotenv"],                        │
│   "author": "test-author",                                                 │
│   "license": "MIT"                                                         │
│ }                                                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

A `preinstall` script runs *automatically*, as a plain `node setup.js`, the
moment someone types `npm install test-pkg-env-exfil`. No user code needs to
import anything.

```
┌─ index.js  (876 bytes) — the decoy ───────────────────────────────────────┐
│ exports loadConfig(options): copies process.env into an object, then reads │
│ options.path || path.resolve(process.cwd(), ".env") and parses KEY=VALUE.  │
│ Failures are swallowed by an empty catch. Nothing leaves the process.      │
│ ⇒ this file genuinely IS a config loader. It matches the stated purpose.   │
└────────────────────────────────────────────────────────────────────────────┘

┌─ setup.js  (2723 bytes) — the payload, run by preinstall ──────────────────┐
│ EXFIL_URL = "http://localhost:9999/exfil"                                  │
│ IMDS_URL  = "http://169.254.169.254/latest/meta-data/"                     │
│                                                                            │
│ harvestEnv()          → collects 18 named secrets (NPM_TOKEN,              │
│                          AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, …) PLUS any  │
│                          env key matching /token|secret|key|password|      │
│                          auth|credential/i                                 │
│ readCredentialFiles() → reads ~/.npmrc ~/.yarnrc ~/.ssh/id_rsa             │
│                          ~/.ssh/id_ed25519 ~/.aws/credentials ~/.aws/config│
│                          ~/.gitconfig ~/.docker/config.json ~/.kube/config │
│ probeIMDS(cb)         → HTTP GET the cloud-metadata service               │
│ exfiltrate(payload)   → HTTP POST the whole blob to EXFIL_URL              │
│                                                                            │
│ At module scope (no function call needed):                                 │
│   const stolen = { hostname, username, platform, arch, cwd,                │
│                    env: harvestEnv(), files: readCredentialFiles(), … }    │
│   probeIMDS(d => { stolen.imds = d; exfiltrate(stolen); })                 │
│ ⇒ merely LOADING this file performs the theft. There is no trigger to find.│
└────────────────────────────────────────────────────────────────────────────┘
```

Note `const SAFE_TEST_MODE = true;` at the top of both files. It is never read.
It is decoration — and, as we will see, the FLAG pass notices exactly that and
flags it (§11), and the resulting hypothesis is later **refuted** because
nothing in the run corresponds to it (§16).

### The SAFE contrast

`chalk@5.6.2` — a terminal-colour library, 12 files. Two committed audits of it
exist and they exercise **different** SAFE paths, which is useful:

| Source | Flags | Hypotheses | Path taken | Verdict rationale |
|---|---|---|---|---|
| `engine/demo-data/chalk.json` | 0 | 0 | zero-flag early return (`pipeline.py:348-353`) | `"No suspicions were raised."` |
| `engine/tests/fixtures/llm/chalk@5.6.2/` | ≥1 | 1 | full loop, judge refuted | `"All 1 suspicion ran and showed no malice."` |

Both are `SAFE`. §12 and §18 explain why the two rationales differ and why both
are legitimate.

---

<a name="3-the-whole-path-at-a-glance"></a>
## 3. The whole path at a glance

Here is the entire audit core, with the real values for the running example
flowing through it. Every box is expanded into its own section afterwards.

```
        HTTP: POST /audit  or  POST /audit/stream   (payment verified first)
                                  │
                                  ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │ AuditService.admit / submit                            service.py:78-123│
 │   reserve()  ── DB queued-count < queue_size(50)? ─── else NPMGUARD-0040│
 │   sessions.create() → row audit_sessions(status='queued')               │
 │   _pending[audit_id] = Future ; queue.put_nowait(audit_id)              │
 │   emit  audit_enqueued {queuePosition: 1}                              │
 └────────────────────────────────────────────────────────────────────────┘
                                  │  one of max_concurrent(4) workers
                                  ▼
 ┌────────────────────────────────────────────────────────────────────────┐
 │ _worker → mark_running (guarded queued→running) → _execute             │
 │                                                       service.py:125-153│
 └────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼   AuditPipeline.run(...)   pipeline.py:157
 ┌──────────────┐  emit audit_started {packageName}
 │              │
 │  ① RESOLVE   │ IN : ("test-pkg-env-exfil", None)
 │  240 s cap   │ OUT: ResolvedPackage(path=/tmp/npmguard-XXXX/test-pkg-env-
 │              │      exfil, workdir=/tmp/npmguard-XXXX, version=None)
 └──────┬───────┘      resolve.py:108-153
        │              ⚠ path MUST live inside workdir — asserted, resolve.py:41
        ▼
 ┌──────────────┐  emit dependencies_provisioned
 │ ② DEPS       │ IN : package.json.dependencies = {}
 │ best-effort  │ OUT: DependencyProvision(installed=False, package_count=0,
 │ 180 s cap    │      skipped_reason="no runtime dependencies")  deps.py:87-96
 └──────┬───────┘
        ▼
 ┌──────────────┐  emit file_list, inventory_meta
 │ ③ INVENTORY  │ IN : the directory
 │  60 s cap    │ OUT: files=[index.js(js,876B,0644) setup.js(js,2723B,0644)
 │  no LLM      │              package.json(json,307B,0644)]
 │              │      scripts={preinstall:"node setup.js"}
 │              │      entryPoints={install:["setup.js"],runtime:["index.js"],
 │              │                   bin:[]}
 │              │      flags=[[info] lifecycle-scripts: declares preinstall]
 │              │      dealbreaker=None      inventory.py:282-294
 └──────┬───────┘
        │  ⚡ if dealbreaker is not None → DANGEROUS, 0 hypotheses, RETURN (§9)
        ▼
 ┌──────────────┐  emit intent_extracted
 │ ④ INTENT     │ IN : manifest + README (none) + prod deps (none) + bin (none)
 │ 120 s cap    │ OUT: PackageIntent(
 │ LLM: triage  │        statedPurpose="Smart configuration loader with
 │              │                       environment detection",
 │              │        expectedCapabilities=["load configuration files",
 │              │          "detect environment variables","parse .env files"],
 │              │        degraded=False)          phases.py:371-396
 └──────┬───────┘
        ▼
 ┌──────────────┐  emit file_analyzing ×2, triage_progress 1/2 2/2
 │ ⑤ FLAG       │ IN : per source file: whole numbered source + intent
 │ 600 s × 1.0  │      + structural facts for that file
 │ LLM: triage  │ OUT: 14 Flags total —
 │ fan-out      │        setup.js → 8 flags (lines 8,9 / 11,30 / 32,46 /
 │ (8 at once)  │                    48,72 / 74,82 / 84,106 / 108,118 /
 │              │                    120,123)
 │              │        index.js → 6 flags (1 / 16 / 18 / 10-14 / 22-23 /
 │              │                    25-27)
 │              │      + one FileSummary per file    phases.py:434-560
 └──────┬───────┘
        │  ⚡ if flags == [] → SAFE, 0 hypotheses, RETURN (§12)
        ▼
 ┌──────────────┐  emit file_analyzing ×14, hypothesis_emitted ×14,
 │ ⑥ HYPOTHESIZE│       file_verdict ×2, triage_complete
 │ 1200 s × 1.0 │ IN : 1 Flag  (fan-out: 8 concurrent)
 │ LLM: invest. │ OUT: 1 Hypothesis with a COMPILED, DRY-RUN-VERIFIED
 │ 1 flag →     │      experiment: ToolCall[]         phases.py:749-799
 │ 1 hypothesis │      hyp-0001 … hyp-0014
 └──────┬───────┘
        ▼
 ┌──────────────┐  emit graph_built {nodeCount:14, addedCount:14, mergedCount:0}
 │ ⑦ GRAPH      │ fuzzy-dedup on description (Jaro-Winkler ≥ 0.88)
 │              │ every node admitted OPEN and armed        graph.py:268-275
 └──────┬───────┘
        ▼
 ┌──────────────┐  emit hypothesis_resolved ×14
 │ ⑧ ORCHESTRATOR│ loop while an OPEN node exists, highest severity first:
 │ budget        │   OPEN → IN_PROGRESS → run under FULL ORACLE → render
 │ 2400 s × 1.0  │   timeline → judge → CONFIRMED | REFUTED | DEFERRED
 │ per-hyp 360 s │ OUT: confirmed=1 refuted=13 deferred=0
 │ LLM: judge    │      orchestrator.py:152-305
 └──────┬───────┘
        │  ⚡ if 0 CONFIRMED and ≥1 DEFERRED → raise AuditIncompleteError (§19)
        ▼
 ┌──────────────┐
 │ ⑨ VERDICT    │ derive_graph_verdict(graph)              graph.py:295-331
 │              │ OUT: DANGEROUS · "1 confirmed hypothesis with cited dynamic
 │              │      evidence." · counts{total:14,open:0,inProgress:0,
 │              │      confirmed:1,refuted:13,deferred:0}
 │              │      confirmedHypIds=["hyp-0008"]
 └──────┬───────┘
        ▼  AuditResult(report, package_path, resolved)  ← RETURNED, not emitted
 ┌────────────────────────────────────────────────────────────────────────┐
 │ AuditService._execute                                 service.py:273-346│
 │  1. save_report(name, version, report)  → data/reports/…/2.0.1.json    │
 │  2. ONE TRANSACTION: sessions.finalize(row→'done', report=…)            │
 │                    + stream.append('verdict_reached', …)               │
 │  3. finally: result.cleanup() → rmtree the private workdir             │
 └────────────────────────────────────────────────────────────────────────┘
```

Two structural facts to hold on to from this diagram:

- **`AuditPipeline.run` never emits a terminal frame.** It *returns* a report or
  *raises*. The terminal transition (row → `done`/`error` plus the
  `verdict_reached`/`audit_error` frame) belongs to `AuditService._finish`, and
  the two writes commit in one transaction. This is stated as an invariant at
  `pipeline.py:165-168` and enforced at `service.py:263-271`.
- **Three of the nine boxes can return early**, and each early return is a
  *different* verdict shape: dealbreaker → `DANGEROUS` with zero hypotheses
  (§9); zero flags → `SAFE` with zero hypotheses (§12); unevaluated hypotheses →
  no verdict at all (§19).

---

<a name="4-auditservice"></a>
## 4. `AuditService` — admission, queue, workers, ownership

`engine/npmguard/service.py`. This is the layer that decides *whether* an audit
runs, *when*, and *who is responsible for finishing it*. It contains no
detection logic at all.

### 4.1 The two counters that are not the same thing

```
┌─ DURABLE (SQL) ──────────────────────┐   ┌─ HOT (in-memory) ─────────────┐
│ audit_sessions rows WHERE            │   │ self.queue : asyncio.Queue    │
│   status='queued' AND                │   │   UNBOUNDED  service.py:57-60 │
│   file_contents IS NULL              │   │ self._pending : dict[str,     │
│ counted by queued_count()            │   │   Future]     service.py:61   │
│   persistence.py:145-158             │   │ self._workers : max_concurrent│
│ THIS is the admission bound.         │   │   tasks       service.py:64-69│
└──────────────────────────────────────┘   └───────────────────────────────┘
```

The `asyncio.Queue` is deliberately **unbounded**, and the comment at
`service.py:57-59` says exactly why:

> UNBOUNDED: the real admission bound is `reserve()`/`queued_count()` (DB), run
> BEFORE claim/create so a claimed paid audit is NEVER dropped by a
> `put_nowait` QueueFull. The `asyncio.Queue` only carries slack.

The reasoning chain: a paid audit has a payment proof that is atomically claimed
in SQL (`persistence.py:270-313`). Once claimed, the proof is spent — it cannot
be reused. So if the in-memory enqueue could fail, the customer would have paid
for nothing. The fix is to move the refusal *earlier*, before any state changes:

```
 reserve()                     service.py:71-76
 ┌─────────────────────────────────────────────────────────────────┐
 │ if await sessions.queued_count() >= self.queue_size:            │
 │     raise QueueFullError()          ← NPMGUARD-0040, 503, retry │
 │ (no side effects — no row, no claim, no future)                 │
 └─────────────────────────────────────────────────────────────────┘
              │ passes
              ▼
 create row 'queued'  ──or──  claim_payment (row + claim, one txn)
              │
              ▼
 submit(session)  ← the SINGLE owner entry every path reaches
```

`queue_size` defaults to 50 (`config.py:146`), `max_concurrent` comes from
`max_running_sessions`, default 4 (`config.py:152`, wired at `api.py:672-678`).
The comment at `config.py:147-151` explains the choice of 4: each concurrent audit
is a live Docker sandbox with `sandbox_memory_mb` plus node/strace/tcpdump
overhead, so this is the hard RAM-bound cap, and over-cap audits **queue rather
than fail**.

Both `queued()` and `queued_count()` filter `file_contents IS NULL`
(`persistence.py:131-158`). `file_contents` non-NULL is the de-facto tag for a
*demo replay* row, which is driven by `DemoService`, not `AuditService`
(`persistence.py:77-79`). So a running demo can never consume a real audit's
queue slot, and restart recovery never sweeps a demo row.

### 4.2 `submit` and the atomicity trick

```
 submit(session)                                        service.py:85-123
 ┌───────────────────────────────────────────────────────────────────────┐
 │ aid = session.audit_id                                                │
 │                                                                       │
 │ if aid in self._pending:            ← already owned (queued|running)  │
 │     return SubmitResult(aid, qsize, self._pending[aid], created=False) │
 │                                                                       │
 │ if session.status == "done":        ← terminal, no-op                  │
 │     fut = loop.create_future(); fut.set_result(session.report or {})   │
 │     return SubmitResult(aid, 0, fut, created=False)                    │
 │                                                                       │
 │ fut = loop.create_future()                                            │
 │ self._pending[aid] = fut            ◀── NO `await` BETWEEN THE CHECK   │
 │                                          ABOVE AND THIS ASSIGNMENT     │
 │ if session.status == "error":                                          │
 │     await self.sessions.reset_to_queued(aid)   ← error→queued, guarded │
 │ self.queue.put_nowait(aid)                                            │
 │ emit audit_enqueued {queuePosition: self.queue.qsize()}               │
 └───────────────────────────────────────────────────────────────────────┘
```

The "no `await` between the check and the assignment" is the whole
concurrency-safety argument, spelled out at `service.py:88-91` and
`service.py:102-109`. asyncio runs one coroutine at a time on one thread; a
coroutine can only be suspended at an `await`. Since there is no `await` between
reading `self._pending` and writing it, the check-then-set is *atomic* with
respect to another `submit` for the same `audit_id`. Two concrete races collapse
to one execution because of it:

1. **Webhook vs stream.** A Stripe webhook and the client's own
   `POST /audit/stream` can both arrive for the same claimed payment.
2. **Double paid replay of an errored claim.** Two callers both read
   `status == 'error'` and both try to retry.

The comment at `service.py:106-109` records the bug this ordering fixed: the old
code awaited `reset_to_queued` *before* registering in `_pending`, so both
errored replays reached the guarded reset, and the loser's assertion
(`persistence.py:189-192`, `rowcount == 1`) fired — turning a valid retry into a
spurious HTTP 500.

The ordering inside the `status == "error"` branch is also load-bearing
(`service.py:112-116`): the `error → queued` commit must happen **before**
`put_nowait`, because a worker that dequeued a still-`error` row would see
`status != 'queued'` and skip it (`service.py:130-131`), silently dropping a paid
claim.

### 4.3 The worker loop

```
 _worker()  (one per max_concurrent)                    service.py:125-153
 ┌───────────────────────────────────────────────────────────────────────┐
 │ while True:                                                           │
 │   aid = await self.queue.get()                                        │
 │   try:                                                                │
 │     session = await sessions.get(aid)                                 │
 │     if session is None or session.status != "queued": continue        │
 │         ← closed / reset / gone between enqueue and dequeue           │
 │     if not await sessions.mark_running(aid): continue                 │
 │         ← lost the GUARDED queued→running UPDATE (rowcount 0)          │
 │     result = await self._execute(await sessions.get(aid))             │
 │   except Exception as exc:  fut.set_exception(exc)                    │
 │   else:                     fut.set_result(result)                    │
 │   finally:                                                           │
 │     fut = self._pending.get(aid)                                     │
 │     if fut is None or fut.done(): self._pending.pop(aid, None)        │
 │         ◀── an UNRESOLVED future is DELIBERATELY LEFT in _pending     │
 │     self.queue.task_done()                                           │
 └───────────────────────────────────────────────────────────────────────┘
```

`mark_running` (`persistence.py:160-174`) is a conditional `UPDATE … WHERE
status='queued'` returning whether *this* call won. The comment is explicit that
a rowcount of 0 is **not** an assertion failure — it is the normal outcome of
losing the race, and the worker must skip.

The `finally` block at `service.py:145-152` looks backwards until you read the
comment: if a `CancelledError` from `close()` ripped through `_execute`
mid-pipeline, the future is neither resolved nor cancelled. Popping it would
orphan it and leave the row stuck in `running`. Leaving it in `_pending` lets
`close()` step 4 finalise the row and resolve the future.

### 4.4 Restart recovery and shutdown — the never-drop rule

```
 _recover()  (called by start(), BEFORE workers spin up)  service.py:168-188
 ┌───────────────────────────────────────────────────────────────────────┐
 │ for session in sessions.running():        ← interrupted mid-Docker/LLM │
 │     _finish(aid, error="Audit interrupted by engine restart",          │
 │             event_type="audit_error",                                 │
 │             payload={code:"NPMGUARD-0031", retryable:True})           │
 │                                                                       │
 │ for session in sessions.queued():         ← never started              │
 │     _reenqueue(session)   → detached future + put_nowait               │
 └───────────────────────────────────────────────────────────────────────┘
```

The asymmetry is the point. A `running` row was mid-way through a Docker
container or an LLM call; a hard process stop cannot safely resume from that
midpoint, so it becomes an explicit, retryable `NPMGUARD-0031` in the durable
event log. A `queued` row never started, so it is simply re-enqueued and runs to
completion.

`_reenqueue` (`service.py:155-166`) creates a **detached** future — no HTTP
caller survives a restart — and attaches a done-callback that swallows the
exception so Python never warns about an unretrieved exception. It deliberately
does *not* re-emit `audit_enqueued`, because that frame was already appended
pre-restart and the log is durable.

`close(deadline=10s)` (`service.py:189-230`) has four steps and one
counter-intuitive post-condition:

```
 1. Drain the in-memory queue. These ids never started → LEAVE the rows
    'queued'. Resolve only their futures with AuditIncompleteError so no
    sync caller hangs. This loop has NO await, so no worker can dequeue
    mid-drain.                                            service.py:196-207
 2. asyncio.wait(inflight, timeout=deadline)  — let workers finish naturally.
                                                          service.py:209-214
 3. Cancel every worker task, gather with return_exceptions=True.
                                                          service.py:216-220
 4. For each still-owned id: _shutdown_finalize (0031 it ONLY if it reached
    'running'; LEAVE it 'queued' otherwise) and ALWAYS resolve its future.
                                                          service.py:222-230
```

**`deadline` is not the shutdown budget — it is one term in a sum.** This is worth
stating explicitly because getting it wrong caused a real, load-dependent test
failure. uvicorn's connection drain is **additive** to `audits.close`'s deadline, not
parallel with it: the lifespan shutdown that calls `close()` does not begin until the
drain has finished. Measured, SIGTERM to process exit:

```
   0.10s  uvicorn's fixed pre-drain sleep
 + 2.00s  connection drain — the FULL --timeout-graceful-shutdown when a
          client connection is still open (0.00s when nothing is open)
 + 1.50s  ONLY NOW the lifespan shutdown → audits.close(1.50)
 + 0.22s  llm / notifier / engine dispose, interpreter exit
 = 3.88s  with a leaked SSE stream · 1.82s with the stream closed
```

The earlier formulation — that `--timeout-graceful-shutdown` "only bounds connection
draining, so `close()` must return within the harness grace on its own" — is
*literally* true but tacitly assumes the drain costs ≈ 0, which holds only when no
connection is open. That omission is exactly what let a 4.0 s harness grace be
written against a 3.9 s reality, producing a failure that appeared in 13.9% of runs
under parallel load and 0% serially. If you are sizing any timeout around shutdown,
size it against the **sum**.

The post-condition is: *no owned session is left `running` and no owned future
is unresolved.* Never-started `queued` rows are deliberately **not** finalised to
error, because "a graceful shutdown must not drop a claimed paid audit that a
crash would have preserved" (`service.py:190-195`) — crash/graceful parity on
the never-drop rule.

**That post-condition is scoped to `close()` *returning*.** A process death *inside*
`close()` leaves rows `running`, **by design**, and `_recover` repairs them to a
retryable `0031` on the next boot. So "rows left `running`" is not evidence of a bug —
it is the crash path behaving identically to the graceful one, which is the whole
point of the never-drop rule. A forced sweep that SIGKILLed at seven points inside
`close()` and restarted on the same database each time produced exactly one
`audit_error`/`0031` in every interleaving — never zero, never two, and never a
dropped audit.

### 4.5 `_finish` — the one place a terminal frame is written

```
 _finish(audit_id, *, event_type, payload, report=None, error=None)
                                                       service.py:254-271
 ┌───────────────────────────────────────────────────────────────────────┐
 │ async with self.sessions.transaction() as db:                         │
 │     await self.sessions.finalize(audit_id, report, error, session=db) │
 │     await self.stream.append(audit_channel(audit_id),                 │
 │                              event_type, payload, session=db)         │
 └───────────────────────────────────────────────────────────────────────┘
```

The invariant, quoted from `service.py:263-268`:

> the non-terminal→terminal row transition and the terminal event
> (`verdict_reached` | `audit_error`) commit in ONE transaction. No consumer can
> observe a terminal frame for a non-terminal row; a failed append rolls the row
> back, where restart recovery repairs it — never a terminal row with no
> terminal event, never a suppressed emit stranding a follower.

`finalize` (`persistence.py:210-243`) is itself guarded: `WHERE status IN
('queued','running')`, and it **asserts** `rowcount == 1`. A missing or
already-terminal row is a lifecycle bug, not a silent no-op, and specifically it
refuses a `done → error` overwrite.

And in `_execute` (`service.py:273-346`) the ordering across stores is also an
invariant:

```
 result = await pipeline.run(...)          ← returns; never emits terminal
 report = result.report.model_dump(mode="json", exclude_none=False)
 save_report(name, requested_version or "latest", result.report)   ← DISK FIRST
   except UnversionedReportError: log.error and CONTINUE   service.py:316-337
     ← a COMPLETED audit is never discarded over a filing key (§24.3)
 _finish(..., event_type="verdict_reached", payload={verdict, rationale,
                                            counts, confirmedCount})  ← THEN ROW
 finally: result.cleanup()                 ← unconditional workspace rmtree
```

`service.py:284-288`: "the report is durable on disk before the row leaves
`running`, and `verdict_reached` commits atomically with `running→done` — a
client acting on the terminal frame always finds the persisted report." The
`finally` is unconditional so a save/finalize failure cannot leak the temp
workspace (`service.py:326-328`).

The `except UnversionedReportError` arm is the §24.3 fix, and it is a deliberate
weakening of "disk first": when there is no honest `(name, version)` key the
secondary store is skipped rather than faked as a `latest.json` alias, and the
audit still completes. The durable record is `audit_sessions.report` keyed by
`audit_id`, which is what `GET /audit/{id}/report` and the terminal SSE frame
serve, so the verdict still reaches every consumer of *this* audit.

On any exception (`service.py:330-346`):

```
 message   = str(exc) or type(exc).__name__
 code      = exc.code      if isinstance(exc, NpmGuardError) else "NPMGUARD-9999"
 retryable = exc.retryable if isinstance(exc, NpmGuardError) else False
 _finish(..., error=message, event_type="audit_error",
         payload={error, code, retryable})
 log.exception(...) ; raise         ← re-raised so the worker resolves the future
```

### 4.6 What `AuditService` guarantees — and what it does not

**Guaranteed (per process):**

| Guarantee | Mechanism |
|---|---|
| At most one execution per `audit_id` | `_pending` check-then-set with no intervening `await` (`service.py:88-96, 110-111`) + guarded `mark_running` (`persistence.py:160-174`) |
| A refusal creates no row and spends no payment proof | `reserve()` has no side effects and runs before create/claim (`service.py:71-83`) |
| Concurrency never exceeds `max_concurrent` | fixed worker pool (`service.py:64-69`) |
| No terminal frame without a terminal row, and vice versa | single-transaction `_finish` (`service.py:269-271`) |
| A queued claim is never dropped by restart or graceful shutdown | `_recover` re-enqueues (`service.py:186-187`); `close` leaves `queued` rows queued (`service.py:189-195, 232-247`) |
| An interrupted `running` audit becomes an explicit retryable 0031 | `_recover` (`service.py:178-185`), `_shutdown_finalize` (`service.py:232-247`) |
| The report is on disk before any client can see the verdict frame | ordering in `_execute` (`service.py:282-325`) — with one deliberate exception: when no concrete version exists the file is skipped rather than faked, and the verdict still lands on the row and the wire (§24.3) |

**Not guaranteed — read this carefully:**

The class docstring calls `AuditService` the "**Sole owner** of audit execution"
(`service.py:31`). That property is **process-local**, because the ownership map
is a plain Python dict:

```python
self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}   # service.py:61
```

Consequences if two engine processes share one database:

- **Single-execution still holds**, but only because of SQL, not because of
  `_pending`. Two processes would both dequeue nothing shared (the
  `asyncio.Queue` is per-process), but both would re-enqueue the same durable
  `queued` rows at start; the guarded `mark_running` UPDATE means exactly one
  wins and the other `continue`s (`service.py:132-133`).
- **`_recover` is destructive across processes.** Process B starting up will see
  process A's legitimately `running` rows (`persistence.py:116-129` selects by
  status only) and finalise every one of them to `NPMGUARD-0031`
  (`service.py:178-185`). Process A's worker then reaches its own `_finish`,
  whose `finalize` asserts `rowcount == 1` and fails, because the row is already
  terminal.
- **The wait-queue bound is global but the worker pool is not.** `queue_size`
  counts DB rows so it is shared; `max_concurrent` is per process, so N
  processes run up to `N × max_concurrent` concurrent Docker sandboxes.
- **`SubmitResult.future` is only resolvable in the process that created it.** A
  caller in process A cannot await an audit executed by process B; it must
  follow the SSE stream instead.

So: "single owner" means *one owner per audit per process*, and the deployment
contract is one engine process per database. Nothing in the code enforces that.

---

<a name="5-resolve"></a>
## 5. `resolve` — getting the bytes onto disk, safely

`engine/npmguard/resolve.py`. Input: a package name and an optional version.
Output: a directory on the local filesystem containing the package's files.

The security problem: we are about to unpack an archive authored by an attacker
and then let code run against it. Two classic escapes must be closed — a tar
entry that writes outside the extraction root (`../../etc/cron.d/x`), and a
symlink that *points* outside it.

### 5.1 The invariant that makes cleanup unconditional

```
┌─ ResolvedPackage ─────────────────────────────── resolve.py:24-43 ────────┐
│ path:    Path   ← the package root (contains package.json)                │
│ workdir: Path   ← a fresh per-run tempdir, owned exclusively by this audit│
│ version: str|None  ← registry-resolved concrete version;                  │
│                      None for local test fixtures                         │
│                                                                           │
│ __post_init__ asserts:                                                    │
│   self.path.resolve().is_relative_to(self.workdir.resolve())              │
│   "resolved path {path} escapes its private workdir {workdir}"            │
└───────────────────────────────────────────────────────────────────────────┘
```

Because that assertion holds, three later behaviours become trivially safe:

- `cleanup_package` is an unconditional `shutil.rmtree(resolved.workdir,
  ignore_errors=True)` — no `needs_cleanup` tri-state to get wrong
  (`resolve.py:156-159`).
- `deps.provision_dependencies` may unpack a `node_modules` tree *into*
  `resolved.path` without any risk of mutating a committed fixture tree
  (`resolve.py:37-40`).
- `deps.py:82-86` can reason that "`node_modules` exists ⇒ the package **ships**
  it" rather than "residue from a previous audit".

### 5.2 The two acquisition paths

```
 resolve_package(name, version)                          resolve.py:108-153
 workdir = mkdtemp(prefix="npmguard-")
   │
   ├── name.startswith("test-pkg-") and the fixture dir exists?   :46-50
   │     ┌───────────────────────────────────────────────────────────────┐
   │     │ OFFLINE SHORT-CIRCUIT — no network                             │
   │     │ shutil.copytree(fixture, workdir/name, symlinks=True)          │
   │     │ _reject_escaping_symlinks(path, workdir)            :81-90      │
   │     │   every symlink whose .resolve() leaves workdir → ValueError    │
   │     │   ("bench fixtures are live malware and may ship symlinks")     │
   │     │ ⇒ ResolvedPackage(path, workdir, version=None)                  │
   │     └───────────────────────────────────────────────────────────────┘
   │       ↑ our running example takes THIS path — hence version=None,
   │         and the concrete "2.0.1" is recovered later from package.json.
   │
   └── otherwise: the npm registry
         GET {NPM_REGISTRY}/{name}/{version or "latest"}          :53-65
           404               → PackageNotFoundError   NPMGUARD-0001, HTTP 404
           malformed JSON    → ValueError (no `version`/`dist.tarball` string)
           else              → (resolved_version, tarball_url)
         stream the .tgz to workdir/package.tgz (httpx, 60 s, redirects)
         _safe_extract(archive, workdir/extracted)                 :68-78
           for every member:  (dest/member.name).resolve() must stay under root
                              → else "tar entry escapes extraction root"
           for sym/hard links: (target.parent/linkname).resolve() must too
                              → else "tar link escapes extraction root"
           then extractall(..., filter="data")   ← Python's own hardening
         path = _package_root(extracted, name)                     :93-105
         ⇒ ResolvedPackage(path, workdir, version=resolved_version)

 any BaseException → shutil.rmtree(workdir, ignore_errors=True); raise  :142-153
   ◀── BaseException, not Exception (67f830f): this function awaits a registry
       lookup and a streaming download, so CancelledError is a live exit — the
       phase timeout and engine shutdown both arrive that way. `except
       Exception` missed both and leaked the whole extracted tree into /tmp.
```

`_package_root` deserves attention because it refuses to guess. npm's convention
is that a tarball contains a single `package/` directory, but that is convention,
not law. So:

```
 candidates = [extracted, *sorted(immediate subdirectories)]
 roots      = [c for c in candidates if (c/"package.json").is_file()]
 if len(roots) != 1: raise ValueError(
     "tarball for {name} has no unambiguous package root: {n} candidate
      directories contain a package.json")
 return roots[0]
```

Zero candidates and two candidates are both errors. The docstring
(`resolve.py:94-97`) states the principle: "Absence or ambiguity is a checked
error, never an arbitrary-first-dir guess."

`NPM_REGISTRY` is read from `NPMGUARD_NPM_REGISTRY`, defaulting to
`https://registry.npmjs.org` (`resolve.py:21`, now read from the validated
`npm_registry` setting rather than raw `os.environ` — see §24.20).

**Phase result for the running example** (`pipeline.py:163-179`):

```
 IN : {"packageName": "test-pkg-env-exfil", "version": null}
 OUT: {"path": "/tmp/npmguard-<rand>/test-pkg-env-exfil", "version": null}
 timeout: 240_000 ms → exceeded ⇒ AuditTimeoutError("resolve", 240000)
 side effect: sessions.set_package_path(audit_id, str(resolved.path))  :206
              ← this is what lets GET /audit/{id}/file/{path} serve source
                to the frontend later (api.py:396-417)
```

---

<a name="6-deps"></a>
## 6. `deps` — making the program loadable

`engine/npmguard/deps.py`. This phase exists to solve one specific failure that
would otherwise poison the verdict.

### 6.1 The failure it prevents

Consider a package whose `index.js` starts with `require('axios')`. If
`node_modules` is absent, running it produces:

```
Error: Cannot find module 'axios'    →  node exits 1
```

The program under test **never loaded**. Nothing it might have done could
possibly have been observed. If the orchestrator treated that as "we ran it and
saw no malice," a missing dependency would launder an unproven suspicion into
`SAFE`. So the system does two things: it installs dependencies up front (this
phase), and — crucially — it treats a module-resolution crash as a *coverage
gap*, not a refutation (§16.7). The docstring is explicit
(`deps.py:78-81`):

> Best-effort by design. A failure leaves `node_modules` absent; the orchestrator
> then DEFERS (never REFUTES) any experiment that crashes on the missing module,
> so an install failure can never be laundered into a false SAFE verdict.

### 6.2 How it installs code without executing it

```
 provision_dependencies(package_path, settings)             deps.py:69-194
 ┌──────────────────────────────────────────────────────────────────────┐
 │ if (package_path/"node_modules").exists():                            │
 │     → DependencyProvision(False, 0,                                   │
 │         skipped_reason="node_modules already present")        :82-86   │
 │     (safe to interpret as "the package SHIPS it", per the             │
 │      ResolvedPackage invariant — never cross-run residue)             │
 │                                                                       │
 │ deps = _runtime_dependencies(package_path)                   :38-66    │
 │ if not deps: → (False, 0, skipped_reason="no runtime dependencies")    │
 │     ◀── our running example stops HERE                        :87-96   │
 └──────────────────────────────────────────────────────────────────────┘
                     │ deps non-empty
                     ▼
 ┌─ a THROWAWAY, NETWORK-ENABLED, CODE-FREE install container ──────────┐
 │ docker run -d --name npmguard-install-<12 hex>                        │
 │   --network=bridge          ← needs the registry                      │
 │   --cap-drop=ALL --read-only --user 1000:1000 --pids-limit 512        │
 │   --memory=max(1024, sandbox_memory_mb)m  --cpus=max(2.0,sandbox_cpus)│
 │   --tmpfs /work:rw,size=512m   /tmp:rw,size=256m   /home/node:128m    │
 │   -e npm_config_cache=/tmp/.npm  -e npm_config_update_notifier=false  │
 │   -w /work  <sandbox_image>  sleep infinity                  :98-128   │
 │ FileNotFoundError on the docker binary → DockerUnavailableError        │
 │                                          NPMGUARD-0020        :131-132  │
 │ non-zero start → (False, 0, error="install container failed to start") │
 │                                                              :133-136 │
 └──────────────────────────────────────────────────────────────────────┘
                     ▼
 write /work/package.json = {"name":"npmguard-install-target",
   "version":"0.0.0","private":true,"dependencies":deps}       :139-147
                     ▼
 npm install --ignore-scripts --omit=dev --no-package-lock                
             --no-audit --no-fund --loglevel=warn      wall 180_000 ms
                                                              :148-162
   ◀── --ignore-scripts is THE safety property: dependency CODE is never
       executed. Packages are downloaded and unpacked, nothing more.
   timed_out → error="npm install exceeded 180000ms budget"
   exit != 0 → error="npm install exit={code}: {stderr[:300]}"
                     ▼
 _stream_tar(container, "/work", "node_modules")               :197-242
   docker exec <c> tar c -C /work node_modules  →  read stdout in 1 MiB
   chunks, stderr drained concurrently (cap 64 KiB)
   if total > 256 MiB → kill and RAISE DependencyStreamError    :230-235
   nonzero tar exit  → RAISE                                    :240-241
     ◀── load-bearing: `tar c` of a MISSING dir exits 2 AND writes a valid
         EMPTY archive, which used to become installed=True/count=0 —
         success claimed for total failure (fixed in 67f830f)
   caller catches → error="node_modules extraction failed: {exc}"  :175-176
   ◀── WHY tar-over-exec instead of `docker cp`? deps.py:17-20: docker cp
       cannot read a tmpfs mount, and /work IS a tmpfs.
                     ▼
 tarfile.extractall(package_path, filter="data")                :173-174
 installed = count of directories directly under node_modules   :183
 → DependencyProvision(True, installed)
                     ▼
 finally: docker rm -f <container>, exceptions suppressed       :192-194
```

Note the return shape carefully: `DependencyProvision(installed: bool,
package_count: int, skipped_reason: str|None, error: str|None)`
(`deps.py:26-31`). **Every** failure mode returns a value with `error` set — none
of them raise — except `DockerUnavailableError`, which does raise and aborts the
audit. The pipeline emits the whole thing as a `dependencies_provisioned` frame
and continues regardless (`pipeline.py:207-226`).

For the running example: `dependencies` is absent from `package.json`, so
`_runtime_dependencies` returns `{}` and the phase returns
`installed=False, package_count=0, skipped_reason="no runtime dependencies"` —
no container is created at all.

Two more details: this phase is **not** wrapped in `_timed_phase`, so it has no
`AuditTimeoutError` — its bound is the internal 180 s `INSTALL_WALL_MS`. And it
runs *before* inventory, so the `node_modules` tree it creates is invisible to
inventory's file walk, which skips `node_modules` via `SKIP_DIRS`
(`config.py:255`, applied at `inventory.py:142`).

---

<a name="7-inventory"></a>
## 7. `inventory` — reading the package without a model

`engine/npmguard/inventory.py`. This is the only analysis phase with **no LLM**.
It is pure, deterministic, file-and-manifest inspection, and it produces three
distinct kinds of output that must not be confused:

```
┌─ InventoryReport ──────────────────── contract shape: backend.ts:74-83 ───┐
│ metadata     PackageMetadata  name/version/description/license/homepage/  │
│                               keywords/repository                         │
│ scripts      dict[str,str]    package.json "scripts" verbatim             │
│ entryPoints  {install[], runtime[], bin[]}                                │
│ dependencies {prod{}, dev{}, optional{}, peer{}}                          │
│ files        FileRecord[]     path/fileType/sizeBytes/permissions/        │
│                               isBinary/binaryType                         │
│ flags        InventoryFlag[]  ← STRUCTURAL FACTS. Advisory. Fed to FLAG   │
│                                 as extra context for the model.           │
│ dealbreaker  DealBreaker|null ← A VERDICT ON ITS OWN. Ends the audit.     │
└───────────────────────────────────────────────────────────────────────────┘
```

The distinction between `flags` and `dealbreaker` is the important one: a *flag*
is a hint handed to a language model; a *dealbreaker* short-circuits the entire
pipeline to `DANGEROUS` (§9).

### 7.1 Manifest parsing

```
 parse_package_json(package) → (metadata, scripts, entry_points, dependencies)
                                                      inventory.py:296-328
 ┌───────────────────────────────────────────────────────────────────────┐
 │ INSTALL_TIME_HOOKS = ("preinstall","install","postinstall")    :33    │
 │ BUILD_TIME_HOOKS   = ("prepare","prepublish")                 :34    │
 │ LIFECYCLE_SCRIPTS  = frozenset(both)                          :35    │
 │   ◀── TUPLES, not sets. frozenset iteration order over str varies    │
 │       per PROCESS, and this order reaches entryPoints.install and     │
 │       therefore the hypothesize PROMPT TEXT — two audits of the same  │
 │       bytes produced different prompts. A live fixture-replay hazard. │
 │                                                                       │
 │ entryPoints.install ← classify_install_hooks(scripts).targets  :313-314│
 │   only INSTALL_TIME_HOOKS, deduped, order-stable            :214-264  │
 │                                                                       │
 │ entryPoints.runtime  ← [main or "index.js"] + module? + every string  │
 │   leaf of the "exports" tree, recursing through dicts AND LISTS       │
 │   (_exports_entries :267-283), deduped by dict.fromkeys      :315-321 │
 │                                                                       │
 │ entryPoints.bin      ← "bin" as string, or every string value of the  │
 │   "bin" object                                               :286-293 │
 └───────────────────────────────────────────────────────────────────────┘
```

For the running example: `install=["setup.js"]` (from `preinstall: "node
setup.js"`), `runtime=["index.js"]` (from `main`), `bin=[]`.

**Two corrections to earlier revisions of this subsection, both of which the code
shared** — recorded because in each case doc and code held the *same* wrong belief,
which is why neither caught the other:

1. **It presented all five of `LIFECYCLE_SCRIPTS` as feeding
   `entryPoints.install`. Only the three install-time hooks do**, and the
   distinction is not cosmetic: **npm never runs `prepare`/`prepublish` for a
   registry tarball installed as a dependency**, and a registry tarball is the only
   artifact `resolve.py` fetches (§5). Treating them as install-time made the
   dealbreaker in §7.3 accuse **11 of 14 real published packages** — `whatwg-url`,
   `lru-cache@7`, `tr46`, the `@lezer/*` family, `@google/genai`,
   `whatwg-encoding` — of declaring code they did not ship, when the hook in
   question simply never runs. Split into `INSTALL_TIME_HOOKS` and
   `BUILD_TIME_HOOKS` in `10a288a`.
2. **`_exports_entries` did not do what its own docstring said.** Both it and this
   doc claimed "every string leaf of the `exports` tree (recursive)". The recursion
   stopped at **arrays**, and node's exports syntax allows an array of fallbacks
   (`"exports": {".": ["./new.js", "./old.js"]}`). Measured over 1317 installed
   manifests, **140 use an array fallback** — so this was a mainstream shape, not an
   exotic one, and every one of those runtime entry points was invisible to
   `trigger_targets`, which is the list an experiment picks its program from. Fixed:
   the recursion now descends `dict | list` (`inventory.py:280-282`).

The old extractor is worth naming precisely, because it is the subject of §24.0
item 7 and of the §7.3 rewrite below. It was:

```
 extract_script_file_ref("node setup.js")        ← REPLACED in 10a288a
   split on whitespace; require parts[0] == "node";
   return the first later part not starting with "-"
   ⇒ "setup.js"          (ANY non-`node` script yielded None)
```

`None` was then indistinguishable from "this hook does not exist", which is the
defect §7.3 now turns on.

`metadata.repository` is passed through **verbatim** (`inventory.py:310`) because
npm permits either a shorthand string or an object; the shared schema models it
as that real union rather than `unknown`, so consumers must branch instead of
rendering `[object Object]` (`shared/src/backend.ts:63-70`).

### 7.2 File classification

```
 classify_files(package_path)                        inventory.py:341-363
 for path in package_path.rglob("*"):
   skip if any path part ∈ SKIP_DIRS {node_modules, .git, .svn}   config.py:255
   skip non-files; skip on OSError
   is_binary, binary_type = _binary(path)      ← first 4 bytes  inventory.py:331-338
       ELF   \x7fELF
       MachO \xcf\xfa\xed\xfe   or   \xce\xfa\xed\xfe
       PE    MZ                                                      :55-60
   FileRecord(
     path        = POSIX path relative to the package root,
     fileType    = "binary" if is_binary else EXTENSION_TYPE_MAP.get(suffix,
                                                                "unknown"),
     sizeBytes   = st_size,
     permissions = octal mode, e.g. "644",
     isBinary, binaryType)
```

`EXTENSION_TYPE_MAP` (`inventory.py:36-54`) is the vocabulary the rest of the
pipeline filters on:

```
 .js .mjs .cjs .jsx → "js"    .ts .tsx .mts .cts → "ts"   ← SOURCE_FILE_TYPES
 .json → "json"   .md .txt → "doc"   .html .css → "web"
 .sh → "shell"    .map → "sourcemap"   .yml .yaml → "config"
 anything else → "unknown"      ← INCLUDING every EXTENSIONLESS file
```

`.jsx` and `.cts` were added in `10a288a`; before that they fell through to
`unknown` and were read by no model.

**The `unknown` arm is load-bearing and easy to miss: an extensionless file gets
`unknown`, so `flag_source_files` excludes it and no model ever reads it.** That
is not hypothetical — **13 of 94 real `bin` targets are extensionless**
(`typescript`, `rollup`, `esbuild`, `acorn`), so a *declared executable entry
point* reaches no model. Reported and not fixed, because the fix is a content
sniff rather than an extension lookup. It is the same shape as the
`install-coverage-gap` in §7.3: a file the audit will execute but never read.

`SOURCE_FILE_TYPES = frozenset({"js", "ts"})` (`config.py:254`). Only files of
those two types, and not binary, reach the FLAG pass. A `.sh` file, a `.wasm`
file, or an `unknown` extension is inventoried and may raise structural flags but
is **never read by the FLAG model**.

### 7.3 Structural checks — dealbreakers first, then flags

`run_inventory_checks(scripts, files)` returns `(flags, dealbreaker)` and returns
**early with `([], dealbreaker)`** on either dealbreaker
(`inventory.py:381-497`). Note the signature: `entry_points` is gone — the check
calls `classify_install_hooks` itself, because it needs the *gaps* as well as the
targets, and `EntryPoints` can only carry the targets.

```
 ┌─ DEALBREAKER 1: shell-pipe ───────────────────────── :399-403 ──────────┐
 │ for EVERY script (not just lifecycle hooks): does its value match any of │
 │   curl … | sh        curl … | bash                                      │
 │   wget … | sh        wget … | bash                                      │
 │   curl … |           ← broadest: curl piped into ANYTHING               │
 │   wget … -O … && (sh|bash|chmod)                              :61-68    │
 │ → DealBreaker(check="shell-pipe",                                       │
 │               detail="Script '{key}' contains shell pipe: {value}")      │
 │ ◀── THIS ALTERNATION IS NOT SOUND, and cannot be made sound: it must be │
 │     COMPLETE to catch fetch-and-execute, and 11 of 12 real shapes evade │
 │     it — `curl -o f url && sh f`, Homebrew's `sh -c "$(curl …)"`,       │
 │     `wget … | node -`, base64 pipelines. It is kept and still pinned,   │
 │     but soundness no longer rests on it: all 12 shapes now land as a    │
 │     dealbreaker or a GAP through target resolution below.               │
 └─────────────────────────────────────────────────────────────────────────┘
 ┌─ DEALBREAKER 2: missing-install-script ───────────── :407-416 ──────────┐
 │ classify_install_hooks(scripts) → (targets, gaps)             :214-264  │
 │ for each TARGET: can _resolve() find a shipped file?          :366-378  │
 │   exact path, else — for a node-resolution target — reference + one of  │
 │   .js .json .node .mjs .cjs, else reference/ + package.json|index.*    │
 │   (node's own CommonJS resolution, verified by execution)     :107-115  │
 │ → DealBreaker(check="missing-install-script",                           │
 │     detail="Install script '{hook}' references '{ref}' but file not     │
 │             found in package")                                          │
 │ ◀── INTERPRETER-AGNOSTIC. `./install.sh` via its shebang counts. The    │
 │     interpreter was never the load-bearing part; the missing FILE is.   │
 └─────────────────────────────────────────────────────────────────────────┘
```

**The justification this section used to give for DEALBREAKER 2 was false, and it
is the clearest case in this document of doc and code sharing one wrong premise.**
It said: *"the manifest declares that `npm install` will execute it."* That is
false for `prepare` and `prepublish`, which npm **never** runs for a registry
tarball installed as a dependency — and a registry tarball is the only artifact
`resolve.py` fetches. Measured over the 1360 manifests on this machine (236 with a
lifecycle hook), the check was calling **14 real, heavily-installed published
packages DANGEROUS**: a **~6% false-DANGEROUS rate on hooked packages**. The honest
justification, now at `inventory.py:386-397`, is narrower and survives: *the
manifest declares code it did not ship, so what runs will be resolved at install
time from wherever it then exists.*

The same narrow recogniser caused the hole in §24.0 item 7 **and** those false
positives — one root cause, failing in **both directions**. That is why widening
the interpreter list alone would have been the wrong fix: it would have multiplied
an unmeasured false-positive problem.

**The gap that is now unrepresentable.** `entryPoints.install == []` used to denote
two *opposite* facts — "nothing runs at install time" and "something runs and we
could not see what" — and `run_inventory_checks` read them identically. Every
command in every install-time hook now lands in exactly one of `targets` or `gaps`
(`inventory.py:219-231`), and neither can look like "no hook".

**The soundness property worth internalising:** `SCRIPT_INTERPRETERS`
(`inventory.py:77-95`) is **not** a soundness boundary. An unlisted interpreter, an
unlexable value, a computed path — every failure to understand a command degrades
to a **GAP**, never to clean. Recognising more shapes converts a gap into a precise
answer; it can never convert a gap into clean. That is the structural difference
from `SHELL_PIPE_PATTERNS` above, which has to be complete to be sound.

Otherwise, five families of advisory flag are accumulated:

| Check | Severity | Condition | Source |
|---|---|---|---|
| `lifecycle-scripts` | `info` | any of `preinstall/install/postinstall/prepare/prepublish` present; detail lists them | `inventory.py:420-429` |
| `install-coverage-gap` | **`critical`** | an install-time hook whose executed code cannot be located (`node-gyp rebuild`, `node -e "…"`, `sh -c "$(curl …)"`), **or** whose located target ships as a file type FLAG does not read (a shipped `postinstall.sh` is `shell`, so no model reads it) | `inventory.py:430-441` (unlocatable), `:442-463` (located but unread) |
| `binary-detected` | `warn` | `file.isBinary`; detail names the magic type | `inventory.py:464-472` |
| `executable-outside-bin` | `warn` | `mode & 0o111` and path does not start `bin/` or `bin\` | `inventory.py:474-482` |
| `hidden-dotfile` | `info` | basename starts `.` and is not in `STANDARD_DOTFILES` `{.npmignore, .gitignore, .browserslistrc, .editorconfig}` nor prefixed `.eslintrc`/`.prettierrc`/`.babelrc` | `inventory.py:484-496`, `:69-70` |

**`non-node-script` (`warn`) was deleted in `10a288a`**, and the reason is worth
keeping: it measured nothing useful in either direction. `node -e "…"` **passed**
it while being wholly unanalysable, and `sh ./ships.sh` **failed** it while being
fully resolvable. The replacement, `install-coverage-gap`, is `critical` rather
than `warn` because it names a coverage gap that must not reach `SAFE` — one check
name for both gap kinds, so a consumer asking "can this audit still reach SAFE"
branches on one closed fact instead of a list that grows with each new gap kind.

Two things this leaves open, both reported rather than fixed. A legitimate hook
that *ships* its file still does not get a clean bill if FLAG cannot read that
file — that is the second `install-coverage-gap` arm, and calling it "resolved"
would be the very defect class under audit. And the other half of the rule —
**refusing `SAFE` while a gap exists** — is an unapplied `pipeline.py` patch, whose
measured blast radius is 5 of 236 hooked packages (~0.4% of all manifests), each a
native addon or inline install code, and skipped when a hypothesis CONFIRMED so a
DANGEROUS-by-evidence verdict is never lost to it.

**Running example, exact result:**

```
 dealbreaker = None
   · no script contains a shell pipe ("node setup.js" does not match)
   · classify_install_hooks → targets=[("preinstall","setup.js",node)], gaps=[]
   · _resolve("setup.js") → "setup.js" IS in files ✓
 flags = [ InventoryFlag(severity="info", check="lifecycle-scripts",
             detail="Package declares lifecycle hooks: preinstall",
             file=None) ]
   · install-coverage-gap: none — the hook resolves to setup.js, and
     setup.js classifies as "js" ∈ SOURCE_FILE_TYPES, so FLAG does read it
   · binary-detected: none of the three files has a magic prefix
   · executable-outside-bin: 0o644 & 0o111 == 0 → no flag
   · hidden-dotfile: no dotfiles
```

Note `file=None` on that flag. That matters immediately: the FLAG phase builds a
per-file fact map keyed on `flag.file` and skips flags with no file
(`phases.py:443-446`), so this particular flag reaches **no** file's prompt. The
`preinstall` hook's significance is instead conveyed to the model through
`entryPoints.install`, which is threaded into the hypothesise prompt
(`phases.py:611`), not the flag prompt.

---

<a name="8-phase-timing"></a>
## 8. Phase timing, timeouts, and the timeout scale

Every LLM-bearing or filesystem-bearing phase goes through one wrapper:

```
 _timed_phase(name, operation, timeout_ms, input_summary,
              output_summary, emitter) → (T, PhaseLog)   pipeline.py:65-86
 ┌──────────────────────────────────────────────────────────────────────┐
 │ emit phase_started {phase: name}                                      │
 │ started = time.monotonic()                                            │
 │ try:                                                                  │
 │     async with asyncio.timeout(timeout_ms / 1000):                    │
 │         result = await operation()                                    │
 │ except TimeoutError as exc:                                           │
 │     raise AuditTimeoutError(name, int(timeout_ms)) from exc           │
 │         ← NPMGUARD-0030, HTTP 504, retryable=True                     │
 │ duration = round((monotonic() - started) * 1000)                      │
 │ emit phase_completed {phase: name, durationMs: duration}              │
 │ return result, PhaseLog(phase, durationMs, input_summary,             │
 │                         output_summary(result))                       │
 └──────────────────────────────────────────────────────────────────────┘
```

`PhaseLog` (`shared/src/backend.ts:7-13`) is `{phase, durationMs, input, output}`
and the list of them becomes `AuditReport.trace`. The `output_summary` callback
is what decides how much of a phase's result is preserved in the report — and one
of those summaries is load-bearing far downstream: the inventory phase's output
embeds `metadata`, which is how `report_store.extract_report_version` later
recovers the concrete version to file the report under (§21).

### 8.1 The timeout table

| Phase | Budget | Wrapped by `_timed_phase`? | Cite |
|---|---|---|---|
| `resolve` | 240 000 ms | yes | `pipeline.py:163-170` |
| (dependencies) | none — internal 180 000 ms wall | **no** | `pipeline.py:207`, `deps.py:16` |
| `inventory` | 60 000 ms | yes | `pipeline.py:228-248` |
| `intent-extraction` | 120 000 ms | yes | `pipeline.py:310-320` |
| `flag` | 600 000 ms × `timeout_scale` | yes | `pipeline.py:332-345` |
| `hypothesize` | 1 200 000 ms × `timeout_scale` | yes | `pipeline.py:355-382` |
| `orchestrator` | 2 400 000 ms × `timeout_scale`, as an **internal budget** | **no** | `pipeline.py:409-426`, `orchestrator.py:167` |

The orchestrator is timed and emits `phase_started`/`phase_completed` manually
(`pipeline.py:409, 376-380`) but is **not** wrapped in `asyncio.timeout`. Its
budget is checked *between* hypotheses, and exhausting it does not raise — it
DEFERS every remaining `OPEN` node (`orchestrator.py:167-177`). This is a
meaningful difference: an over-budget `flag` phase kills the audit with
`NPMGUARD-0030`; an over-budget orchestrator produces deferrals, which then
(usually) become `NPMGUARD-0031` at `pipeline.py:437-445`.

### 8.2 `timeout_scale`

```
 sources = flag_source_files(inventory)      ← the ONE definition, phases.py
 source_kb = sum(f.sizeBytes for f in sources) / 1024
 timeout_scale = max(
     min(4, 1 + max(0, len(sources) - 20) * 0.025),   ← +2.5% per file over 20
     min(4, 1 + max(0, source_kb - 200) / 500),       ← +1 per 500 KB over 200
 )                                                    pipeline.py:268-273
```

Both terms are clamped at 4, so the scale is always in `[1.0, 4.0]`. It grows
with *either* file count or total source size, whichever demands more.

For the running example: `sources` = `index.js` + `setup.js` (`package.json` is
`fileType == "json"`, excluded). `len(sources) = 2`, `source_kb = 3599/1024 =
3.51`. Both terms evaluate to `1.0`, so `timeout_scale = 1.0` and the budgets are
600 s / 1200 s / 2400 s exactly.

**This `sources` list IS the list FLAG analyses, and that is a fix rather than a
coincidence.** An earlier revision of this subsection said the opposite, correctly:
the pipeline kept its own `fileType in SOURCE_FILE_TYPES and not isBinary` copy while
the noise filter lived only in `run_flag`, so a package that was 90% tests got a
budget scaled for files nobody would open. Since `95cfb38` there is one function —
`phases.flag_source_files` (`phases.py:416-431`) — and both the fan-out
(`phases.py:442`) and this scaling read it, so the two cannot denote different sets.
Measured on the corpus: the unfiltered list bought **2.05×** budget where the real set
needs **1.025×**. Fixed; see §24.4.

The same list is now also the subject of `max_source_files`, which raises
`PackageTooLargeError` a few lines below this scaling (`pipeline.py:325-328`) — so the
number an operator sets is the worst-case FLAG call count rather than an approximation
of it. See §24.18.

---

<a name="9-the-dealbreaker-path"></a>
## 9. The dealbreaker path — a verdict with zero hypotheses

If `inventory.dealbreaker` is non-`None`, the pipeline builds a report **by
hand** and returns immediately:

```
 pipeline.py:275-288
 ┌───────────────────────────────────────────────────────────────────────┐
 │ if inventory.dealbreaker:                                             │
 │     report = AuditReport(                                             │
 │         schemaVersion   = 2,                                          │
 │         verdict         = "DANGEROUS",          ◀── HARDCODED         │
 │         rationale       = f"Dealbreaker: {check} — {detail}",          │
 │         counts          = EMPTY_COUNTS,   # all six fields 0  :41      │
 │         confirmedHypIds = [],                                         │
 │         hypotheses      = [],             ◀── ZERO                    │
 │         fileSummaries   = [],             ◀── ZERO (FLAG never ran)   │
 │         dealbreaker     = inventory.dealbreaker,                      │
 │         trace           = trace)          # resolve + inventory only  │
 │     log.write("report.json", report)                                  │
 │     return AuditResult(report, resolved.path, resolved)               │
 └───────────────────────────────────────────────────────────────────────┘
```

### Why zero hypotheses, precisely

Two independent reasons, and both are needed to understand the design:

**1. Sequencing.** The dealbreaker test sits at `pipeline.py:275`, *before*
`intent-extraction` (`:264`), *before* `flag` (`:286`), *before* `hypothesize`
(`:309`). No hypothesis has been created because no phase that creates
hypotheses has run. `fileSummaries` is empty for the same reason. The `trace`
therefore contains exactly two `PhaseLog` entries.

**2. It would be impossible to express otherwise.** The normal verdict function
`derive_graph_verdict` (`graph.py:295-331`) can **only** return `DANGEROUS` when
`counts.confirmed >= 1`, and a `CONFIRMED` node can only exist if a sandbox run
produced an `EvidenceRef` that a judge cited (`graph.py:215-217`). A dealbreaker
is a *static* determination — no sandbox ran, no evidence exists. So a dealbreaker
cannot be routed through the graph; it must bypass `_report`/`derive_graph_verdict`
entirely. That is exactly what `pipeline.py:276-286` does: it constructs
`AuditReport` directly.

This is why `AuditReport.dealbreaker` exists as a distinct field
(`shared/src/backend.ts:29`) alongside `hypotheses` and `confirmedHypIds`. A
consumer rendering an audit must handle two shapes of `DANGEROUS`:

```
 ┌─ DANGEROUS, kind 1: dealbreaker ─────┐   ┌─ DANGEROUS, kind 2: confirmed ──┐
 │ dealbreaker     = {check, detail}     │   │ dealbreaker     = null           │
 │ hypotheses      = []                  │   │ hypotheses      = [ … 14 … ]     │
 │ confirmedHypIds = []                  │   │ confirmedHypIds = ["hyp-0008"]   │
 │ counts          = all zeros           │   │ counts.confirmed = 1             │
 │ rationale       = "Dealbreaker: …"    │   │ rationale = "1 confirmed hypo…"  │
 │ trace           = 2 phases            │   │ trace     = 6 phases             │
 │ EVIDENCE: the manifest itself         │   │ EVIDENCE: a sealed RunArtifact   │
 └───────────────────────────────────────┘   └──────────────────────────────────┘
```

A consumer that reads only `confirmedHypIds` to decide "is this bad" will call a
dealbreaker package clean. The field to branch on is `verdict`.

Note also that in the dealbreaker path the pipeline returns *successfully*, so
`AuditService._execute` proceeds to `save_report` — and `save_report` needs a
concrete version. It gets one, because `extract_report_version`
(`report_store.py:104-111`) reads it out of the `inventory` phase's `PhaseLog`
output, which is present in this two-entry trace.

---

<a name="10-intent"></a>
## 10. `intent` — establishing the benign baseline

`engine/npmguard/phases.py:371-396`. This is the first LLM call. Its job is to
answer: *what does this package claim to be for?*

The reason this comes first is the reason the whole system works. "Reads
`process.env`" is not evidence of anything. "Reads `process.env` **in a
terminal-colour library**" is. Every downstream prompt is given this baseline so
the model can reason about *deviation from purpose* rather than absolute
suspiciousness.

```
┌─ PackageIntent ──────────────────────────────── phases.py:74-84 ──────────┐
│ statedPurpose        : str                                                │
│ expectedCapabilities : list[str]  (max_length=12)   ◀── FREE-FORM STRINGS │
│ rationale            : str                                                │
│ degraded             : SkipJsonSchema[bool] = False ◀── OFF-WIRE MARKER   │
│ model_config = ConfigDict(extra="forbid")                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

`degraded` is wrapped in `SkipJsonSchema`, which keeps it out of the JSON schema
sent to the model — the model cannot set it. Only `fallback_intent` sets it
`True` (`phases.py:361-368`). The invariant at `phases.py:392-396`:

> **intent is either LLM-validated or explicitly `degraded=True`.**

### 10.1 The real call

```
 IN — prompt built at phases.py:377-381 (dependencies list from
      inventory.dependencies["prod"], README via find_readme)
 ┌───────────────────────────────────────────────────────────────────────┐
 │ SYSTEM  (engine/prompts/intent/v1.md)                                 │
 │ You infer an npm package's stated intent from its manifest and README. │
 │ Be conservative about expected capabilities. Pick only capabilities a  │
 │ direct, legitimate implementation needs. Never infer intent from       │
 │ source code. Ignore marketing language and describe the package's      │
 │ functional claim.                                                     │
 │                                                                       │
 │ USER                                                                  │
 │ ## Package manifest                                                   │
 │ - name: test-pkg-env-exfil                                            │
 │ - version: 2.0.1                                                      │
 │ - description: Smart configuration loader with environment detection   │
 │ - license: MIT                                                        │
 │ - homepage: (none)                                                    │
 │ - keywords: config, env, loader, dotenv                               │
 │                                                                       │
 │ ## Runtime dependencies                                               │
 │ (none)                                                                │
 │                                                                       │
 │ ## Declared bin entries                                               │
 │ (none)                                                                │
 │                                                                       │
 │ ## README                                                             │
 │ (no README found)                                                     │
 │                                                                       │
 │ ## Task                                                               │
 │ Infer statedPurpose, a conservative expectedCapabilities list, and     │
 │ rationale.                                                            │
 └───────────────────────────────────────────────────────────────────────┘
    source: exchanges/001_intent_ea097cd1.json   model deepseek-v4-flash
                                     │
                                     ▼
 OUT — the model's actual reply, verbatim
 ┌───────────────────────────────────────────────────────────────────────┐
 │ {                                                                     │
 │   "statedPurpose": "Smart configuration loader with environment        │
 │                     detection",                                       │
 │   "expectedCapabilities": [                                           │
 │     "load configuration files",          ◀── NOT CapabilityEnum       │
 │     "detect environment variables",          values — plain English   │
 │     "parse .env files"                                                │
 │   ],                                                                  │
 │   "rationale": "The package name, description, and keywords indicate   │
 │     it is a configuration loader … without any network access or file  │
 │     system operations beyond reading configuration files."             │
 │ }                                                                     │
 │ degraded = False  (validated)                                         │
 └───────────────────────────────────────────────────────────────────────┘
```

**Note the type asymmetry, because it explains how FLAG really works.**
`PackageIntent.expectedCapabilities` is `list[str]` with no enum constraint
(`phases.py:78`). But `FileFlagResponse.capabilities` is
`list[Capability]` — a closed 21-value enum (`phases.py:31-54, 168`). So no code
ever compares "expected" against "observed" capabilities: the units do not even
match. The "is this beyond intent?" judgement is made **entirely inside the
model**, by putting the English purpose text and the enum instruction in the
same prompt. There is no capability-matching table anywhere in the engine, and
the design spec says that is deliberate: "no hand-coded taxonomy, per-category
strategy tables"
(`docs/specs/2026-07-10-triage-hypothesis-redesign.md:5-7`).

### 10.2 `find_readme` and the degraded fallback

```
 find_readme(package_path, inventory)                    phases.py:344-358
   docs = {f.path for f in inventory.files
           if f.fileType == "doc" and not f.isBinary}
   try in order: README.md README.MD Readme.md readme.md README
                 README.markdown README.txt              :321-329
   read as utf-8; on OSError, try the next candidate
   if len > 16_000: content[:16_000] +
       "\n\n[... truncated, original was {n} bytes ...]"
   else → None
```

```
 extract_intent error handling                           phases.py:382-396
   try:  llm.run("intent", …, context=("audit", audit_id))
         return PackageIntent.model_validate(result.output)
   except (EndOfRope, OutputInvalid):
         return fallback_intent(inventory)
```

Only two exception classes fall back, and the choice is precise
(`phases.py:391-396`): `EndOfRope` (the provider chain is exhausted) and
`OutputInvalid` (no candidate survived validation) are *retryable provider*
failures. `BudgetExhausted` (the 24-hour spend cap), `CancelledError`, and plain
code bugs all **propagate** and kill the audit. The comment calls this "the same
budget-terminal discipline as the hypothesize phases."

The fallback itself (`phases.py:361-368`) is careful not to invent anything:

```
 statedPurpose        = package.json description, stripped
                        or "(no stated purpose — package omitted description
                            and README)"
 expectedCapabilities = []          ◀── EMPTY, so EVERYTHING is beyond intent
 rationale            = "No LLM-derived intent available; downstream analysis
                         must treat any capability as potentially surprising."
 degraded             = True
```

An empty `expectedCapabilities` biases FLAG toward over-flagging, which is the
safe direction: over-flagging costs compute, under-flagging costs a false `SAFE`.

---

<a name="11-flag"></a>
## 11. `flag` — the cheap, high-recall pass

`engine/npmguard/phases.py:434-560`. One model call per source file, run
concurrently. The model is the *triage* tier (cheap/fast). Its job is **recall,
not precision**: point at anything worth investigating and never decide malice.

```
 engine/prompts/flag/v1.md — the entire system prompt
 ┌───────────────────────────────────────────────────────────────────────┐
 │ You are a high-recall security triage pass over one npm package        │
 │ source file.                                                          │
 │                                                                       │
 │ Flag anything beyond the stated purpose or intrinsically suspicious:   │
 │ encoded or encrypted strings, dynamic code, hidden URLs or shell       │
 │ commands, anti-debugging, and time, geography, CI, inspector, or       │
 │ Docker gates. Over-flagging is expected.                              │
 │ Do not decide malice. Return zero flags only for genuinely boring code.│
 └───────────────────────────────────────────────────────────────────────┘
```

Two lenses, exactly as the design spec's "FLAG dual lens" decision
(`docs/specs/2026-07-10-triage-hypothesis-redesign.md:116`): (a) **beyond
intent**, and (b) **intrinsically suspicious regardless of intent** —
specifically including *gates*, because a time-gate or CI-gate is how a payload
hides from analysis.

### 11.1 File selection and the fan-out

```
 source_files = [f for f in inventory.files
                 if f.fileType in SOURCE_FILE_TYPES   # {"js","ts"}
                 and not f.isBinary
                 and not noise(f.path)]                phases.py:407-411

 noise(path) is True when:                             phases.py:400-405
   path.endswith(".d.ts")                       ← type declarations only
   or re.search(r"(^|/)(test|tests|__tests__|__mocks__)/", path)
   or re.search(r"\.(test|spec)\.(js|ts|mjs|cjs|tsx|mts)$", path)

 facts: dict[file → list[str]] built from inventory.flags that HAVE a file:
   f"[{flag.severity}] {flag.check}: {flag.detail}"     phases.py:443-446

 semaphore = Semaphore(NPMGUARD_TRIAGE_CONCURRENCY, default 8)    :448
 responses = [None] * len(source_files)   ← index-aligned, order preserved :447
 await _gather_fail_fast(analyze(i) for i in range(len(source_files)))  :551
```

`_gather_fail_fast` (`phases.py:303-318`) is a small but important utility.
`asyncio.gather` propagates the first exception but leaves the siblings running.
For a fan-out of paid model calls that turns one deterministic contract failure
into N billed calls. So this version creates tasks, gathers, and on **any**
`BaseException` cancels every unfinished task, re-gathers with
`return_exceptions=True`, and re-raises.

`chalk` illustrates the filter: 12 files → 5 analysed. `readme.md` (`doc`),
`license` (`unknown`), `package.json` (`json`), and four `.d.ts` files are all
excluded, leaving `source/utilities.js`, `source/index.js`,
`source/vendor/ansi-styles/index.js`, `source/vendor/supports-color/index.js`,
`source/vendor/supports-color/browser.js` — and the demo recording shows exactly
5 `file_analyzing` and 5 `triage_progress` frames.

### 11.2 The three per-file branches

```
 analyze(index)                                        phases.py:452-549
 ┌──────────────────────────────────────────────────────────────────────┐
 │ contents = _safe_file(package_path, file.path).read_text("utf-8")     │
 │   _safe_file resolves and requires the result stay under the package  │
 │   root, else AuditIncompleteError("flag", "file escapes package        │
 │   root: …")                                          phases.py:399-403│
 │   OSError → AuditIncompleteError("flag", "could not analyze {path}:    │
 │             file-unreadable")                                  :458-461│
 │                                                                       │
 │ ┌─ BRANCH A: len(contents) > 500_000 ──────────────────── :462-473 ──┐ │
 │ │ NO model call. Synthesise a response that keeps the file in scope: │ │
 │ │   summary = "File is {kb}KB — too large for the FLAG read"         │ │
 │ │   capabilities = []                                                │ │
 │ │   flags = [FlagDraft(lines=["1-1"], why="File {path} is {kb}KB —   │ │
 │ │            too large to read statically; needs a dynamic run to    │ │
 │ │            inspect.")]                                             │ │
 │ │ ◀── ONE flag, so the file still becomes a hypothesis and still gets│ │
 │ │     RUN. An unreadable file is never silently cleared.             │ │
 │ └────────────────────────────────────────────────────────────────────┘ │
 │ ┌─ BRANCH B: not contents.strip() ─────────────────────── :474-475 ──┐ │
 │ │ NO model call. FileFlagResponse(summary="Empty file",              │ │
 │ │   capabilities=[], flags=[])   ← genuinely nothing to test         │ │
 │ └────────────────────────────────────────────────────────────────────┘ │
 │ ┌─ BRANCH C: the normal path ───────────────────────────── :477-541 ─┐ │
 │ │ emit file_analyzing {file}                                         │ │
 │ │ prompt = intent block + "## File: {path}" + numbered source        │ │
 │ │          (+ "## Structural facts" if facts[path]) + task text      │ │
 │ │ llm.run("flag", …, validate=validate_response)                     │ │
 │ │ ANY exception → AuditIncompleteError("flag", "could not analyze     │ │
 │ │   {path}: model call failed: {exc}")               :538-541         │ │
 │ └────────────────────────────────────────────────────────────────────┘ │
 │                                                                       │
 │ responses[index] = (file.path, response)                              │
 │ async with lock: complete += 1                                        │
 │   emit triage_progress {current, total, file}          :543-549        │
 └──────────────────────────────────────────────────────────────────────┘
```

`number_lines` (`phases.py:299-300`) prefixes every line with `1: `, `2: `, …
The whole flag contract is expressed in those numbers, so the model must be able
to see them.

The task text appended to every prompt (`phases.py:482-487`) is the precision
counterweight to a high-recall instruction:

```
 Return a compact summary, only security capabilities from the supplied enum,
 and at most 8 highest-signal thin flags with compact exact ranges such as
 12-18. Do not flag ordinary logging, feature detection, regular expressions,
 encoding, or environment access when it is intrinsic to the stated purpose
 and does not handle secrets or evade analysis.
```

### 11.3 The output contract, and the three layers of repair around it

```
┌─ FileFlagResponse ─────────────────────────── phases.py:165-201 ──────────┐
│ summary      : str                                                        │
│ capabilities : list[Capability]     ← the 21-value enum, phases.py:31-54  │
│ flags        : list[FlagDraft]      ← max_length=8                        │
└───────────────────────────────────────────────────────────────────────────┘
┌─ FlagDraft ────────────────────────────────── phases.py:86-162 ───────────┐
│ lines : list[str]  min_length=1 max_length=12                             │
│         "Compact 1-based line ranges only (for example 12-18), never      │
│          copied source text."                                             │
│ why   : str                                                               │
└───────────────────────────────────────────────────────────────────────────┘
```

Models routinely miss this shape slightly. Rather than weakening the schema, the
near-misses are normalised **at the LLM boundary** so everything downstream sees
one canonical form. Three layers, in order:

```
 LAYER 1 — key renaming (FlagDraft.normalize_provider_shape)   :96-131
   lines ← lineRanges | line_range | f"{start_line}-{end_line or start_line}"
   why   ← description | reason | flag
   then every alias key is popped so extra="forbid" still holds.
   Rationale (:99-105): providers get the JSON schema but some models still
   rename fields; keeping this at the boundary "lets Kit validate and capture
   a typed result without weakening the report schema downstream."

 LAYER 2 — value coercion (FlagDraft.normalize_lines)          :133-162
   42            → "42-42"          (int)
   [42, 58]      → "42-58"          (2-int list/tuple)
   " 42 - 58 "   → "42-58"          (regex-normalised whitespace)
   "42"          → "42-42"
   "42: const x" → "42-42"          (leading number then colon)
   anything else → kept as the stripped string  (Layer 3 handles it)
   a non-list/str/int item → ValueError("invalid line range …")

 LAYER 3 — semantic validation (run_flag.validate_response)    :489-527
   for each draft, for each line value:
     if it matches ^(\d+)-(\d+)$:
         require 1 <= start <= end <= line_count,
         else CandidateRejected("line range '…' is outside 1-{n}")
     else:  treat it as SOURCE TEXT and find it —
         exact match on a stripped line, else substring match
         no match → CandidateRejected("line value '…' is neither a range
                    nor source text from the file")
         match    → canonical "{i}-{i}" for the FIRST hit only
     draft.lines = dict.fromkeys(canonical)   ← dedupe, order preserved
   THEN the coherence guard:
     if not candidate.flags and any(CRITICAL_SUMMARY pattern matches summary):
         CandidateRejected("summary describes credential theft or
                            exfiltration but flags is empty")
```

`CandidateRejected` is a Kit signal, not a fatal error: it rejects *this*
candidate and lets the client retry or move down the provider chain. Only
exhaustion becomes `AuditIncompleteError`.

The coherence guard is the code embodiment of a principle from the earlier spec
(`docs/specs/2026-07-08-evidence-timeline-judge.md:189-195`):

> **suspicious ⟹ a hypothesis exists.** A response whose `summary` describes a
> risk but carries zero hypotheses is an *incoherent* state — there is nothing to
> check — so it is neither trusted as "no finding" nor fabricated into one: it is
> flagged as an error.

`CRITICAL_SUMMARY` (`phases.py:330-341`) is four case-insensitive patterns:
`credential(s) (theft|stealer|harvesting|exfiltration)`; `(steal|harvest|
exfiltrate)` near `(credentials|secrets|tokens|keys|env|npm|aws|ssh|kube|docker|
metadata|imds)`; `(ssh keys|aws credentials|npm tokens|github tokens|cloud
metadata|imds)`; `(malware|trojan|supply chain attack)`.

There is also a bounded-response normaliser on the container
(`FileFlagResponse.normalize_bounded_response`, `phases.py:172-201`): a
`capabilities` **dict** like `{"NETWORK": true, "EVAL": false}` is converted to
the list of truthy keys; any value not in `CAPABILITY_VALUES` is dropped; the
list is truncated to 12 and `flags` to 8.

### 11.4 The real FLAG output for `setup.js`

From `exchanges/003_flag_24133fb1.json`, verbatim model reply (reformatted;
`lines` shown post-normalisation):

```
┌─ INPUT ────────────────────────┐   ┌─ OUTPUT: FileFlagResponse ───────────┐
│ ## Package intent              │   │ summary: "The file setup.js contains │
│ statedPurpose: Smart config…   │   │  extensive exfiltration logic that is │
│ expectedCapabilities: load     │   │  completely outside its stated        │
│  configuration files, detect   │──▶│  purpose … Even though the exfil URL  │
│  environment variables, parse  │   │  points to localhost and a            │
│  .env files                    │   │  SAFE_TEST_MODE flag is set, the code │
│ rationale: …                   │   │  structure is that of a credential-   │
│                                │   │  stealing implant…"                  │
│ ## File: setup.js              │   │                                       │
│ ```                            │   │ capabilities: [DATA_EXFILTRATION,     │
│ 1: const http = require("http")│   │   ENV_VARS, FILESYSTEM, NETWORK,      │
│ …                              │   │   OBFUSCATION, PROCESS_SPAWN,         │
│ 123:  exfiltrate(stolen);      │   │   FILESYSTEM, NETWORK]                │
│ ```                            │   │   ⚠ FILESYSTEM and NETWORK appear     │
│                                │   │     TWICE — not deduped (§24.5)       │
│ (no "## Structural facts" —    │   │                                       │
│  the only inventory flag has   │   │ flags: 8                              │
│  file=None)                    │   └───────────────────────────────────────┘
└────────────────────────────────┘
```

The eight flags, in order — this list is the input to the entire rest of the
audit:

| # | lines | why |
|---|---|---|
| 1 | 8, 9 | Hardcoded exfiltration URL and IMDS probe URL — clearly malicious for remote data theft. |
| 2 | 11, 30 | Targeted list of secret environment variables (tokens, cloud keys, CI tokens) for harvesting. |
| 3 | 32, 46 | `harvestEnv()` scans and copies all env vars matching token/secret patterns — credential theft. |
| 4 | 48, 72 | `readCredentialFiles()` reads sensitive private key files, cloud configs, Docker, and Kubernetes credentials. |
| 5 | 74, 82 | `probeIMDS()` queries cloud metadata service (169.254.169.254) to steal instance identity and credentials. |
| 6 | 84, 106 | `exfiltrate()` sends collected secrets over HTTP POST to the exfiltration server — actual data theft. |
| 7 | 108, 118 | Immediately collects hostname, username, env secrets, files, and IMDS placeholder on module load. |
| 8 | **120, 123** | **Probes IMDS asynchronously and exfiltrates all stolen data — auto-execution on require/import.** |

Flag #8 is the one to follow: it becomes `hyp-0008`, the only hypothesis that
will be `CONFIRMED`, and therefore the sole reason the verdict is `DANGEROUS`.

And for `index.js` (`exchanges/002_flag_b87cdf6b.json`) six flags, including
`lines:["1"]` — "`SAFE_TEST_MODE` boolean constant with no usage — could indicate
toggled behavior or anti-debug". That is lens (b) firing: intrinsically odd shape,
independent of intent. It later becomes `hyp-0009` and is refuted.

### 11.5 Assembling `FlagOutput`

```
 phases.py:552-560
 flags, summaries = [], []
 for item in responses:
     assert item is not None      ← _gather_fail_fast returned, so every slot
                                    is filled: no silently dropped file
     file, response = item
     summaries.append(FileSummary(file=file, summary=response.summary,
                                  capabilities=response.capabilities))
     flags.extend(Flag(file=file, lines=draft.lines, why=draft.why)
                  for draft in response.flags)
 return FlagOutput(flags=flags, fileSummaries=summaries)
```

`Flag` (`phases.py:212-216`) is the flat, file-tagged unit: `{file, lines[],
why}`. For the running example: 8 (`setup.js`) + 6 (`index.js`) = **14 flags**,
2 `FileSummary` rows. The `setup.js` entries come first because `source_files`
order comes from `inventory.files`, and that order is what determines hypothesis
numbering: `hyp-0001..hyp-0008` on `setup.js`, `hyp-0009..hyp-0014` on
`index.js`.

---

<a name="12-the-zero-flag-early-return"></a>
## 12. The zero-flag early return (the `chalk` path)

```
 pipeline.py:348-353
 ┌───────────────────────────────────────────────────────────────────────┐
 │ if not flagged.flags:                                                 │
 │     graph, _, _ = build_graph(audit_id, [])   ← an EMPTY graph        │
 │     await _emit_file_verdicts(flagged.fileSummaries, [], emitter)     │
 │     report = _report(graph, flagged.fileSummaries, trace)             │
 │     log.write("report.json", report)                                  │
 │     return AuditResult(report, resolved.path, resolved)               │
 └───────────────────────────────────────────────────────────────────────┘
```

Note what this early return does **not** do: it does not hardcode a verdict. It
builds an empty graph and calls the same `_report` → `derive_graph_verdict` path
every other audit uses. With `total=0`, `derive_graph_verdict` falls through both
assertions (nothing is open, nothing is deferred), sees `confirmed == 0`, and
picks the `total == 0` branch of the rationale (`graph.py:326-331`).

```
┌─ chalk@5.6.2, engine/demo-data/chalk.json ────────────────────────────────┐
│ 12 files → 5 analysed → 0 flags                                           │
│                                                                            │
│ report.verdict         = "SAFE"                                            │
│ report.rationale       = "No suspicions were raised."                      │
│ report.counts          = {total:0, open:0, inProgress:0,                    │
│                           confirmed:0, refuted:0, deferred:0}              │
│ report.confirmedHypIds = []                                                │
│ report.hypotheses      = []                                                │
│ report.fileSummaries   = 5 rows, capabilities: [] on each                  │
│ report.trace           = resolve, inventory, intent-extraction, flag        │
│                          ← FOUR phases. No hypothesize. No orchestrator.   │
│                                                                            │
│ emitted frames: audit_enqueued, audit_started, phase_started ×4,           │
│   phase_completed ×4, dependencies_provisioned, file_list, inventory_meta, │
│   intent_extracted, file_analyzing ×5, triage_progress ×5,                 │
│   file_verdict ×5, verdict_reached                                         │
│   ← NO hypothesis_emitted, NO graph_built, NO hypothesis_resolved          │
└────────────────────────────────────────────────────────────────────────────┘
```

Is that a violation of "SAFE must be backed by an attempt"? No — and the
distinction is precise. Invariant **V2** in the spec
(`docs/specs/2026-07-10-triage-hypothesis-redesign.md:88`) is `SAFE ⟺ the audit
ran a genuine triggering experiment and the judge found no malice`. Its test
list adds the boundary case explicitly: "zero flags → SAFE"
(`docs/specs/2026-07-10-triage-hypothesis-redesign.md:156`). The reading that
reconciles them: the obligation is *every raised suspicion must be run*. Zero
suspicions discharges that obligation vacuously. What is forbidden is raising a
suspicion and then clearing it without running it — which is why there is no code
path from a non-empty `flags` list to a report without a graph.

The contrasting `chalk` audit in the fixture bundle shows the non-vacuous form:
1 flag → 1 hypothesis → 1 sandbox run → judge says `malicious=false` → `REFUTED`
→ rationale `"All 1 suspicion ran and showed no malice."` Same verdict, different
rationale, different `counts`.

### 12.1 `_emit_file_verdicts` — a presentation projection

```
 _emit_file_verdicts(summaries, hypotheses, emitter)     pipeline.py:89-119
 ┌──────────────────────────────────────────────────────────────────────┐
 │ by_file: dict[file → [Hypothesis]]                                    │
 │   for h in hypotheses: for f in h.focusFiles or []: by_file[f] += [h]  │
 │                                                                       │
 │ for summary in summaries:                                             │
 │   nodes = by_file.get(summary.file, [])                               │
 │   severity = max((n.severity or "medium" for n in nodes),             │
 │                  key=SEVERITY_SCORE.__getitem__, default="low")       │
 │   lines = [l.range for n in nodes for l in n.focusLines or []         │
 │            if l.file == summary.file]                                 │
 │   emit file_verdict {verdict: FileVerdict(                            │
 │     file               = summary.file,                                │
 │     capabilities       = summary.capabilities or [],                  │
 │     suspiciousPatterns = [n.description for n in nodes],              │
 │     suspiciousLines    = ",".join(lines) or None,                     │
 │     summary            = summary.summary or "",                       │
 │     riskContribution   = SEVERITY_SCORE[severity] if nodes else 0)}   │
 └──────────────────────────────────────────────────────────────────────┘
 SEVERITY_SCORE = {"low":3, "medium":6, "high":8, "critical":10}  :42
```

This is called twice in the pipeline: once in the zero-flag path with an empty
hypothesis list (`pipeline.py:350`) and once after `hypothesize`
(`pipeline.py:385`). It is **display only** — nothing reads `FileVerdict` back
into the verdict logic. `suspiciousLines` is `null` for a clean file, which is
why `shared/src/models.ts:109-115` insists on `.nullable()` rather than
`.optional()`: `events.py` dumps payloads with `exclude_none=False`, so an
absent value arrives on the wire as an explicit JSON `null`, and
`z.string().optional()` would throw on it.

---

<a name="13-hypothesize"></a>
## 13. `hypothesize` — hypothesis, claim, experiment

`engine/npmguard/phases.py:749-799` (orchestration),
`phases.py:583-746` (one-shot generator), `engine/npmguard/hypothesis_agent.py`
(two-phase generator + fallback). This is where the system stops describing and
starts *designing an experiment*.

### 13.1 The three definitions, grounded in real data

Take flag #8 on `setup.js` and follow it. Here are the three terms, each defined
as a box you can point at.

```
╔═ A HYPOTHESIS = a testable claim about behaviour, plus the machine to test it ═╗
║  (contract: shared/src/graph.ts:83-104 · python: contract/models.py Hypothesis)║
║                                                                               ║
║  hypId       "hyp-0008"          ← f"hyp-{index+1:04d}" over the flat flag    ║
║                                    list; phases.py:765                        ║
║  description "Probe IMDS and exfiltrate all stolen data"                       ║
║  claim       { kind: "cred_theft", gating: "docker_gate" }   ← see below      ║
║  focusFiles  ["setup.js"]                                                     ║
║  focusLines  [{file:"setup.js", range:"120-120"},                             ║
║               {file:"setup.js", range:"123-123"}]                             ║
║  experiment  [ 4 ToolCalls ]      ← see below. THIS is the machine.           ║
║  severity    "critical"                                                       ║
║  parentHypId null      childHypIds []      ← recursion exists in the schema   ║
║                                              but no producer sets them today  ║
║  state       "OPEN"                                                           ║
║  createdBy   "hypothesize"                                                    ║
║  evidenceRefs []       ← empty at birth. Fills only from a real run.          ║
║  createdAt   "2026-07-23T10:07:05.130438Z"                                    ║
║  resolvedAt  null      resolution null                                        ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

```
╔═ A CLAIM = the label for WHAT KIND of badness, plus any gate that hides it ═══╗
║  (contract: shared/src/graph.ts:37-42)                                        ║
║                                                                               ║
║  kind ∈ 13 values          phases.py:55-69 / graph.ts:9-23                    ║
║    env_exfil  cred_theft  binary_drop  obfuscation  persistence  destructive  ║
║    propagation  dos_loop  clipboard_hijack  dom_inject  telemetry  dns_exfil  ║
║    build_plugin_exfil                                                         ║
║                                                                               ║
║  gating ∈ 5 values | null   phases.py:70 / graph.ts:27-33                      ║
║    time_gate  geo_gate  ci_gate  inspector_gate  docker_gate                  ║
║    ← "this payload only fires when it thinks it is NOT being watched"         ║
║                                                                               ║
║  ⚠ NOTHING IN THE ENGINE BRANCHES ON claim.kind. Verified: the only reads     ║
║    are prompt text (orchestrator.py:72) and event payloads (phases.py:784,    ║
║    pipeline.py:373,348, orchestrator.py:143). There is no dispatch table,     ║
║    no per-claim strategy, no per-claim confirmation predicate. The design      ║
║    doc's decision "claim.kind dies as control flow" holds in the code.        ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

```
╔═ AN EXPERIMENT = an ordered list of ToolCalls: N setup steps + exactly 1 ═════╗
║  trigger. It must COMPILE (experiments.compile_experiment) and it must LOAD   ║
║  (observation.dry_run_load) before the hypothesis is allowed to exist.        ║
║  (contract: shared/src/evidence.ts:108-113)                                   ║
║                                                                               ║
║  hyp-0008.experiment — verbatim from demo-data report + fixture hypotheses:   ║
║                                                                               ║
║  [0] { tool: "setEnv", args: { env: {                                          ║
║          "NPM_TOKEN":          "npm_12345secrettoken",   ← BAIT (canary)      ║
║          "AWS_ACCESS_KEY_ID":  "AKIA123456789",          ← BAIT              ║
║          "HOME":               "/home/node" }}}   ← so os.homedir() resolves  ║
║                                                     to where we plant files   ║
║  [1] { tool: "plantFiles", args: { files: [                                   ║
║          { path: "/home/node/.npmrc",                                         ║
║            content: "//registry.npmjs.org/:_authToken=npm_12345secrettoken" },║
║          { path: "/home/node/.ssh/id_rsa",                                    ║
║            content: "-----BEGIN RSA PRIVATE KEY-----\\nFAKEKEYDATA\\n…" },     ║
║          { path: "/home/node/.aws/credentials",                               ║
║            content: "[default]\\naws_access_key_id=AKIA123456789\\n…" } ]}}     ║
║        ← the exact three paths setup.js's readCredentialFiles() reads         ║
║  [2] { tool: "stubUrl", args: { stubs: [                                      ║
║          { pattern: "http://169.254.169.254/latest/meta-data/*",              ║
║            responseStatus: 200,                                               ║
║            responseBody: "ami-id: ami-123456\\ninstance-id: i-1234567890\\n    ║
║                           public-ip: 1.2.3.4",                                ║
║            responseHeaders: {"Content-Type":"text/plain"} },                   ║
║          { pattern: "http://localhost:9999/exfil", responseStatus: 200,       ║
║            responseBody: "ok",                                                ║
║            responseHeaders: {"Content-Type":"text/plain"} } ]}}                ║
║        ← WHY: probeIMDS() calls its callback with null on error, and the      ║
║          callback is what calls exfiltrate(). Without a working IMDS response ║
║          the exfil step might not be reached. The stub makes the FULL chain   ║
║          complete, and gives the pcap sensor a real host to record.           ║
║  [3] { tool: "trigger", args: { kind: "entrypoint", target: "setup.js",       ║
║                                 argv: [], stdin: null }}                       ║
║        ← EXACTLY ONE trigger. compile_experiment rejects zero or two.         ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

The shape of that experiment is the whole idea in miniature. `setup.js` reads
nine credential files; in a bare container all nine reads fail and the harvested
payload is empty, so a run would show "read attempts, nothing sent" — ambiguous.
The experiment removes the ambiguity by *making the theft succeed against fake
data*. That is what "designed to make the payload fire" means
(`docs/specs/2026-07-10-triage-hypothesis-redesign.md:43-44`).

### 13.2 The setup vocabulary offered to the model

```
 TOOL_CATALOG — injected verbatim into every hypothesise prompt
                                                    experiments.py:741-747
 ┌───────────────────────────────────────────────────────────────────────┐
 │ - setEnv (setup): Inject environment variables to plant credentials    │
 │   or defeat environment gates.                                        │
 │ - plantFiles (setup): Seed absolute-path files such as                 │
 │   /home/node/.npmrc with bait content.                                │
 │ - setDate (setup): Freeze wall-clock time at an ISO timestamp using    │
 │   libfaketime.                                                        │
 │ - stubUrl (setup): Return canned HTTP responses for URL patterns using │
 │   * as wildcard.                                                      │
 │ - patchFile (setup): Rewrite package files with exact string           │
 │   replacements before execution.                                      │
 │ - preload (setup): Inject a Node preload script before the package     │
 │   entrypoint loads.                                                   │
 │ - trigger (trigger): Invoke exactly one entrypoint, lifecycle hook,    │
 │   bin, or subpath.                                                    │
 └───────────────────────────────────────────────────────────────────────┘
```

Plus a hard-won piece of guidance appended to every prompt
(`experiments.py:749-760`):

```
 EXPERIMENT_CODE_GUIDANCE
 When you author JavaScript (a preload script, a custom driver, or a patchFile
 replacement), reference package files by a relative path with a leading './'
 (require('./src/x.js')) or by an absolute path under /pkg
 (require('/pkg/src/x.js')). A bare specifier like require('src/x.js') is
 resolved as a node_modules PACKAGE and fails with "Cannot find module".
 Planted file paths must be absolute (/pkg/... or /home/node/...). The sandbox
 working directory is /pkg.
```

The comment above it explains why this earns prompt space: "The most common way
a generated experiment fails to run is a `require()` written like a filesystem
path but resolved by Node as a package… Runtime deps are installed before
hypothesize, so this is the remaining self-inflicted load failure."

And `trigger_targets` (`phases.py:563-566`) computes the allow-list of things the
model may trigger:

```
 dict.fromkeys([*runtime, *install, *bin, flag.file])
 for hyp-0008: ["index.js", "setup.js"]
   runtime=["index.js"] + install=["setup.js"] + bin=[] + flag.file="setup.js"
```

### 13.3 Two generators behind one port, and a union of them

```
┌─ HypothesisGenerator (Protocol) ─────────────── phases.py:569-580 ────────┐
│ async def generate(self, flag: Flag, *, package_path, intent,             │
│                    entry_points, hypothesis_id, created_at,              │
│                    audit_id) -> Hypothesis                               │
│ Post-condition: return an ARMED, DRY-RUN-VERIFIED Hypothesis, or RAISE.  │
│ There is no third option — no "could not arm, here's a stub".            │
└───────────────────────────────────────────────────────────────────────────┘

                    FallbackHypothesisGenerator          hypothesis_agent.py:407-424
                                  │
              ┌───────────────────┴───────────────────┐
              ▼                                       ▼
 KitHypothesisGenerator                  TwoPhaseHypothesisGenerator
   (primary, one-shot)                     (secondary, agentic)
   phases.py:583-746                       hypothesis_agent.py:153-404
   ONE model call must emit a whole        Call 1 "propose": the hypothesis +
   nested plan that decodes AND            a LOOSE tool sketch (may be wrong)
   compiles                                Call 2..N "agent": a tool-calling
                                           loop where EVERY call is validated
                                           by the REAL builder oracle

 FallbackHypothesisGenerator.generate:
   try:    return await primary.generate(flag, **kwargs)
   except BudgetExhausted:      raise            ◀── spend cap is TERMINAL
   except AuditIncompleteError: return await secondary.generate(flag, **kwargs)
```

Wired as the default at `pipeline.py:153-155`, with the rationale in the comment:

> One-shot primary, agentic two-phase fallback: the union arms the flags one-shot
> alone can't (measured no single approach wins every route).

`engine/CLAUDE.md:14-15` adds the boundary rule: "Hypothesis generation is
behind `HypothesisGenerator`; keep Kit-specific changes inside
`KitHypothesisGenerator`."

### 13.4 The one-shot generator

```
 KitHypothesisGenerator.generate                        phases.py:590-746
 ┌───────────────────────────────────────────────────────────────────────┐
 │ contents = _safe_file(package_path, flag.file).read_text() (OSError→"")│
 │ focus    = contents[:40_000] + "\n… (truncated)" if longer     :605    │
 │ targets  = trigger_targets(flag, entry_points)                 :606    │
 │ output   = hypothesis_submission(targets)   ← a DYNAMIC Pydantic model │
 │                                               built per call, :277-296 │
 └───────────────────────────────────────────────────────────────────────┘
```

`hypothesis_submission(targets)` uses `pydantic.create_model` to build the JSON
schema handed to the model, with the valid trigger targets **interpolated into
the field description** (`phases.py:285-295`):

```
 HypothesisPlan (extra="forbid" via StrictLlmOutput)
   description   : str
   claim         : ClaimDraft { kind: ClaimKind, gating: Gating|None }
   severity      : Severity
   setup         : ExperimentSetupPlan          phases.py:266-275
                     environment  : list[{name, value}]
                     files        : list[{path, content}]
                     dateIso      : str|None
                     urlStubs     : list[{pattern, responseStatus,
                                          responseBody, responseHeaders[]}]
                     filePatches  : list[{path, replacements[{pattern,
                                                              replacement}]}]
                     preloadCode  : str|None
   triggerTarget : str  description = "Exact existing entry point to execute,
                          one of: index.js, setup.js. If custom invocation
                          code is needed, return that JavaScript here; the
                          application will plant and execute
                          /pkg/npmguard-driver.js."
```

Note the deliberate design of the setup shape: **lists of key/value objects, not
maps**. `EnvVarDraft` is `{name, value}` (`phases.py:227-231`), `HeaderDraft` is
`{name, value}` (`:225-228`). Models emit arrays of objects far more reliably
than free-form maps under a strict schema, and the duplicate-key check that a map
would give for free is re-added by hand in `decode_plan`
(`phases.py:640-642, 636-638`).

`EnvVarDraft.name` even carries an anti-footgun description: "Never set CI to the
string 'false'; JavaScript treats it as truthy."

Then `decode_plan` (`phases.py:621-704`) converts the nested plan into the flat
`ToolCall[]` the sandbox executes — and this is where most of the semantic
validation lives:

```
 decode_plan(submission) → (submission, calls)
 ┌───────────────────────────────────────────────────────────────────────┐
 │ target = submission.triggerTarget.strip()                             │
 │ strip a leading "runtime:" / "install:" / "bin:" prefix        :626-629│
 │                                                                       │
 │ if target not in targets:                                     :631-636│
 │     if "\n" in target or /\b(const|let|var|require|import)\b|[;{}]/:  │
 │         driver_code = target ; target = "/pkg/npmguard-driver.js"     │
 │         ← the model wrote a PROGRAM instead of naming a file; plant it │
 │     else:                                                             │
 │         CandidateRejected("triggerTarget must be one of {targets} or   │
 │                            contain a JavaScript driver")              │
 │                                                                       │
 │ setup.environment → ToolCall("setEnv", {"env": {...}})        :637-647 │
 │     duplicate name → CandidateRejected("duplicate environment         │
 │                                         variable 'X'")                │
 │     THE CI TRUTHINESS GUARD:                                          │
 │       if re.search(r"if\s*\(\s*process\.env\.CI\s*\)", focus)         │
 │          and env.get("CI"):                                           │
 │           CandidateRejected("CI is tested by JavaScript truthiness;   │
 │             omit CI or set it to an empty string, never 'false'")     │
 │       ← a model trying to DEFEAT a CI gate by setting CI="false"      │
 │         would ARM the gate instead, because "false" is truthy in JS.  │
 │         The experiment would then silently test nothing.              │
 │                                                                       │
 │ setup.files (+ the planted driver) → ToolCall("plantFiles", …) :648-659│
 │     driver path collision → CandidateRejected("duplicate planted      │
 │                                                driver path")          │
 │ setup.dateIso    → ToolCall("setDate",   {"iso": …})           :660-661│
 │ setup.urlStubs   → ToolCall("stubUrl",   {"stubs": [...]})      :662-678│
 │     headers list→map, duplicate header → CandidateRejected            │
 │ setup.filePatches→ ToolCall("patchFile", {"patches": [...]})    :679-689│
 │ setup.preloadCode→ ToolCall("preload",   {"code": …})           :690-691│
 │ ALWAYS LAST:       ToolCall("trigger", {"kind":"entrypoint",           │
 │                     "target": target, "argv": [], "stdin": None})     │
 │                                                                :692-702│
 │ compile_experiment(calls)   ← the REAL oracle runs INSIDE the decode, │
 │                                so a non-compiling plan is a rejected  │
 │                                candidate, not a runtime failure :703   │
 └───────────────────────────────────────────────────────────────────────┘
```

Failure handling, and then the load gate:

```
 phases.py:706-729
 try:  result = await llm.run("hypothesis", …, output=output,
                              decode=decode_plan, context=("audit", audit_id))
       submission, calls = result.output
 except BudgetExhausted: raise      ← "spend exhaustion is terminal — never
                                      retried by the fallback"
 except Exception as exc:
       raise AuditIncompleteError("hypothesize",
         f"could not arm {flag.file} ({flag.why}) after bounded repair: {exc}")

 load_failure = await dry_run_load(package_path, calls, self.settings)
 if load_failure is not None:
     raise AuditIncompleteError("hypothesize",
       f"one-shot experiment for {flag.file} did not load: {load_failure.detail}")
```

The comment at `phases.py:722-723` explains why a one-shot *load* failure is a
failover rather than a retry: "The one-shot decode has no repair channel for a
payload that compiles but cannot load. Fail over to the agentic generator, which
dry-runs and repairs." Compiling proves the *shape* of the tool calls; only
running proves the *payload* resolves its imports.

If everything passes, the `Hypothesis` is constructed at `phases.py:730-746` with
`state="OPEN"`, `createdBy="hypothesize"`, `evidenceRefs=[]`,
`resolvedAt=None`, `resolution=None`.

### 13.5 The two-phase generator — and how `hyp-0008` was actually armed

The running example's `CONFIRMED` hypothesis did **not** come from the one-shot
path. `manifest.json` records `generationPath: "mixed (hypothesis one-shot +
propose/agent fallback)"`, and the exchange sequence shows `hyp-0008` going
through `propose` → `agent` → `agent` → `agent`. Here is that real trace.

```
 PHASE 1 — propose        exchanges/012_propose_92da0e37.json
 ┌─ INPUT ────────────────────────────────────────────────────────────────┐
 │ SYSTEM (prompts/propose/v1.md): "Turn one flagged region into one      │
 │   testable security hypothesis. Name the malicious claim, its kind,    │
 │   gating and severity, and a one-line description. Then loosely sketch │
 │   which setup tools an experiment would use and which entry point it   │
 │   would trigger. You are not the final judge; the observed run decides.│
 │   Never dismiss a flag because the code appears benign. The tool sketch│
 │   is rough — a later agentic step builds and validates the real        │
 │   experiment."                                                        │
 │ USER (hypothesis_agent.py:179-184 `base` + :218-223):                  │
 │   ## Package intent (benign baseline)                                  │
 │   Smart configuration loader with environment detection                │
 │   ## Flag                                                              │
 │   - file: setup.js                                                     │
 │   - lines: 120-120, 123-123                                            │
 │   - why: Probes IMDS asynchronously and exfiltrates all stolen data —  │
 │          auto-execution on require/import.                             │
 │   ## Flagged code   (numbered, first 6000 chars)                       │
 │   ## Setup tools    (TOOL_CATALOG)                                     │
 │   + "Propose ONE experiment… (one of ['index.js','setup.js'], or       │
 │      describe custom JS driver code)… The tool list is a sketch — do   │
 │      not write tool arguments yet."                                    │
 └────────────────────────────────────────────────────────────────────────┘
                                    ▼
 ┌─ OUTPUT: HypothesisProposal (hypothesis_agent.py:69-77) — VERBATIM ────┐
 │ description        : "Probe IMDS and exfiltrate all stolen data"       │
 │ kind               : "cred_theft"                                      │
 │ gating             : "docker_gate"                                     │
 │ severity           : "critical"                                        │
 │ triggerTargetIntent: "setup.js"                                        │
 │ plannedTools       : ["setEnv","plantFiles","stubUrl","trigger"]       │
 │ rationale          : "The flag is lines 120-123 where probeIMDS is     │
 │   called and all stolen data is exfiltrated via POST… The code runs    │
 │   immediately on require(), so triggering the main entry point         │
 │   (setup.js) will execute the exfiltration. I will use setEnv to plant │
 │   a bait token… and plantFiles to seed a fake .npmrc so the payload is │
 │   non-empty. stubUrl will make the IMDS call succeed with a canned     │
 │   response, allowing the full exfiltration path to complete."          │
 └────────────────────────────────────────────────────────────────────────┘
   ⚠ `plannedTools` is used for exactly ONE thing: sizing the agent's turn
     budget. n_tools = 4 → budget = min(24, max(10, 3*(4+2))) = 18
     hypothesis_agent.py:360-361
   ⚠ `triggerTargetIntent` and `rationale` are NEVER read as data — they go
     into the phase-2 prompt as text (hypothesis_agent.py:362-372) and are
     then discarded. Only description/kind/gating/severity survive onto the
     Hypothesis (hypothesis_agent.py:199-215).
```

```
 PHASE 2 — the agentic build loop      hypothesis_agent.py:237-404
 Seven tools are offered, each a real Pydantic arg model bound to a handler
 that calls the REAL builder (hypothesis_agent.py:347-359):
   setEnv PlantFiles stubUrl patchFile preload setDate  + finalize
 Every handler funnels through `add` (hypothesis_agent.py:249-255):
   BUILDERS[tool](args)                ← experiments.py's actual builder
   ExperimentCompileError → ToolCallError(str(exc))   ← fed BACK to the model
   else accumulated.append(ToolCall(tool, args))
   return f"OK: {tool} accepted. setup so far = {[c.tool for c in accumulated]}."

 TURN 1  exchanges/016_agent_80577e3a.json     finish_reason=tool_calls
   assistant: "I'll start by planting credentials and files, setting up the
               IMDS stub, and then trigger the entry point."
   → setEnv     {"vars":[{NPM_TOKEN,npm_12345secrettoken},
                         {AWS_ACCESS_KEY_ID,AKIA123456789},
                         {HOME,/home/node}]}
   → plantFiles {"files":[{/home/node/.npmrc,…},{/home/node/.ssh/id_rsa,…},
                          {/home/node/.aws/credentials,…}]}
   → stubUrl    {"stubs":[{169.254.169.254/latest/meta-data/*,200,"ami-id…"},
                          {http://localhost:9999/exfil,200,"ok"}]}
        ◀── THREE tools in ONE turn; the prompt permits it
            ("You may call several setup tools in one turn")

 TURN 2  exchanges/017_agent_1bd90c79.json     6 messages of history
   tool results fed back, verbatim:
     "OK: setEnv accepted. setup so far = ['setEnv']."
     "OK: plantFiles accepted. setup so far = ['setEnv', 'plantFiles']."
     "OK: stubUrl accepted. setup so far = ['setEnv','plantFiles','stubUrl']."
   assistant: "Good, all setup tools accepted. Now I'll finalize with the
               trigger on setup.js."
   → finalize {"target":"setup.js","argv":[]}

 h_finalize (hypothesis_agent.py:303-345) then does, in order:
   1. strip a "runtime:|install:|bin:|subpath:" prefix
   2. driverCode present, OR target unknown AND _looks_like_js(target)?
        → plant it at /pkg/npmguard-driver.js and retarget
          (refuse if a driver is already planted there)
      target unknown and NOT js-looking?
        → ToolCallError("target 'X' is not a valid entry point. Choose
           exactly one of [...], or pass driverCode with a JavaScript
           program that exercises the behavior.")
   3. append ToolCall("trigger", {kind, target, argv, stdin})
   4. compile_experiment(calls)  → ToolCallError(f"cannot finalize: {exc}")
   5. dry_run_load(package_path, calls, settings)  ← ACTUALLY RUNS IT
        failure → ToolCallError("the experiment does not load: {detail} —
          fix the offending require in your driver or preload (use
          './file.js' or '/pkg/file.js', never a bare 'file.js'), then
          finalize again.")
   6. done["calls"] = calls
      return "ARMED: experiment compiled and loaded — you are done."

 TURN 3  exchanges/019_agent_0bf26067.json     finish_reason=stop
   tool result: "ARMED: experiment compiled and loaded — you are done."
   assistant: "## Experiment Complete — ARMED / **Summary of what was done:**
               1. `setEnv` — Planted bait credentials … 2. …"
```

Two safety nets around that loop:

```
 hypothesis_agent.py:373-403
 async def drive(message, steps):
     try:    await llm.run_agent("agent", tools=tools, max_steps=steps, …)
     except BudgetExhausted:      raise      ← terminal
     except LoopBudgetExceeded:   pass       ← inspect `done` instead

 await drive(prompt, budget)          # budget = 18 for hyp-0008
 if "calls" not in done:
     # ONE bounded nudge, naming exactly what is missing. NOT a fabricated
     # trigger — the model still chooses the target.
     nudge = (f"You set up {[c.tool for c in accumulated]} but never armed "
              f"the experiment. Call `finalize` NOW — exactly once — with "
              f"target one of {targets} (or pass driverCode with custom JS). "
              f"Do nothing else.")
     await drive(nudge, 4)
 if "calls" not in done:
     raise AuditIncompleteError("hypothesize",
                                "agent finished without a compiled trigger")
```

And the outer wrapper (`hypothesis_agent.py:186-197`) normalises everything else
into the phase error, while letting `BudgetExhausted` and an already-shaped
`AuditIncompleteError` through unchanged:

```
 except Exception as exc:
     raise AuditIncompleteError("hypothesize",
       f"agentic build failed to arm {flag.file} ({flag.why}): {exc}")
```

### 13.6 `run_hypothesize` — the fan-out and its assertion

```
 run_hypothesize(flags, generator, *, package_path, intent, entry_points,
                 audit_id, emitter)                     phases.py:749-799
 ┌───────────────────────────────────────────────────────────────────────┐
 │ created_at = ONE timestamp for the whole batch                 :759   │
 │ output     = [None] * len(flags)   ← index-aligned              :760   │
 │ semaphore  = Semaphore(NPMGUARD_TRIAGE_CONCURRENCY, default 8)  :761   │
 │                                                                       │
 │ arm(index):                                                           │
 │   hypothesis_id = f"hyp-{index+1:04d}"                          :765   │
 │   emit file_analyzing {file: flag.file}                          :768   │
 │   output[index] = await generator.generate(flag, …)              :769   │
 │   emit hypothesis_emitted {hypId, claim, severity, file}         :780   │
 │                                                                       │
 │ await _gather_fail_fast(arm(i) for i in range(len(flags)))        :790   │
 │ for item in output:                                                   │
 │     assert item is not None      ◀── len(hypotheses) == len(flags)     │
 │     hypotheses.append(item)                                     :792-798│
 └───────────────────────────────────────────────────────────────────────┘
```

The assertion's comment (`phases.py:793-796`) is the point of the whole phase:

> `_gather_fail_fast` returned without raising, so every flag is armed —
> `len(hypotheses) == len(flags)` (mirrors `run_flag`). A `None` here would be a
> silently dropped suspicion: a hidden coverage gap that could launder into a
> false SAFE.

Because `created_at` is a single value for the batch, all 14 hypotheses share it
— which makes the `createdAt` tie-break in `next_open` a no-op and leaves
insertion order as the effective secondary sort (§15.4).

The 14 `file_analyzing` frames emitted here explain the demo recording's total of
16: 2 from FLAG, 14 from HYPOTHESIZE. The same event name is reused for two
different meanings, which matters for a UI counting progress
(Observations §24.6).

---

<a name="14-experiments"></a>
## 14. `experiments` — what a tool call compiles into

`engine/npmguard/experiments.py`. This module is the *single* place that knows
both how to describe a tool to a model and how to execute it. The design spec
calls this out as the contract that makes the whole approach work: "**Both** the
HYPOTHESIZE prompt (renders the tool list for the model) **and** the sandbox
executor read from it — one source of truth, no drift"
(`docs/specs/2026-07-10-triage-hypothesis-redesign.md:63-70`).

### 14.1 `compile_experiment` — the oracle

```
 compile_experiment(experiment: list[ToolCall]) -> CompiledExperiment
                                                    experiments.py:612-663
 ┌───────────────────────────────────────────────────────────────────────┐
 │ setup = [] ; trigger = None                                           │
 │ for call in experiment:                                               │
 │     args = _record(call.args or {}, call.tool)                        │
 │         non-dict → "invalid args for tool 'X': expected object"       │
 │     if call.tool == "trigger":                                        │
 │         if trigger is not None: ERROR "experiment has more than one   │
 │            trigger — a run has exactly one entrypoint"                │
 │         kind ∈ {entrypoint, lifecycle, bin, subpath}, target: str     │
 │             else "invalid args for tool 'trigger'"                    │
 │         argv: list[str]  else "argv must contain strings"             │
 │         stdin: str|None  else "stdin must be a string or null"        │
 │         trigger = Trigger(kind, target, argv, stdin)                  │
 │     elif call.tool in BUILDERS:                                      │
 │         setup.append(BUILDERS[call.tool](args))                       │
 │     else:                                                             │
 │         ERROR f"unknown tool '{tool}' (known: setEnv, plantFiles,     │
 │           setDate, stubUrl, patchFile, preload, trigger)"             │
 │ if trigger is None: ERROR "experiment has no trigger — nothing to run"│
 │ return CompiledExperiment(setup, trigger)                             │
 └───────────────────────────────────────────────────────────────────────┘
 Every ERROR above is ExperimentCompileError (a ValueError), experiments.py:37
```

Exactly one trigger, always. `shared/src/evidence.ts:100-105` states the
consequence: "An `args` shape that a tool's schema rejects is an incoherent
experiment (an ERROR), never silently run."

### 14.2 The six builders — each returns a `Manipulation`

```
┌─ Manipulation ──────────────────────────────── experiments.py:64-77 ──────┐
│ envs       dict[str,str]   → become `docker run -e K=V`                   │
│ ld_preload str|None        → become `-e LD_PRELOAD=…`                     │
│ preload    str|None        → become `-e NODE_OPTIONS=--require …`         │
│ hostname   str|None        → become `--hostname …`                        │
│ volumes    list[VolumeMount]                                              │
│ cap_add    list[str]                                                      │
│ post_start Callable[[container_name], Awaitable[None]] | None             │
│              ← runs AFTER the container exists, BEFORE the trigger        │
│ applied    dict             ← the AUDITABLE record; becomes SetupApplied  │
│ events     list             ← synthetic events injected into the timeline │
└───────────────────────────────────────────────────────────────────────────┘
```

| Tool | Mechanism | `applied` record | Cite |
|---|---|---|---|
| `setEnv` | `envs = dict(values)`; all keys and values must be strings | `{"env": {...}}` | `:81-83`, `:74-78` |
| `plantFiles` | `post_start` writes each file via base64-over-`sh`; **every path must be POSIX-absolute** | `{"plantFiles": [PlantedFileRef(path, contentHash=sha256(content))]}` | `:86-112` |
| `setDate` | parse ISO (tz offset **required**), convert to `FAKETIME="@%Y-%m-%d %H:%M:%S"`, set `ld_preload=/usr/lib/libfaketime.so.1` | `{"date": iso}` | `:115-128` |
| `stubUrl` | `post_start` launches `assets/stub-proxy.js`, waits for its readiness marker, then installs + verifies nat REDIRECT rules for each stubbed authority; `observe` reads the proxy's served ledger after the run | `{"stubUrls": [StubUrlRef(pattern, responseHash)]}` — **`responseHash` is null until the ledger says otherwise** | `_stub_url` |
| `patchFile` | `post_start` reads `/pkg/{path}`, applies literal `str.replace` pairs, writes back only if changed; path must be **relative** with no `..` | `{"patches": [FilePatchRef(path, patchHash)]}` | `:146-198` |
| `preload` | `post_start` writes the code to `/tmp/npmguard-preload.js`; `preload` field points at it | `{"preloadHash": sha256(code)}` | `:131-143` |

Note the deliberate asymmetry in path rules: `plantFiles` demands **absolute**
paths (`:101-104`) because it plants bait anywhere in the container filesystem
(`/home/node/.npmrc`); `patchFile` demands **relative, no-`..`** paths
(`:155-159`) because it may only rewrite files inside the package under test.

Note also that content is recorded as a **hash**, never as the literal value.
`StubUrlRef.responseHash` is the one entry in that table which is *not* derived
from the experiment: it is read back from the proxy after the run and is `null`
when the stub served nothing (§14.3). A setup record is a claim about the run.
`SetupApplied` (`shared/src/evidence.ts:148-157`) carries
`PlantedFileRef{path, contentHash}`, `StubUrlRef{pattern, responseHash}`,
`FilePatchRef{path, patchHash}`, and `preloadHash` — but `env` is stored as
literal `record(string)`, because the judge needs to see planted canary *names*
and values to correlate them with observed reads.

### 14.3 `stubUrl` in detail — interception, and a record of what was served

`stubUrl` is the most involved builder because it has to guarantee two things a
setup record normally cannot: *the endpoint is really intercepted, for whatever
client the package chose*, and *the artifact states what was actually served*.

It used to guarantee neither. Interception was `HTTP_PROXY`/`HTTPS_PROXY`, which
Node core's `http`/`https` ignore — and so does Node 22's global `fetch`/undici
(verified inside the sandbox image: with all four proxy variables set, every
client dialled the real endpoint and the proxy logged nothing). Meanwhile
`responseHash` was `sha256` of the *planned* response, so an artifact asserted a
canned reply for a stub that had intercepted nothing. §24.0 has the history.

**Interception is a transparent redirect inside the container's own network
namespace**, below every client library:

```
 stub_intercept_target(pattern) -> StubTarget | None        experiments.py
   "http://localhost:9999/exfil"        → (127.0.0.1, 9999, pin localhost)
   "http://exfil.example.com/*"         → (127.0.0.1,   80, pin the name)
   "http://169.254.169.254/latest/*"    → (169.254.169.254, 80, no pin)
   "http://*/collect"                   → (any host,     80, no pin)
   "https://…", "*", "ftp://…", IPv6    → None = OUT OF REACH (a coverage gap)

 envs                   NPMGUARD_STUBS, NPMGUARD_STUB_PORT      ← and nothing else
 extra_hosts            "<name>:127.0.0.1" per named authority  → docker --add-host
 post_start
 ┌───────────────────────────────────────────────────────────────────────┐
 │ write /tmp/npmguard-stub-proxy.js, launch it detached (as before), and │
 │ poll the proxy's OWN .ready / .err markers, ≤120 s, every 100 ms       │
 │   .err → RuntimeError("stubUrl proxy crashed on startup: …")           │
 │   timeout → cat the .log, raise "did not become ready within 120s"     │
 │                                                                       │
 │ THEN, only once it is listening, per reachable target:                 │
 │   docker exec --privileged --user 0 <c>                                │
 │     iptables -t nat -A OUTPUT -p tcp [-d <host>] --dport <port>        │
 │                              -j REDIRECT --to-ports 18080              │
 │   then the SAME rule expressions with -C to verify they are installed  │
 │   any failure → RuntimeError (→ SetupError → DEFER)                    │
 └───────────────────────────────────────────────────────────────────────┘
 THE INVARIANT: post_start returns ⟺ every reachable stub authority is
 redirected into a proxy confirmed listening. The order is load-bearing in both
 directions: rules before the proxy leaves a window where the stubbed port
 answers ECONNREFUSED, and `-C` after `-A` is what makes "installed" a fact
 rather than an exit code.
```

`--privileged` applies to that one `exec`; the container keeps `cap_drop=ALL`, so
the package under audit cannot read the nat table, let alone remove a rule
(verified: `iptables -t nat -L` as uid 1000 is "Permission denied"). The
`--add-host` pin exists because a nonexistent exfil host would otherwise fail at
DNS and never reach a redirect at all — `.invalid` resolves nowhere.

The proxy and its state are put out of the package's reach for the same reason,
because the **ledger is read after the package has run**:

```
 --tmpfs /npmguard-stub:rw,noexec,nosuid,size=8m,uid=0,gid=0,mode=0755
 docker exec -d --user 0 -e NPMGUARD_STUB_DIR=/npmguard-stub … node …stub-proxy.js
   ⇒ root-owned 0755 dir: world-READABLE (the engine polls it as the container
     user) and root-WRITABLE only
   ⇒ uid 1000 can neither append a forged ledger row, nor plant the .err marker,
     nor signal or ptrace the proxy to take over port 18080
   (each verified in a real container; the tmpfs mounts fine at a path absent
    from the image even under --read-only)
 liveness = pgrep -u 0 -f <proxy>  ⇒ a uid-1000 decoy with a matching cmdline
     cannot vouch for a proxy that is gone
```

The *script* stays on `/tmp` because the engine writes it as the container user;
by the time the package runs, the proxy has already loaded it.

Why not the alternatives: an interception patch inside the L4 instrument is
bypassed by `execFileSync('node', …)`, because the instrument is loaded by
`--require` on the trigger's command line and a child inherits none of it; and
binding the stub at the real address cannot cover a bare-IP authority such as
`169.254.169.254` without the same NET_ADMIN it was meant to avoid.

**The record comes from the proxy, not the plan.** `assets/stub-proxy.js` appends
one row per request to `/tmp/npmguard-stub-proxy.served` — `{stub: <index|null>,
method, url, status, responseHash}` — synchronously, in the same turn that writes
the response, so a row exists exactly when a response was written for a request
that matched that stub. After the trigger, `Manipulation.observe` reads that
ledger and rebuilds `setupApplied.stubUrls`:

```
 responseHash = sha256(JSON.stringify({status, body, headers}))  ← as SENT
              = null  when the stub answered nothing
 continuity   = the same iptables -C expressions + pgrep of the proxy,
                re-checked AFTER the run (mirrors stop_pcap: "installed before
                the trigger" is not "in force for the whole run")
 gap          = an unreachable pattern, or a redirect/proxy no longer in force
              → RunError(kind="SetupError") → the orchestrator can only DEFER
```

So `responseHash` is a fact about the run: non-null *is* the statement "this
canned response was served". A gap does not block the trigger — the run still
executes and its evidence can still CONFIRM — it only bars REFUTED, because a
manipulation that was never in force cannot clear a suspicion.

```
 assets/stub-proxy.js
   process.on('uncaughtException', e => fail(e.stack))
   server.on('error', e => fail('listen error: ' + e.stack))
     ← a bind failure (EADDRINUSE) arrives as an EVENT, not a throw; without
       this handler it would be a silent death
   fail(reason): write reason to …/.err, print to stderr, process.exit(3)
   listen(PORT, '127.0.0.1', () => write …/.ready)

   target(request):  absolute-form (`GET http://h/p`) as sent; otherwise
     'http://' + Host header + request.url  ← what the redirect delivers
   matchStub(url):  escape every regex metacharacter INCLUDING `*`, then turn
     the escaped `\*` back into `.*`, anchor with ^…$; returns the stub INDEX
     ⇒ "*" is the ONLY wildcard, everything else is literal, first match wins
   matched   → record(row); writeHead(status, headers); end(body)
   unmatched → record(row with stub:null); 502 "no matching stub for {url}"
   CONNECT   → 502 (HTTPS MitM is not supported)
```

Escaping `*` is not cosmetic: without it the character survived into the regex as
a quantifier on whatever preceded it, so `http://169.254.169.254/latest/meta-data/*`
compiled to "…/meta-data" plus zero-or-more slashes and matched no sub-path.
**Every wildcard stub in the recorded corpus was inert for that reason**, on top
of the proxy never being reached at all.

Two consequences remain for reading real timelines. An `https://` target still
cannot be stubbed — that needs a MitM CA the sandbox deliberately does not ship —
but it is now a `SetupError` naming the pattern instead of a silent no-op. And an
*unmatched* request to a stubbed authority still gets a 502, so it appears as a
`network`/`http_request` event with no stub behind it; requests to authorities no
pattern named are not redirected at all, so a run can still observe a real
second-stage download it was never asked to intercept.

Note what does **not** prove interception: L1. `strace` records the `connect`
argument, and netfilter rewrites the destination afterwards — so the running
example's `connect(19, 127.0.0.1:9999) = -1` looks identical whether or not a
redirect is in force. Interception is observable only from what the client
received and from the proxy's ledger, which is why the ledger is what the
artifact records (`tests/e2e/test_stub_intercept.py` asserts through both).

### 14.4 `compose` and `merge_container_spec`

```
 compose(primitives: list[Manipulation]) -> ComposedSetup   experiments.py:666-723
   envs      : dict, later primitives OVERWRITE earlier keys
   ld_preload/preload/hostname : LAST non-None wins
   volumes   : concatenated        cap_add : concatenated then deduped
   post_starts : collected in order            events : concatenated
   applied   : plantFiles/stubUrls/patches EXTEND;
               env UPDATES; everything else OVERWRITES
   → SetupApplied(**applied)     ← the sealed, auditable record

 merge_container_spec(base, setup) -> ContainerSpec         experiments.py:726-738
   MUTATES base in place: envs.update, ld_preload/preload/hostname or-default,
   volumes.extend, cap_add deduped-union
```

---

<a name="15-graph"></a>
## 15. `graph` — the state machine and its guards

`engine/npmguard/graph.py`. The graph is an in-memory, per-audit collection of
hypotheses keyed by `hypId`, wrapped in a state machine whose transitions carry
the system's core invariants.

### 15.1 The five states

```
                          ┌──────────┐
                          │  OPEN    │  armed, not yet dispatched
                          └────┬─────┘
                               │ orchestrator picks it (next_open)
                               ▼
                        ┌─────────────┐
                        │ IN_PROGRESS │  a sandbox run is under way
                        └──┬───┬───┬──┘
        judge: malicious   │   │   │  judge: not malicious, run was CLEAN
        + ≥1 cited event   │   │   └──────────────────┐
                           │   │ machinery failed:    │
                           │   │ Setup/Sensor/Timeout │
                           │   │ Error, judge failed, │
                           │   │ module unresolved,   │
                           │   │ budget out, internal │
                           ▼   ▼                      ▼
                   ┌───────────┐ ┌──────────┐  ┌──────────┐
                   │ CONFIRMED │ │ DEFERRED │  │ REFUTED  │
                   └───────────┘ └──────────┘  └──────────┘
                    → DANGEROUS   → the audit    → contributes
                                    ERRORs (if     to SAFE
                                    nothing
                                    confirmed)
 TERMINAL_STATES = {CONFIRMED, REFUTED, DEFERRED}                graph.py:18
 There is deliberately NO "inconclusive". shared/src/graph.ts:48-54:
   "a run either fired, refuted, or could not be evaluated."
```

### 15.2 `add` — the armed invariant

```
 HypothesisGraph.add(hypothesis)                          graph.py:98-119
 ┌───────────────────────────────────────────────────────────────────────┐
 │ parsed = Hypothesis.model_validate(hypothesis)   ← revalidate, always  │
 │                                                                       │
 │ if parsed.state == "OPEN" and not parsed.experiment:                   │
 │     raise AssertionError(f"graph: unarmed hypothesis {hypId} admitted  │
 │                           as OPEN")                            :100-105 │
 │   ◀── "the generators return an armed, dry-run-verified Hypothesis or  │
 │       raise, so dispatch can trust any node it picks without           │
 │       re-checking."                                                   │
 │                                                                       │
 │ if hypId already present: HypothesisGraphError("duplicate hypId: …")   │
 │ if parentHypId is not None:                                    :108-116│
 │     parent must exist   else HypothesisGraphError("parent not found")  │
 │     append this id to the parent's childHypIds (immutable model_copy)  │
 │ self._nodes[hypId] = parsed ; self.updated_at = clock()                │
 └───────────────────────────────────────────────────────────────────────┘
```

### 15.3 `add_or_merge` — fuzzy dedup, keep-first

Independent flags on nearby lines frequently produce near-identical hypotheses.
Running each separately costs a sandbox run and a judge call for no new
information, so near-duplicates are merged.

```
 build_graph(audit_id, hypotheses)                        graph.py:268-275
   graph = HypothesisGraph(audit_id) ; merged = added = 0
   for h in hypotheses:
       _, did_merge = graph.add_or_merge(h)
       merged += int(did_merge) ; added += int(not did_merge)
   return graph, merged, added

 add_or_merge(h, threshold=0.88)                          graph.py:133-188
   duplicate = the FIRST existing node with
       similar_description(h.description, node.description, 0.88)
   if duplicate is None: return add(h), False
   else:
       focusFiles = dedupe(duplicate.focusFiles + h.focusFiles)
       focusLines = duplicate.focusLines + any (file,range) not already there
       merged = duplicate.model_copy(update={focusFiles, focusLines})
       self._nodes[duplicate.hypId] = merged
       return merged, True
       ⚠ THE INCOMING NODE'S experiment, claim, severity, hypId ARE DISCARDED.
         Only focus information is folded in. "Keep-first" is literal.
```

`similar_description` (`graph.py:64-68`) lowercases, collapses whitespace, and
compares with Jaro-Winkler ≥ `DEFAULT_MERGE_THRESHOLD = 0.88` (`graph.py:19`).
`jaro_winkler` is implemented from scratch at `graph.py:31-61`: a match window of
`max(len)//2 - 1`, transposition count over the matched subsequences, then the
standard Winkler prefix bonus of `prefix_len * 0.1 * (1 - jaro)` over up to 4
leading characters.

Because Jaro-Winkler weights a **shared prefix** heavily, two hypotheses that
begin with the same clause ("The setup.js install hook…") are much more likely to
merge than two that end similarly. That is a property to be aware of when reading
`mergedCount`.

For the running example: `graph_built {nodeCount: 14, addedCount: 14,
mergedCount: 0}` — all 14 descriptions were distinct enough. The two closest
pairs are `hyp-0002` ("Trigger postinstall setup.js to exfiltrate planted
secrets…") and `hyp-0006` ("Exfiltrate harvested environment credentials via HTTP
POST when setup.js is executed directly"), which stayed separate.

### 15.4 `next_open` — dispatch order

```
 next_open(graph)                                        graph.py:278-284
   nodes = graph.filter_by_state("OPEN")
   return min(nodes, key=lambda n: (-SEVERITY_ORDER[n.severity or "medium"],
                                    n.createdAt))    if nodes else None
 SEVERITY_ORDER = {"critical":4, "high":3, "medium":2, "low":1}     :20
```

Highest severity first; `createdAt` ascending as tie-break. But
`run_hypothesize` gives every hypothesis in a batch the **same** `created_at`
(`phases.py:759`), so the tie-break is inert and `min`'s stability leaves
**insertion order** as the effective secondary key.

That prediction is exactly borne out by the recorded `hypothesis_resolved`
sequence:

```
 severity   hypIds in the graph            resolved in this order
 ─────────  ─────────────────────────────  ──────────────────────────────────
 critical   0001 0002 0003 0006 0007 0008  0001 → 0002 → 0003 → 0006 → 0007
                                                 → 0008
 high       0004 0005 0010 0011 0012 0013  0004 → 0005 → 0010 → 0011 → 0012
                                                 → 0013
 low        0009 0014                      0009 → 0014
```

Fourteen `hypothesis_resolved` frames, in precisely that order, in
`engine/demo-data/test-pkg-env-exfil.json`. The consequence is architectural: the
most severe suspicions burn the shared time budget first, so if the budget runs
out, what gets DEFERRED is the least severe — and a deferral still blocks a
`SAFE` verdict (§18).

### 15.5 `transition` — the three guards

```
 transition(hypothesis_id, to, *, by, reason=None, evidence_refs=None,
            resolved_at=None)                            graph.py:199-236
 ┌───────────────────────────────────────────────────────────────────────┐
 │ GUARD 1 — no exit from a terminal state              :210-213         │
 │   if current.state in TERMINAL_STATES:                                │
 │       HypothesisGraphError(f"cannot transition {id} out of terminal    │
 │                             state {state}")                           │
 │                                                                       │
 │ refs = current.evidenceRefs + (evidence_refs or [])                   │
 │                                                                       │
 │ GUARD 2 — evidence is mandatory for a decision       :214-217         │
 │   if to in {"CONFIRMED","REFUTED"} and not refs:                      │
 │       HypothesisGraphError(f"transition to {to} requires at least one  │
 │                             evidenceRef (got 0)")                     │
 │   ◀── THIS is the mechanical meaning of "evidence-bound". Neither     │
 │       DANGEROUS nor SAFE can be reached without a pointer to a sealed │
 │       RunArtifact. Note it accepts refs ALREADY on the node too, so   │
 │       add_evidence() then transition() also satisfies it.             │
 │                                                                       │
 │ GUARD 3 — a deferral must say why                    :218-220         │
 │   if to == "DEFERRED" and not reason:                                 │
 │       HypothesisGraphError("transition to DEFERRED requires           │
 │                            resolution.reason")                        │
 │   ⚠ note: DEFERRED requires a REASON but NOT evidence — because the   │
 │     whole point of a deferral is that usable evidence is missing.     │
 │                                                                       │
 │ terminal = to in TERMINAL_STATES                                      │
 │ updated  = current.model_copy(update={                                │
 │     state: to, evidenceRefs: refs,                                    │
 │     resolvedAt: (resolved_at or now) if terminal else None,           │
 │     resolution: HypothesisResolution(reason or "", by) if terminal     │
 │                 else None})                                           │
 │ self._nodes[id] = Hypothesis.model_validate(updated)                  │
 └───────────────────────────────────────────────────────────────────────┘
```

`add_evidence` (`graph.py:190-197`) appends refs without changing state — used by
the orchestrator so a DEFERRED node still points at the (unusable) run that was
attempted.

`serialize` (`graph.py:238-245`) produces `HypothesisGraphSnapshot{version: 1,
auditId, nodes, createdAt, updatedAt}` (`shared/src/graph.ts:112-118`), written
twice by the pipeline: `graph.json` right after building
(`pipeline.py:403`) and `graph-final.json` after the orchestrator
(`pipeline.py:435`). `load`/`load_from` (`graph.py:251-265`) can rebuild a graph
from a snapshot — note that `load` bypasses `add`, so the armed-OPEN assertion is
not re-checked on load.

---

<a name="16-the-full-oracle"></a>
## 16. `orchestrator` + `observation` + `sensors` — the full oracle

This is the heart of the system: the part that actually runs the suspect code and
watches it.

### 16.1 What "full oracle" means, exactly

```
 orchestrator.py:25-27
 FULL_ORACLE = {"kernel": True, "network": True, "node": True,
                "fsDiff": True, "inspector": True}
 EXPERIMENT_BUDGET = {"wallMs": 20_000}
 PER_HYPOTHESIS_SECONDS = 360
```

Five sensor layers, **all on, for every hypothesis, unconditionally**. There is
no per-claim sensor selection anywhere. The design decision
(`docs/specs/2026-07-10-triage-hypothesis-redesign.md:119`): "**Full oracle,
every run.** Inspector included (anti-debug is signal; compute ≪ LLM cost)."

Here is what each layer is, what it sees, and how it sees it.

```
╔═ THE FIVE SENSORS ═══════════════════════════════════════════════════════════╗
║                                                                              ║
║ L1  kernel   stream "L1:seccomp"                     sensors.py:93-394       ║
║   HOW: the trigger command is wrapped in                                     ║
║        strace -f -ttt -s 4096 -o /tmp/strace.log -e trace=<21 syscalls>      ║
║        requires cap SYS_PTRACE (observation.py:174)                          ║
║   TRACED_SYSCALLS (sensors.py:13-35), 21 of them:                            ║
║     openat open read write unlink unlinkat rename renameat renameat2         ║
║     link linkat connect sendto recvfrom accept accept4 execve clone          ║
║     clone3 fork vfork                                                        ║
║   SEES: file opens/reads/writes with PATHS, process execs with ARGV,          ║
║         outbound connects with ip:port, deletes, renames, links, forks       ║
║   ALSO SEES, easy to miss: `-s 4096` means `raw` carries up to 4096 BYTES    ║
║         of every read/write/sendto/recvfrom BUFFER, verbatim. Captured and   ║
║         hashed, but NOT rendered — see §24.8.                                ║
║   BLIND TO: which JavaScript line did it; plain read/write carry only an fd  ║
║             (resolved later by the renderer, §17.4). sendto/recvfrom DO      ║
║             carry a parsed peer {family, addr, port} since 67f830f.          ║
║                                                                              ║
║ L2  network  stream "L2:pcap"                       sensors.py:511-740       ║
║   HOW: tcpdump -i any -U -Z root -w /tmp/npmguard-capture.pcap, started      ║
║        BEFORE the trigger, TERMed after; parsed with                          ║
║        tshark -T json -Y "dns.qry.name or http.request or                    ║
║                           tls.handshake.extensions_server_name" -2           ║
║        requires network_mode=bridge + caps NET_RAW SETUID SETGID             ║
║   SEES: dns_query{host}, http_request{host,method,path}, tls_sni{host}       ║
║   BLIND TO: HTTPS payloads (encrypted); the pcap gives SNI only              ║
║                                                                              ║
║ L3  fsDiff   stream "L3:fsDiff"                     sensors.py:472-508       ║
║   HOW: before and after the run,                                             ║
║        find <paths> -type f -printf '%s\t%T@\t%p\0' | sort -z  :472-481      ║
║        (paths shlex.quote'd; written to a tmpfs file, cat back)              ║
║        then diff the two maps                                                ║
║   NOTE the field ORDER and the NUL: path LAST, records NUL-terminated.       ║
║        The obvious form — path first, tab/newline delimited — made any file  ║
║        named with a tab or a newline vanish from the fs-diff, which is a     ║
║        free evasion, not an edge case. parse_snapshot now ASSERTS rather     ║
║        than skipping a row it cannot split (67f830f).                        ║
║   SEES: file_created / file_modified / file_deleted, with size and mtime     ║
║   BLIND TO: transient files created and deleted within the run; ordering     ║
║             (its timestamps are mtimes — "mtime-coarse")                     ║
║                                                                              ║
║ L4a node     stream "L4:monkey"      assets/instrumentation-monkey.js        ║
║   HOW: node --require /tmp/_instrument.js, which monkey-patches:             ║
║     Module._resolveFilename        → {type:"require", module, from}   :6-10  ║
║     fs.readFileSync writeFileSync readFile writeFile accessSync statSync     ║
║                                    → {type:"fs", method, path}      :12-21  ║
║     http.request / https.request   → {type:"network", method, url}   :23-33  ║
║     child_process exec execSync spawn spawnSync fork                         ║
║                                    → {type:"process", method, cmd}   :35-44  ║
║     process.env  (a Proxy `get` trap)                                        ║
║                                    → {type:"env", key}               :46-53  ║
║     global.eval                    → {type:"eval", code[:200]}       :55-59  ║
║     crypto createDecipheriv createDecipher createCipheriv createHash         ║
║                                    → {type:"crypto", method, algo}   :61-74  ║
║     global.setTimeout / setInterval→ {type:"timer", kind, ms}        :92-101  ║
║   SEES: SEMANTICS — the URL string, the module name, the env KEY, the        ║
║         fs method by name. This is the layer that reads like intent.         ║
║   BLIND TO: anything that bypasses these entry points (raw bindings,         ║
║         a re-required fresh module instance, native addons)                  ║
║                                                                              ║
║ L4b inspector stream "L4:v8inspector"  assets/instrumentation-inspector.js   ║
║   HOW: an in-process inspector.Session, Debugger.enable +                    ║
║        setSkipAllPauses, listening for Debugger.scriptParsed; for each       ║
║        non-node:/file:/absolute/node_modules url it fetches the source       ║
║        (capped at 65536 chars) → {type:"script", url, source, len}           ║
║   SEES: DYNAMICALLY COMPILED CODE — an eval'd or new Function'd payload      ║
║         that exists only at runtime.                                        ║
║                                                                              ║
║ TRANSPORT for both L4 layers: assets/instrumentation-flush.js                ║
║   process.on('exit', () => process.stdout.write(                            ║
║     '\n__NPMGUARD_TRACE__' + JSON.stringify(_log) + '__NPMGUARD_TRACE_END__' ║
║     + '\n'))                                                                ║
║   ⇒ the entire L4 log arrives as ONE delimited JSON blob on stdout.          ║
║   ⇒ IF THOSE MARKERS ARE ABSENT, that is a SensorError → DEFER (§16.5).      ║
║                                                                              ║
║ (+ stream "engine": synthetic events the engine injects itself,               ║
║    e.g. kind="truncated" when the wall budget is hit. evidence.py:275-283)   ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

For `hyp-0008`, the sealed artifact records the exact yield of each layer
(`sandbox/hyp-0008.runartifact.json`, 192 events):

| Stream | Kind | Count |
|---|---|---|
| `L1:seccomp` | `read` | 51 |
| `L1:seccomp` | `openat` | 38 |
| `L1:seccomp` | `clone` | 22 |
| `L1:seccomp` | `write` | 7 |
| `L1:seccomp` | `connect` | 7 |
| `L1:seccomp` | `execve` | 1 |
| `L1:seccomp` | `sendto` | 1 |
| `L4:monkey` | `env_access` | 37 |
| `L4:monkey` | `require` | 13 |
| `L4:monkey` | `fs_op` | 10 |
| `L4:monkey` | `network` | 1 |
| `L4:v8inspector` | `script_parsed` | 3 |
| `L2:pcap` | `http_request` | 1 |
| `L3:fsDiff` | — | 0 (nothing was written) |

### 16.2 The container the experiment runs in

```
 default_container_spec + overrides                observation.py:164-176
 ┌───────────────────────────────────────────────────────────────────────┐
 │ image        settings.sandbox_image     (default "npmguard-sandbox:v1")│
 │ memory       f"{sandbox_memory_mb}m"    (default 512)                 │
 │ cpus         sandbox_cpus               (default 1)                   │
 │ network_mode "bridge" if observe.network else "none"                   │
 │ cap_drop     ["ALL"]                                                  │
 │ cap_add      ["SYS_PTRACE"] if kernel  +  ["NET_RAW","SETUID",        │
 │                                            "SETGID"] if network       │
 │ read_only    True         ← the image filesystem is immutable          │
 │ user         "1000:1000"  ← non-root                                   │
 │ pids_limit   64           ← a fork bomb hits this, not the host        │
 │ workdir      "/pkg"                                                    │
 │ extra_hosts  "<name>:127.0.0.1" per stubUrl authority (§14.3)          │
 │              → --add-host; /etc/hosts is a ROOT-owned bind mount, so   │
 │                the package cannot rewrite what a name resolves to      │
 │ volumes      [ host <package_path> → /pkg-src  READ-ONLY ]            │
 │ tmpfs        /tmp       rw,noexec,nosuid,size=64m                      │
 │              /pkg       rw,size=256m,uid=1000,gid=1000,mode=0755       │
 │              /home/node rw,size=64m,uid=1000,gid=1000,mode=0755        │
 └───────────────────────────────────────────────────────────────────────┘
 spec_to_docker_args (docker.py:251-286) renders that, ending with
   -w /pkg <image> sleep infinity
 ⇒ the container is a long-lived shell we `docker exec` into, not a one-shot.
```

The `/pkg-src` (read-only bind) → `/pkg` (writable tmpfs) split is the key
arrangement. The host directory can never be modified by the sandbox; the first
thing the run does is `cp -a /pkg-src/. /pkg/` (`observation.py:236-238`), giving
the package a writable copy it can mutate freely. `/home/node` is a tmpfs so
planted credential bait lives in RAM and evaporates with the container. `preload`
becomes `NODE_OPTIONS=--require <path>`, appended to any existing `NODE_OPTIONS`
(`docker.py:271-275`).

### 16.3 `run_under_observation` — the exact sequence

```
 run_under_observation(package_path, experiment, settings, *, observe, budget)
                                                    observation.py:152-439
 run_id = f"run_{uuid4().hex[:26]}"              ← e.g. run_e8596819e848454e91d54b5a5e
 compiled = compile_experiment(experiment)       ← compiled a SECOND time here
 observed = ObserveFlags(**{**DEFAULT_OBSERVE, **observe})
 limits   = Budget(**{**DEFAULT_BUDGET, **budget})
 setup    = compose(compiled.setup) ; spec = merge_container_spec(base, setup)
 container = f"npmguard-run-{run_id[4:16]}"
 events   = list(setup.events) ; error = None
 ─────────────────────────────────────────────────────────────────────────────
  0. START THE CONTAINER, with up to 3 attempts        :199-224
     docker run -d …   FileNotFoundError → DockerUnavailableError (0020)
     CancelledError → `docker rm -f` FIRST, then re-raise
       ◀── the try/finally is not active yet, and `docker run -d` may have
           created the container daemon-side before the cancel landed :206-213
     exit != 0 → `docker rm -f`, sleep 0.5×(attempt+1), retry
     still failing → RunUnderObservationError("failed to start sandbox
       container", detail=f"docker run exit={c} after 3 attempts: {stderr}")
 ┌── try: ────────────────────────────────────────────────────────────────────┐
 │ 1. if network: start_pcap(container)                 :227-233              │
 │      exception → error = RunError("SensorError", str(exc))                 │
 │ 2. if error is None: cp -a /pkg-src/. /pkg/          :235-243              │
 │      exit != 0 → error = RunError("SetupError", "failed to copy …")        │
 │ 3. if error is None and node: write /tmp/_instrument.js  :245-255          │
 │      = monkey [+ inspector] + flush, concatenated (docker.py:327-342)      │
 │      exception → error = RunError("SensorError", "failed to write L4 …")   │
 │ 4. if error is None: run every setup.post_starts hook IN ORDER  :257-263   │
 │      first exception → error = RunError("SetupError", str(exc)); break     │
 │      ⇒ plantFiles writes bait; stubUrl launches + awaits the proxy;        │
 │        patchFile rewrites files; preload writes its script                 │
 │ 5. run_start_sec = time.time()   ← the L1/L3 timestamp origin  :265        │
 │    if fsDiff: snapshot_pre(container)                :266-270              │
 │      exception → error = RunError("SensorError", …)                        │
 │ 6. if error is None: THE TRIGGER          observation.py:272-361           │
 │      command = build_trigger_command(compiled.trigger, node)               │
 │        None (kind is lifecycle|bin) → error = RunError("SetupError",       │
 │          f"trigger.kind='{kind}' has no run command")                     │
 │      wrapped = wrap_with_strace(command) if kernel else command            │
 │      docker exec [-i if stdin] <c> <wrapped>, timeout=limits.wallMs        │
 │      exit_code, timed_out = …                                             │
 │      stdout_hash/stderr_hash = sha256 of each, or None if empty            │
 │      timed_out  → error = RunError("TimeoutError", "wall-clock budget      │
 │                     (20000ms) exceeded; container killed")                │
 │                 + a synthetic "truncated" event                           │
 │      exit != 0  → error = RunError("CrashError", f"node exited {code};     │
 │                     stderr: {stderr[:500]}")                              │
 │      if node:  l4 = parse_l4_trace(stdout)                                │
 │        l4 is None and error is None → error = RunError("SensorError",      │
 │          "L4 trace markers absent from stdout (instrumentation evaded or   │
 │           suppressed)")                                                   │
 │        else events.extend(l4)                                             │
 │      if kernel: cat /tmp/strace.log                                       │
 │        ok+nonempty → events.extend(parse_strace_log(...));                │
 │                      strace_hash = sha256(log)                            │
 │        else if error is None → error = RunError("SensorError",             │
 │                                  f"strace log unreadable: {stderr}")      │
 │ 7. if fsDiff and error.kind ∉ {SetupError,SensorError}:                    │
 │                                           observation.py:363-369           │
 │      snapshot_post → events.extend(diff); fs_diff_hash = sha256(raw)      │
 │ 8. if network and error.kind != "SetupError":                              │
 │                                           observation.py:371-390           │
 │      stop_pcap → events.extend(pcap.events); pcap_hash = sha256(raw_pcap) │
 9. SETUP READ-BACK — for each setup.observers hook, while the container lives   │
 │      applied = observation.applied   ← what the manipulation actually did     │
 │      events += observation.events    ← e.g. a setup_bypass row                │
 │      observation.gap → error = RunError("SetupError", gap) if error is None    │
 │      an exception → RunError("SetupError", "setup read-back failed: …")        │
 │      LAST on purpose: a gap found here must not gate the sensor collection    │
 │      above out of the artifact (fs-diff and pcap both skip on SetupError)     │
 └── finally: docker rm -f <container>, suppressed   observation.py:413-415 ──┘
 events.sort(key=lambda e: e.timestamp)          observation.py:417
 return seal_run_artifact({...})                 observation.py:418-439
```

Three structural properties of that sequence deserve naming:

**`setupApplied` is not an input.** The record sealed into the artifact is the one
step 9 produced, not the one `compose` built: a manipulation that can only be
described after the fact (a stub's served response) describes itself there, and the
compile-time value asserts nothing (§14.3).

**Error latching.** `error` is set once and then gates later steps. So the
*first* thing that went wrong is what the artifact reports, and later sensors do
not overwrite it. The post-run steps have carefully different gates: fs-diff
skips only on `SetupError`/`SensorError` (a crashed run still produced a
filesystem state worth diffing), and pcap-stop skips only on `SetupError` (if
setup never completed, the capture is meaningless).

**The container is always removed.** `finally` at `:314-316`, plus the special
pre-`try` cancellation handling at `:175-182`.

**Timestamps come from three different clocks.** L1 is `(strace_time -
run_start_sec) * 1e9` nanoseconds (`sensors.py:384`); L3 is `(mtime -
run_start_sec) * 1e9`, also clamped at 0 (`sensors.py:424`); L2 is
`frame.time_relative * 1e9` (`sensors.py:339-342`); **L4 is a logical index** —
`timestamp=index`, the position in the flush array (`evidence.py:226`). So the
global `events.sort` at `:318` puts all L4 events (tiny integers) before all
wall-clock events (hundreds of millions). The renderer does not fight that; it
splits them into two explicitly-labelled sections (§17.4).

### 16.4 `build_trigger_command` — how a target becomes a command line

```
 build_trigger_command(trigger, l4)                observation.py:134-149
   flags = ["--require","/tmp/_instrument.js"] if l4 else []
   kind "entrypoint" → spec = posixpath.normpath(
                                 posixpath.join("/pkg", trigger.target))
       "setup.js"                    → "/pkg/setup.js"
       "./source/index.js"           → "/pkg/source/index.js"
       "/pkg/npmguard-driver.js"     → "/pkg/npmguard-driver.js"
         ← posixpath.join returns an ABSOLUTE second argument unchanged, so a
           planted absolute driver path stays absolute
   kind "subpath"    → spec = trigger.target verbatim (a module specifier,
                              not a filesystem path)
   kind "lifecycle"|"bin" → return None  ⇒ SetupError "has no run command"
   return ["node", *flags, "-e", f"require({json.dumps(spec)})",
           "--", spec, *trigger.argv]
```

Three deliberate choices here. `require()`ing the **absolute** result removes all
`node_modules` ambiguity. The `-- spec argv…` tail reproduces a normal `node
<file> <args>` invocation so `process.argv[1]` is the entry and `argv[2:]` are
the caller's arguments; `--` guards arguments beginning with `-`. And `stdin` is
piped separately via `docker exec -i` (`observation.py:281-288`) rather than
being encoded into argv.

Also note: `Trigger.kind` has four legal values in the contract
(`shared/src/evidence.ts:82`) and `compile_experiment` accepts all four
(`experiments.py:638`), but only `entrypoint` and `subpath` are runnable.
`lifecycle` and `bin` produce a `SetupError` → DEFER. In practice the generators
always emit `kind: "entrypoint"` (`phases.py:696`,
`hypothesis_agent.py:326`), and a lifecycle hook is reached by targeting its
*file* — which is why `entryPoints.install` exists and why `hyp-0008` triggers
`setup.js` directly rather than asking for `preinstall`.

### 16.5 The sensor readiness barriers

Both L2 barriers exist because "I started the sensor" is not the same as "the
sensor is capturing", and the gap between them is exactly where evidence gets
silently lost.

```
 start_pcap(container)                              sensors.py:517-559
   docker exec -d --user 0 <c> sh -c
     "exec tcpdump -i any -U -Z root -w /tmp/npmguard-capture.pcap
      2>/tmp/npmguard-capture.err"
     `exec` keeps the process NAME "tcpdump" so pgrep/pkill work
   exit != 0 → RuntimeError("pcap failed to launch tcpdump: …")
   THEN poll (≤ 15 s, every 100 ms):
     grep -q 'listening on' <err>            → READY  → return
     elif [ -s <err> ] && ! pgrep -x tcpdump → DEAD   →
        RuntimeError("tcpdump exited before capturing: …")
   timeout → RuntimeError("tcpdump did not confirm capture ('listening on')
             within 15s")

 THE INVARIANT (sensors.py:536-542):
   start_pcap returns ⟺ tcpdump is CONFIRMED capturing. "`exec -d` returning
   proves only that the exec was created; a trigger must never fire into a
   dead capture (silently dropping the network-evidence burst)… On any
   failure raise (→ SensorError → DEFER), never proceed uncaptured."
```

```
 stop_pcap(container)                               sensors.py:688-740
   pkill -TERM tcpdump
     exit != 0 → RuntimeError("tcpdump was not running at stop — capture died
                  mid-run: …")
     INVARIANT (:689-692): tcpdump captured CONTINUOUSLY from start to this
     TERM. A no-match pkill means network evidence was silently lost — a
     SensorError (→ DEFER), "never an empty pcap that could refute."
   THEN the flush barrier (≤ 10 s): poll `pgrep -x tcpdump || true`
     break ONLY when exit_code == 0 AND stdout is empty
     ◀── ":413-415" — a FAILED or timed-out exec also has empty stdout and
         proves nothing; treating that as "exited" would read a torn capture
   timeout → RuntimeError("tcpdump did not flush and exit within 10s of
             SIGTERM")
   base64 -w0 the pcap out; tshark -T json -Y <filter> -2   sensors.py:718
     tshark exit != 0 → RuntimeError("tshark parse failed: …")
     ◀── ":444" — "A failed parse is missing evidence, not absent traffic —
         fail loud."
     ◀── THAT base64 HOP IS NOT FREE, and it reads lossless when it is not.
         `-w0` inflates 4/3, so a pcap over ~7.5 MB used to cross
         docker_exec's old 10 MiB slice while `base64` itself exited 0 —
         which is how a 13,002,771-byte capture arrived as 7,864,320 bytes
         (60.5%) inside an artifact that still said `error: None` and stayed
         SAFE-eligible. See §24.14.
         Since 47b8c15 the transfer RAISES instead of truncating and the cap
         is 64 MiB, so this is loud rather than silent — but the hop itself
         is still here. A binary-safe raw reader exists and round-trips
         8 MiB of /dev/urandom byte-exact; switching this call site to it is
         reported, not applied, because sensors.py was owned by another
         change that round. With the switch, tmpfs ≤ cap makes an over-cap
         whole capture UNREPRESENTABLE rather than merely loud.
```

Every one of those `RuntimeError`s is caught at `observation.py:227-233` /
`:306-313` and turned into a `SensorError`, which the orchestrator maps to
**DEFERRED**. The consistent principle: *missing evidence must never look like
absent behaviour*.

The same principle governs L1 and L4. An unreadable strace log is a
`SensorError` (`observation.py:290-305`). Missing L4 markers are a `SensorError`
whose detail names the suspicion directly: `"L4 trace markers absent from stdout
(instrumentation evaded or suppressed)"` (`observation.py:331-335`). And in the
strace parser, an unmapped syscall is an outright `AssertionError`:

```
 sensors.py:36-42 (comment) and :339-344 (code)
   INVARIANT: every syscall in TRACED_SYSCALLS has an EXPLICIT evidence kind —
   an unmapped traced syscall must fail loud in parse_strace_log, never
   surface to the judge under a fabricated kind.
   assert set(SYSCALL_KIND) == set(TRACED_SYSCALLS), "…drift"   ← at IMPORT
   kind = SYSCALL_KIND.get(syscall)
   if kind is None: raise AssertionError(f"parse_strace_log: syscall '{s}' has
                      no evidence kind — refusing to fabricate one")
```

`SYSCALL_KIND` (`sensors.py:43-65`) collapses syscall families into the
contract's fixed `EventKind` vocabulary (`shared/src/evidence.ts:18-31`) while
preserving the exact syscall in `raw`: `open`→`openat`, `recvfrom`→`read`,
`accept`/`accept4`→`connect`, `clone3`/`fork`/`vfork`→`clone`,
`unlinkat`→`unlink`, `renameat`/`renameat2`→`rename`, `linkat`→`link`.

### 16.6 `dry_run_load` — the cheap pre-flight

```
 LOAD_CHECK_OBSERVE = {kernel:False, network:False, node:True,
                       fsDiff:False, inspector:False}
 LOAD_CHECK_BUDGET  = {"wallMs": 10_000}              observation.py:68-75

 dry_run_load(package_path, experiment, settings) -> RunError | None
                                                      observation.py:113-131
   try:    artifact = await run_under_observation(..., LOAD_CHECK_*)
   except (DockerUnavailableError, RunUnderObservationError): return None
       ◀── best-effort: an unavailable sandbox SKIPS the gate and lets the
           full-oracle run surface real infrastructure faults
   return artifact.error if is_unresolved_module(artifact.error) else None

 is_unresolved_module(error)                          observation.py:78-86
   error is not None
   and error.kind == "CrashError"
   and ("Cannot find module" in error.detail
        or "MODULE_NOT_FOUND" in error.detail)
```

Note this **is** a real container start and a real execution of the trigger —
with only the node sensor and a 10 s budget. The docstring says why the answer is
worth the cost: "we care whether the program-under-test can be *constructed*, not
what it does." It is the only sensible way to detect a bad `require()` path in
model-authored driver or preload code, because that failure is invisible to
`compile_experiment`.

`is_unresolved_module` is deliberately shared by two callers
(`observation.py:80-82`): the hypothesise dry-run gate (a *fixable* bad require →
repair or fail over) and the orchestrator (a module crash at run time → defer,
not refute).

### 16.7 The orchestrator loop

```
 run_orchestrator(graph, *, package_path, artifact_store, log, emitter,
                  stated_purpose, global_budget_ms, settings, llm)
                                                    orchestrator.py:152-305
 started = time.monotonic() ; summary = OrchestratorSummary()
 while (hypothesis := next_open(graph)) is not None:
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ A. BUDGET CHECK                                                :167-177   │
 │    if elapsed_ms > global_budget_ms:                                      │
 │        for every remaining OPEN node:                                     │
 │            transition DEFERRED, by="orchestrator",                        │
 │              reason=f"Analysis budget ({global_budget_ms}ms) exhausted    │
 │                       before this hypothesis was dispatched."             │
 │            summary.deferred += 1 ; emit hypothesis_resolved               │
 │        break                                                              │
 │                                                                           │
 │ B. transition OPEN → IN_PROGRESS, by="orchestrator"            :178       │
 │    summary.dispatched += 1                                                │
 │    if not hypothesis.experiment:                               :180-183   │
 │        raise AssertionError(f"orchestrator: unarmed hypothesis {id}       │
 │          reached dispatch")   ← belt to graph.add's braces                │
 │                                                                           │
 │ C. async with asyncio.timeout(360):                            :185-188   │
 │        result = await run_experiment(hypothesis, package_path,            │
 │                    stated_purpose, settings, llm, graph.audit_id)         │
 │                                                                           │
 │ D. SEAL THE EVIDENCE AND CROSS-CHECK IT                        :189-195   │
 │    artifact_value = result.artifact.model_dump(mode="json",              │
 │                                                exclude_none=False)       │
 │    declared_hash  = artifact_value.pop("contentHash")                    │
 │    stored_hash    = artifact_store.write_artifact(artifact_value)        │
 │    if stored_hash != declared_hash:                                       │
 │        raise RuntimeError(f"artifact hash mismatch: artifact=… store=…")  │
 │    ◀── the artifact hashed ITSELF at seal time (evidence.py:315-320) and  │
 │        the store hashes it AGAIN independently (evidence.py:156-164). The   │
 │        two must agree, or the evidence is not trustworthy.                │
 │                                                                           │
 │ E. PERSIST THE HUMAN-READABLE RECORD                           :287-305   │
 │    log.write(f"timeline-{hypId}.md", result.timeline)                    │
 │    log.write(f"experiment-{hypId}.json", {hypId, confirmed, reason,      │
 │      citedEvents, runId, artifactHash, evidenceRef, wallMs, eventCount,  │
 │      eventSummary, error})                                               │
 │                                                                           │
 │ F. RESOLVE — see the decision table below                      :306-362   │
 └───────────────────────────────────────────────────────────────────────────┘
 emit hypothesis_resolved {hypId, claim, severity, state, by, reason}  :421
 return summary
```

And the resolution decision, which is the single most important branch in the
system:

```
 ┌─ F. THE RESOLUTION DECISION ──────────────────── orchestrator.py:215-256 ─┐
 │                                                                            │
 │ if result.confirmed:                                                       │
 │     transition CONFIRMED, by="worker:experimenter",                        │
 │       reason=result.reason, evidence_refs=[result.evidence_ref]             │
 │     summary.confirmed += 1                                                 │
 │                                                                            │
 │ else:                                                                      │
 │     error_kind       = result.artifact.error.kind if error else None        │
 │     unresolved_module = is_unresolved_module(result.artifact.error)         │
 │                                                                            │
 │     if error_kind in {"SetupError","SensorError","TimeoutError"}            │
 │        or result.judge_failed                                              │
 │        or unresolved_module:                                               │
 │         graph.add_evidence(hypId, [result.evidence_ref])   ← ref, no state  │
 │         reason = ( f"Judge could not evaluate the run: {result.reason}"     │
 │                    if judge_failed                                         │
 │               else f"Program-under-test could not be loaded ({detail})"     │
 │                    if unresolved_module                                    │
 │               else f"Observation incomplete ({error_kind}): {reason}" )     │
 │         transition DEFERRED, by="worker:experimenter", reason=reason        │
 │         summary.deferred += 1                                              │
 │     else:                                                                  │
 │         transition REFUTED, by="worker:experimenter",                      │
 │           reason=result.reason, evidence_refs=[result.evidence_ref]         │
 │         summary.refuted += 1                                               │
 └────────────────────────────────────────────────────────────────────────────┘
```

The carve-out for `unresolved_module` carries its own justification in the code
(`orchestrator.py:226-230`):

> A crash at module resolution means the program-under-test never loaded (e.g. an
> uninstalled dependency), so the suspected path never ran. That is a coverage
> gap, not a refutation — deferring keeps a broken run from laundering an
> unproven suspicion into SAFE.

Note the boundary precisely: `CrashError` is **not** in the defer set. A run that
crashed for some *other* reason — a `TypeError`, a thrown exception, a non-zero
exit from the package's own logic — is still handed to the judge (with a `# note:
run error — CrashError: …` line in the timeline header) and can be REFUTED. The
only crash treated as a coverage gap is the one that proves the program never
existed.

Four exception handlers surround that block, each mapping a class of failure to a
deferral rather than an abort:

```
 except TimeoutError:                                orchestrator.py:257-271
   the per-hypothesis asyncio.timeout(360) fired
   if state is still IN_PROGRESS: DEFER, reason="Observation incomplete
     (per-hypothesis timeout 360s)"
   comment: "an incomplete run must never be laundered into REFUTED/SAFE"

 except (RunUnderObservationError, DockerUnavailableError) as exc:   :272-283
   a known sandbox/infra failure
   DEFER, reason=f"Sandbox unavailable: {exc}" + (f" — {exc.detail}" if any)
   ◀── RunUnderObservationError.detail carries the raw docker stderr
       (observation.py:60-63), so a genuine non-transient failure stays
       diagnosable rather than surfacing as an opaque "Worker error"

 except Exception as exc:                          orchestrator.py:289-308
   UNEXPECTED — a bug or invariant violation
   logger.exception("orchestrator worker error", hyp_id, audit_id, error_type)
   DEFER this ONE hypothesis, reason=f"Internal error ({type}): {exc}"
   comment: "a bug must not clear a suspicion into SAFE, and one bug must not
   abort the sibling hypotheses… so the audit still ERRORs if nothing
   confirms — now with a loud, located cause instead of silence."
```

Every handler is guarded by `if graph.get(hypId).state == "IN_PROGRESS"`, so a
node that already reached a terminal state before the exception is not
transitioned twice (which `transition`'s Guard 1 would reject anyway).

Note what is **not** caught: `asyncio.CancelledError` is a `BaseException` in
modern Python, so a shutdown cancellation propagates out of `run_orchestrator`
and out of `pipeline.run`, and the audit ends with no verdict — which is the
correct outcome.

### 16.8 `run_experiment` and the judge

```
 run_experiment(hypothesis, package_path, stated_purpose, settings, llm,
                audit_id) -> ExperimentResult          orchestrator.py:108-134
   artifact  = await run_under_observation(package_path,
                 hypothesis.experiment, settings,
                 observe=FULL_ORACLE, budget=EXPERIMENT_BUDGET)
   timeline  = render_timeline(artifact)          ← §17.4
   judgment  = await judge_evidence(hypothesis, timeline, stated_purpose,
                                    llm, audit_id)
   reference = EvidenceRef(kind="run", id=artifact.runId,
                           hash=artifact.contentHash)
   return ExperimentResult(judgment.confirmed, judgment.reason,
             judgment.cited_events, judgment.judge_failed,
             artifact, reference, timeline.text)
```

The judge's prompt is assembled at `orchestrator.py:65-79`. Here it is, real, for
`hyp-0008` (`exchanges/050_judge_569de344.json`):

```
 SYSTEM (engine/prompts/judge/v1.md)
 ┌───────────────────────────────────────────────────────────────────────┐
 │ Judge one hypothesis against one observed execution timeline. The      │
 │ package's stated purpose is the benign baseline. Decide only from      │
 │ events in the timeline. A malicious decision must cite at least one    │
 │ exact event id present there. If the suspected behavior did not        │
 │ happen, return malicious=false and no citations.                      │
 └───────────────────────────────────────────────────────────────────────┘
 USER
 ┌───────────────────────────────────────────────────────────────────────┐
 │ ## Stated purpose (benign baseline)                                   │
 │ Smart configuration loader with environment detection                 │
 │                                                                       │
 │ ## Hypothesis hyp-0008                                                │
 │ - claim: cred_theft (gated: docker_gate)                              │
 │ - severity: critical                                                  │
 │ - description: Probe IMDS and exfiltrate all stolen data              │
 │ - suspected code: setup.js:120-120, setup.js:123-123                  │
 │                                                                       │
 │ ## Experiment setup                                                   │
 │ [{"tool":"setEnv","args":{"env":{"NPM_TOKEN":"npm_12345secrettoken",  │
 │   "AWS_ACCESS_KEY_ID":"AKIA123456789","HOME":"/home/node"}}}, …]      │
 │ Setup is test context, not proof. Use it to associate planted canary   │
 │ values with observed events; decide only from the timeline.           │
 │                                                          ◀── CRITICAL │
 │ ## Execution timeline                                                 │
 │ # Timeline — run_e8596819e848454e91d54b5a5e ·                         │
 │   trigger=entrypoint:setup.js                                         │
 │ # setup: env NPM_TOKEN, AWS_ACCESS_KEY_ID, HOME · planted ~/.npmrc,   │
 │   ~/.ssh/id_rsa, ~/.aws/credentials                                   │
 │ … 152 lines …                                                         │
 │                                                                       │
 │ ## Task                                                               │
 │ Did the suspected behavior happen? Cite exact timeline ids for         │
 │ malicious=true.                                                       │
 └───────────────────────────────────────────────────────────────────────┘
```

That one line — "Setup is test context, not proof" — is doing real work. The
setup *describes* an environment where credential theft would be visible; a model
that reasoned "the setup planted an SSH key, therefore theft" would be
confirming its own experiment design. The instruction forces the decision back
onto observed events.

The output schema is minimal (`phases.py:204-209`):

```
 JudgeVerdict (extra="forbid")
   malicious   : bool
   reason      : str
   citedEvents : list[str]
```

And the validator is where the citation discipline is enforced
(`orchestrator.py:81-89`):

```
 validate_verdict(candidate):
   cited = set(candidate.citedEvents)
   if candidate.malicious and not cited:
       CandidateRejected("malicious=true requires at least one cited
                          timeline event")
   unknown = cited - timeline.ids
   if unknown:
       CandidateRejected(f"unknown timeline event ids: {sorted(unknown)}")
       ◀── a HALLUCINATED event id is a rejected candidate, retried
   if not candidate.malicious and cited:
       CandidateRejected("malicious=false must not cite events")
```

Then failure handling and the final mapping (`orchestrator.py:91-105`):

```
 try:    result = await llm.run("judge", …, validate=validate_verdict)
         verdict = JudgeVerdict.model_validate(result.output)
 except Exception as exc:                    ← ANY exception, deliberately broad
         reason  = f"Judge model call failed: {exc}"
         verdict = JudgeVerdict(malicious=False, reason=reason, citedEvents=[])
         return JudgeResult(False, reason, [], judge_failed=True, verdict)
                                                  ◀── judge_failed ⇒ DEFERRED,
                                                      NOT refuted
 cited = [id for id in verdict.citedEvents if id in timeline.ids]
 return JudgeResult(verdict.malicious and bool(cited), verdict.reason, cited,
                    False, verdict)
```

So `confirmed = malicious AND at least one cited id that really exists in the
timeline`. The design spec proposed
`malicious && cited.length > 0 && cited.every(id => timeline.has(id))`
(`docs/specs/2026-07-08-evidence-timeline-judge.md:118`). The code splits that:
the `every` clause is enforced by `validate_verdict` as a *retryable rejection*,
and the final expression is an `exists` filter. The net effect is the same for
any verdict that survives validation, and it is strictly more forgiving of a
model that cites four real ids and one typo — the typo is dropped rather than
failing the whole verdict.

### 16.9 The real judgement of `hyp-0008` — and the six near-misses

```
 exchanges/050_judge_569de344.json → response.choices[0].message.content
 ┌───────────────────────────────────────────────────────────────────────┐
 │ { "citedEvents": ["e147"],                                            │
 │   "malicious":   true,                                                │
 │   "reason": "The hypothesis predicts probing IMDS at                  │
 │     169.254.169.254/latest/meta-data/ and exfiltrating stolen data.   │
 │     Event e147 shows an HTTP GET to that exact endpoint, confirming    │
 │     the IMDS probe. Additionally, events e51–e59 read sensitive files  │
 │     (.npmrc, .ssh/id_rsa, .aws/credentials, etc.), and event e60      │
 │     shows a POST to localhost/exfil, which matches the exfiltration    │
 │     step. The timeline thus shows credential theft and exfiltration    │
 │     as hypothesized." }                                               │
 └───────────────────────────────────────────────────────────────────────┘
        │ malicious=true, cited=["e147"], "e147" ∈ timeline.ids
        ▼
 confirmed = True → graph.transition("hyp-0008", "CONFIRMED",
                      by="worker:experimenter", reason=<the text above>,
                      evidence_refs=[EvidenceRef(kind="run",
                        id="run_e8596819e848454e91d54b5a5e",
                        hash="5033b1e9253fb81bce034a564c19c97c6912522c16f8
                              bf12373ee8bdeab981c0")])
```

And the timeline line it points at (`sandbox/hyp-0008.timeline.txt:153`):

```
 e147  t+2.33s       [L2]  http     GET 169.254.169.254/latest/meta-data/
```

The instructive part is the **thirteen refutations**, because they show the
judge holding a line the system deliberately does not hold for it. Six of the
`setup.js` hypotheses observed essentially the same behaviour and refused to
confirm, because each had specified an endpoint the timeline did not literally
show. From `engine/demo-data/test-pkg-env-exfil.json`, verbatim:

```
 hyp-0001 REFUTED "…Event e61 shows a POST to http://localhost/exfil, not the
   hardcoded URL specified in the hypothesis (http://localhost:9999/exfil*).
   The hypothesis requires the data to be sent to a specific hardcoded URL…"
 hyp-0006 REFUTED "…There is an HTTP POST at event e63 (net POST
   http://localhost/exfil), but the hypothesis specified POST to
   http://localhost:9999/exfil, not to http://localhost/exfil…"
 hyp-0007 REFUTED "…the timeline shows a POST to http://localhost/exfil
   (port 80, not 9999)…"
 hyp-0004 REFUTED "…the timeline does not provide any evidence that the
   CONTENTS of those files were transmitted…the POST request is recorded but
   its payload is not specified…"
 hyp-0005 REFUTED "…there is no evidence of a request to the IMDS…the stub was
   provided but never observed being accessed…"
 hyp-0003 REFUTED "…the POST goes to localhost, which was stubbed by the
   experiment setup…No event in the timeline indicates that data was sent to
   an external, attacker-controlled server…"
```

Two real limitations of the current renderer are visible in that list, and both
are honest to report:

- The L4 `network` event renders as `POST http://localhost/exfil` because the
  monkey patch builds the URL as `proto + "://" + (options.hostname ||
  options.host) + (options.path || "/")`
  (`assets/instrumentation-monkey.js:28`) — it **drops `options.port`**. The
  package really did POST to port 9999. Three judges refuted on that artefact of
  rendering.
- No sensor captures request *bodies*, so "was the canary actually in the
  payload?" is unanswerable from the timeline. `hyp-0004` refuted precisely for
  that reason.

Neither is patched over with a predicate, which is consistent with the design
doc's stance: "If the timeline were not readable enough for the model to tell
those apart, that is a **rendering bug to fix**, not a predicate to add"
(`docs/specs/2026-07-08-evidence-timeline-judge.md:52-53`). Both are listed in
Observations (§24.7, §24.8).

The system survived those six near-misses because HYPOTHESIZE produced **eight**
independent hypotheses from eight flags on the same file, and `hyp-0008`'s
description happened to name a claim the timeline could support literally. That
is redundancy doing its job — and it is also a fragility worth naming (§24.9).

### 16.10 What the `chalk` refutation looks like

For contrast, the SAFE-by-refutation path
(`fixtures/llm/chalk@5.6.2/exchanges/008_judge_be10d815.json`):

```
 hypothesis: browser.js's user-agent inspection could lead to unintended code
             paths or file reads   (claim binary_drop, 1 hypothesis total)
 experiment: [plantFiles /home/node/.npmrc, preload <script>,
              trigger entrypoint source/vendor/supports-color/browser.js]
 artifact:   exitCode 0, error null, 83 events,
             eventSummary{uniqueHosts: [], dnsQueries: [], filesWritten: [],
                          uniqueSyscalls: [clone, execve, openat, read, write]}
 judge:      { "malicious": false, "citedEvents": [],
               "reason": "…the module is loaded (e11), its source file is read
                 (e54), and the process executes normally. No file at
                 /home/node/.npmrc is ever opened, read, or written… The
                 browser.js module's color detection logic is purely
                 computational and does not perform any I/O… Therefore the
                 suspected malicious behavior did not happen." }
 → confirmed=False, error is None, judge_failed=False, unresolved_module=False
 → REFUTED with evidence_refs=[the run]
 → derive_graph_verdict: confirmed 0, deferred 0 → SAFE
   rationale "All 1 suspicion ran and showed no malice."
```

The empty `filesWritten` and empty `uniqueHosts` are what makes that refutation
meaningful: the bait was planted, the run happened, and the trap did not spring.

---

<a name="17-evidence"></a>
## 17. `evidence` — timeline, sealing, content addressing

`engine/npmguard/evidence.py`.

### 17.1 Canonical JSON and content hashing

```
 canonicalize(value)                                  evidence.py:101-111
   _plain(value)   ← recursively model_dump every BaseModel with
                     mode="json", exclude_none=False   (:91-98)
   rfc8785.dumps(value).decode("utf-8")
     ← RFC 8785 JSON Canonicalization Scheme: deterministic key order,
       ECMAScript number/string semantics
   FloatDomainError   → ValueError("non-finite number … not representable")
   IntegerDomainError → ValueError
   CanonicalizationError → TypeError

 sha256_hex(value)     = hashlib.sha256(utf-8 bytes).hexdigest()   :114-115
 content_hash_of(value) = sha256_hex(canonicalize(value))          :118-119
```

Canonicalisation is what makes a content hash *reproducible*. Two processes
serialising the same artifact must produce byte-identical JSON, or the hash — and
therefore the evidence reference — differs for no semantic reason. `exclude_none=
False` is part of that contract: an optional field is always present as `null`,
never omitted.

### 17.2 Sealing an artifact

```
 seal_run_artifact(draft)                             evidence.py:315-320
   parsed = RunArtifact.model_validate({**draft, "contentHash": ""})
   value  = parsed.model_dump(mode="json", exclude_none=False)
   return RunArtifact.model_validate({**value,
     "contentHash": content_hash_of({**value, "contentHash": ""})})
   ⇒ the hash covers the artifact with its OWN hash field blanked, so it is
     self-verifying without circularity.
```

```
┌─ RunArtifact — THE UNIT OF EVIDENCE ────── shared/src/evidence.ts:238-266 ┐
│ the real hyp-0008 values (sandbox/hyp-0008.runartifact.json):             │
│                                                                            │
│ runId          "run_e8596819e848454e91d54b5a5e"                            │
│ triggerUsed    {kind:"entrypoint", target:"setup.js", argv:[], stdin:null} │
│ setupApplied   {env:{AWS_ACCESS_KEY_ID:"AKIA123456789",                    │
│                      HOME:"/home/node", NPM_TOKEN:"npm_12345secrettoken"}, │
│                 date:null, hostname:null, locale:null, patches:[],         │
│                 preloadHash:null,                                          │
│                 plantFiles:[{path:"/home/node/.npmrc",                     │
│                              contentHash:"c05bb95a75c8f7a1…"},             │
│                             {path:"/home/node/.ssh/id_rsa",                │
│                              contentHash:"c6ad3f85dfb118f0…"},             │
│                             {path:"/home/node/.aws/credentials",           │
│                              contentHash:"002cdcfe1257a577…"}],            │
│                 stubUrls:[{pattern:"http://169.254.169.254/latest/         │
│                                     meta-data/*",                          │
│                            responseHash:"68ec80a29d74cc0a…"},              │
│                           {pattern:"http://localhost:9999/exfil",          │
│                            responseHash:"85f7ca40f081a7b8…"}]}             │
│ observe        {kernel:true, network:true, node:true, fsDiff:true,          │
│                 inspector:true}                     ◀── FULL ORACLE, proved│
│ budget         {wallMs:20000, maxSyscalls:null, maxBytesCapture:1000000}   │
│ wallMs         5235                                                        │
│ exitCode       0        timedOut  false        error  null                  │
│ events         192 EvidenceEvents                                          │
│ stdoutHash     "31ecb9545ef326e0246eaf30ee8e2706aa8fc8426350e186a0ab2a936a │
│                 f9b363"                                                    │
│ stderrHash     null      ← nothing was written to stderr                   │
│ fsDiffHash     null      ← the diff was EMPTY: nothing created/modified     │
│ pcapHash       "5302e43fcb35231d0f3c2ac7b22d7c4a44e58f386be5ae947886f03ef5 │
│                 a8a852"                                                    │
│ straceLogHash  "39eea5ee0fe09147ecf6a449527d8816d98e3dedff7e99d9f5251f3b54 │
│                 63a5bd"                                                    │
│ inspectorLogHash null   ← ALWAYS null; observation.py:434 hardcodes it     │
│ eventSummary   {uniqueHosts:["169.254.169.254","localhost"],               │
│                 uniqueSyscalls:["clone","connect","execve","openat",       │
│                                 "read","sendto","write"],                  │
│                 filesWritten:[], dnsQueries:[]}                            │
│ contentHash    "5033b1e9253fb81bce034a564c19c97c6912522c16f8bf12373ee8bdea │
│                 b981c0"    ◀── THE VALUE THAT APPEARS IN EvidenceRef.hash  │
│ createdAt      "2026-07-23T10:12:20.150838Z"                               │
└────────────────────────────────────────────────────────────────────────────┘
```

`eventSummary` is derived by `compute_event_summary` (`evidence.py:286-312`):
`uniqueSyscalls` from any event whose kind is in `SYSCALL_KINDS`
(`evidence.py:61-63`); `uniqueHosts` from L4 `network` URLs (via `urlparse`
hostname) plus L2 `http_request`/`tls_sni` hosts; `filesWritten` from
`write`/`file_created`/`file_modified` paths; `dnsQueries` from `dns_query`
hosts. All four are sorted, so the summary is deterministic.

### 17.3 `ArtifactStore` — content-addressed on disk

```
 ArtifactStore(root_dir)  → self.artifacts_dir = root_dir/"artifacts"
                                                      evidence.py:137-174
   root_dir is the AuditLog run directory (pipeline.py:170), i.e.
   audit-logs/<iso-stamp>_<safe-package-name>/artifacts/

 write_blob(data, ext)   → path = <digest>[.<ext>]; write only if absent
 write_artifact(partial) → validate with contentHash="", hash the blanked
   value, set contentHash, write canonical JSON to <digest>.runartifact.json
 read_artifact(digest)   → RunArtifact.model_validate_json(...)
 verify_artifact(digest) → re-blank contentHash, re-hash, compare to digest
 merkle_root(hashes)     → pairwise sha256(concat), duplicating the last odd
                            leaf; [] → sha256("")                :65-77
```

`merkle_root` exists as infrastructure for aggregate proofs; grep shows no
production caller today. `verify_artifact` likewise is available for auditing a
stored artifact after the fact.

The orchestrator's hash cross-check (§16.7 step D) is what ties this together at
runtime: the artifact hashes itself when sealed, the store hashes it again
independently, and a mismatch raises rather than storing untrustworthy evidence.

### 17.4 `render_timeline` — turning 192 events into something readable

This is the piece the earlier spec was written to introduce, and its rationale is
worth quoting in full because it explains a design philosophy, not just a
function (`docs/specs/2026-07-08-evidence-timeline-judge.md:44-53`):

> The predicate bug (`8af78a7`): `persistence` confirmed on **any** `write()`
> syscall, including the instrumentation's own `write(1, …)` to stdout, so clean
> packages were flagged DANGEROUS.
>
> We do **not** add a guard against that case. We make the timeline genuinely
> readable: a write to stdout renders as `write stdout`; a write to a file
> renders as `write ~/.config/svc.json`. A model reading that will not call a
> stdout write "persistence"… **One general mechanism (readable rendering)
> replaces N special-cased predicates.**

```
 render_timeline(artifact) -> RenderedTimeline{text, ids}   evidence.py:329-424
 ┌───────────────────────────────────────────────────────────────────────┐
 │ home = setupApplied.env["HOME"] or "/home/node"                       │
 │ shorten(v) = "~" + v[len(home):] if v.startswith(home) else v,        │
 │              then truncate at 100 chars with "…"      :330-348, 421-422│
 │                                                                       │
 │ SPLIT the events into two groups, each sorted by timestamp:  :350-357 │
 │   node  = streams starting "L4"       ← logical order, NO clock       │
 │   clock = everything else (L1, L2, L3, engine) ← wall-clock t+        │
 │   ◀── because L4 timestamps are ARRAY INDICES, not times (§16.3)      │
 │                                                                       │
 │ fds = {0:("stdin",False), 1:("stdout",False), 2:("stderr",False)}     │
 │   ← seeded with the three standard descriptors           :358-362     │
 │                                                                       │
 │ rows = _collapse([_describe(e, shorten, fds) for e in group])         │
 │   _collapse (:427-435): consecutive rows with the SAME                │
 │   (tag, verb, target) become one row with count and first/last ts     │
 │                                                                       │
 │ ids are assigned by a single counter across BOTH sections: e1, e2, …  │
 │   and collected into `identifiers`                        :365-373    │
 │   ⇒ the id space is contiguous and every id the judge may cite exists │
 │                                                                       │
 │ node line:  f"{id:<5} {verb:<8} {target}" + "  [x{n}]" if n>1         │
 │ clock line: f"{id:<5} {stamp:<13} [{tag}]   {verb:<8} {target}" + [xn]│
 │   stamp = f"t+{start:.2f}-{end:.2f}s" if n>1 and start!=end           │
 │           else f"t+{start:.2f}s"                                      │
 │                                                                       │
 │ header:  "# Timeline — {runId} · trigger={kind}:{target}"             │
 │          "# setup: env {keys} · planted {paths}"  (or "(none)")       │
 │          "# note: run hit the wall-clock budget (timed out)" if so    │
 │          "# note: run error — {kind}: {detail}"  if error             │
 │ body:    "(no events captured)" if counter == 0, else the two         │
 │          labelled sections                                            │
 └───────────────────────────────────────────────────────────────────────┘
```

**The fd resolution mechanism**, which is the one piece of genuine intelligence
in the renderer (`evidence.py:505-557`):

```
 on kind "openat":  verb="open", target=shorten(path)
                    if int(ret) >= 0:  fds[ret] = (target, False)
 on kind "read"/"write": target = fds.get(fd, (f"fd:{fd or '?'}", False))[0]
 on kind "connect"/"sendto": verb = "connect"|"send"
                    target = f"{addr}:{port or '?'}" if addr
                             else fds.get(fd, ("socket", True))[0]
                    if fd is not None: fds[fd] = (target, True)
 the fd itself is scraped from raw with re.match(r"^\w+\((-?\d+)", raw)  :493-494
```

So `write(1, …)` renders `write stdout`, and `write(5, …)` after
`openat("~/.npmrc") = 5` renders `write ~/.npmrc`. That single mechanism is what
makes the false-positive class impossible without any predicate.

`_describe` (`evidence.py:484-644`) has an explicit arm for every `EventKind` in
the contract. Selected renderings:

| Kind | Renders as |
|---|---|
| `execve` | `exec /usr/local/bin/node ["node","--require",…]` |
| `unlink`/`file_created`/`file_modified`/`file_deleted` | `unlink`/`create`/`modify`/`delete <path>` |
| `rename`/`link` | `rename <from> → <to>` |
| `dns_query` | `dns <host>` |
| `http_request` | `http GET <host><path>` |
| `tls_sni` | `tls <host>` |
| `require` | `require <module>` |
| `env_access` | `env <KEY>` |
| `fs_op` | `fs <path> (readFileSync)` |
| `network` | `net POST <url>` |
| `process` | `spawn <cmd>` |
| `eval` | `eval <code truncated to 100>` |
| `crypto` | `crypto createDecipheriv aes-256-cbc` |
| `timer` | `timer setTimeout 5000` |
| `script_parsed` | `script <source>  [dynamically compiled · {len}c · capped]` |
| `clone` / `setup_bypass` / `truncated` | `clone` / `bypass` / `truncated` |
| `error` | `error <raw truncated>` |

Stream tags are abbreviated: `L1:seccomp`→`L1`, `L2:pcap`→`L2`,
`L3:fsDiff`→`L3`, both L4 streams→`L4`, `engine`→`ENG`
(`evidence.py:495-502`).

**And here is the real output** — the `hyp-0008` timeline, which is the literal
evidence for the `DANGEROUS` verdict. 152 lines; the load-bearing excerpts:

```
 # Timeline — run_e8596819e848454e91d54b5a5e · trigger=entrypoint:setup.js
 # setup: env NPM_TOKEN, AWS_ACCESS_KEY_ID, HOME · planted ~/.npmrc,
   ~/.ssh/id_rsa, ~/.aws/credentials

 ── [L4] node calls — logical order, no clock ──
 e1    require  fs
 e2    require  http
 e3    require  https
 e4    require  child_process
 e5    require  crypto
 e6    require  inspector
 e7    require  module          ◀── e1-e7 are the INSTRUMENT's own requires,
                                    not the package's. Known noise; see §24.10
 e8    script   require("/pkg/setup.js")  [dynamically compiled · 24c]
 e9    script   globalThis.module = module; globalThis.exports = exports; …
                [dynamically compiled · 182c]
 e10   script   require("/pkg/setup.js")  [dynamically compiled · 24c]
 e11   require  /pkg/setup.js   ◀── THE PACKAGE STARTS HERE
 e12   fs       /pkg/setup.js (readFileSync)
 e13   require  http
 e14   require  https
 e15   require  os
 e16   require  fs
 e17   require  path
 e18   env      NPM_TOKEN  [x2]           ◀── the planted canary, READ
 e19   env      npm_config_registry
 e20   env      npm_config__auth
 e21   env      AWS_ACCESS_KEY_ID  [x2]   ◀── the planted canary, READ
 e22   env      AWS_SECRET_ACCESS_KEY
 e23   env      AWS_SESSION_TOKEN
 e24   env      GITHUB_TOKEN
 e25   env      GH_TOKEN
 e26   env      GITLAB_TOKEN
 e27   env      AZURE_CLIENT_SECRET
 e28   env      DOCKER_AUTH_CONFIG
 e29   env      CI
 e30   env      JENKINS_URL
 e31   env      TRAVIS
 e32   env      CIRCLE_TOKEN
 e33   env      HOSTNAME  [x2]
 e34   env      USER
 e35   env      HOME  [x2]
 e36   env      PATH
 e37   env      HOSTNAME
 e38   env      HTTP_PROXY               ◀── e38-e42, e46-e47: the harvester's
 e39   env      HTTPS_PROXY                  own /token|secret|key|…/i regex
 e40   env      https_proxy                  sweeping the proxy variables that
                                              stubUrl used to set (it no longer
                                              sets any — §14.3); the READ is
                                              logged whether or not it is set
 e41   env      NO_PROXY
 e42   env      NPMGUARD_STUB_PORT
 e43   env      NPM_TOKEN
 e44   env      AWS_ACCESS_KEY_ID
 e45   env      HOME
 e46   env      http_proxy
 e47   env      NPMGUARD_STUBS
 e48   env      NODE_VERSION
 e49   env      YARN_VERSION
 e50   env      NODE_ENV
 e51   fs       ~/.npmrc (readFileSync)           ◀── e51-e59: NINE credential
 e52   fs       ~/.yarnrc (readFileSync)              files, read by name
 e53   fs       ~/.ssh/id_rsa (readFileSync)
 e54   fs       ~/.ssh/id_ed25519 (readFileSync)
 e55   fs       ~/.aws/credentials (readFileSync)
 e56   fs       ~/.aws/config (readFileSync)
 e57   fs       ~/.gitconfig (readFileSync)
 e58   fs       ~/.docker/config.json (readFileSync)
 e59   fs       ~/.kube/config (readFileSync)
 e60   net      POST http://localhost/exfil       ◀── the exfil (port dropped)

 ── wall-clock t+ — [L1] syscall · [L2] network · [L3] fs-diff (mtime-coarse) ──
 e61   t+0.19s       [L1]  exec     /usr/local/bin/node ["node", "--require",
                                    "/tmp/_instrument.js", "-e",
                                    "require(\"/pkg/setup.js\")", "--",
                                    "/pkg/setup.js"]
 e62-e93  … loader/libc/cgroup/proc noise …
 e94   t+0.30s       [L1]  open     /pkg/package.json
 e95   t+0.30s       [L1]  open     /tmp/_instrument.js
 e99   t+0.36s       [L1]  open     /pkg/setup.js
 e100  t+0.36-0.36s  [L1]  read     /pkg/setup.js  [x2]
 e106  t+0.37s       [L1]  open     /etc/passwd        ← os.userInfo()
 e108  t+0.37s       [L1]  open     ~/.npmrc           ◀── L1 CORROBORATES L4
 e109  t+0.37-0.37s  [L1]  read     ~/.npmrc  [x2]         at the kernel level
 e110  t+0.37s       [L1]  open     ~/.yarnrc
 e111  t+0.37s       [L1]  open     ~/.ssh/id_rsa
 e112  t+0.37-0.37s  [L1]  read     ~/.ssh/id_rsa  [x2]
 e113  t+0.37s       [L1]  open     ~/.ssh/id_ed25519
 e114  t+0.37s       [L1]  open     ~/.aws/credentials
 e115  t+0.37-0.37s  [L1]  read     ~/.aws/credentials  [x2]
 e116  t+0.37s       [L1]  open     ~/.aws/config
 e117  t+0.37s       [L1]  open     ~/.gitconfig
 e118  t+0.37s       [L1]  open     ~/.docker/config.json
 e119  t+0.37s       [L1]  open     ~/.kube/config
 e121  t+0.38s       [L1]  connect  socket
 e125-e139  … resolv.conf/nsswitch/hosts/gai.conf — DNS resolution …
 e144  t+0.41s       [L1]  write    stdout        ◀── RENDERED AS "stdout",
                                                     not as persistence
 e147  t+2.33s       [L2]  http     GET 169.254.169.254/latest/meta-data/
                                                 ◀── THE CITED EVENT
```

Note how much the reader gets for free. `~/.npmrc` appears twice, once at L4 (a
`readFileSync` call, semantic) and once at L1 (an `openat` + two `read`
syscalls, kernel-level). Two independent sensors corroborate the same act. And
`e144 write stdout` is exactly the event class that used to produce a false
`persistence` confirmation; rendered as `stdout`, no reader mistakes it.

Note also `e51`–`e59` list nine files but only three were planted. The other six
reads failed (the files do not exist) — but the L4 monkey patch logs the *call*,
not the outcome. So the timeline shows intent-to-read for all nine, and L1 shows
`open` for all nine with only the planted three followed by `read`. That
distinction is visible to a careful reader and was, in fact, used by several
judges.

---

<a name="18-the-verdict"></a>
## 18. `derive_graph_verdict` — where the verdict is actually decided

`graph.py:295-331`. Thirty-seven lines. Two assertions. This is the whole verdict
logic.

```
 derive_graph_verdict(graph) -> GraphVerdict
 ┌───────────────────────────────────────────────────────────────────────┐
 │ nodes  = graph.all()                                                  │
 │ counts = HypothesisCounts(total, open, inProgress, confirmed,          │
 │                           refuted, deferred)                          │
 │                                                                       │
 │ ── ASSERTION 1 ──────────────────────────────────────────── :309-312  │
 │ if counts.open or counts.inProgress:                                  │
 │     raise AssertionError(f"derive_graph_verdict: {n} unresolved        │
 │                            node(s)")                                  │
 │   ⇒ NO VERDICT WHILE ANY SUSPICION IS STILL PENDING.                  │
 │                                                                       │
 │ confirmed_ids = [n.hypId for n in nodes if n.state == "CONFIRMED"]     │
 │                                                                       │
 │ ── DANGEROUS ────────────────────────────────────────────── :314-321  │
 │ if counts.confirmed:                                                  │
 │     return GraphVerdict("DANGEROUS",                                  │
 │       f"{n} confirmed hypothes{'esis'|'eses'} with cited dynamic       │
 │        evidence.", counts, confirmed_ids)                             │
 │   ⇒ ANY confirmation wins, regardless of how many deferrals exist.    │
 │                                                                       │
 │ ── ASSERTION 2 ──────────────────────────────────────────── :322-325  │
 │ if counts.deferred:                                                   │
 │     raise AssertionError(f"derive_graph_verdict: SAFE with {n}         │
 │                            unevaluated node(s)")                      │
 │   ⇒ A DEFERRED HYPOTHESIS CAN NEVER PRODUCE SAFE.                     │
 │                                                                       │
 │ ── SAFE ─────────────────────────────────────────────────── :326-331  │
 │ rationale = "No suspicions were raised."  if total == 0                │
 │             else f"All {total} suspicion{s} ran and showed no malice." │
 │ return GraphVerdict("SAFE", rationale, counts, confirmed_ids)          │
 └───────────────────────────────────────────────────────────────────────┘
```

### 18.1 Why a DEFERRED hypothesis can never produce SAFE

Two independent mechanisms enforce this, and understanding both matters because
they operate at different levels.

**Mechanism 1 — the pipeline gate (the reachable path).**

```
 pipeline.py:436-445
 deferred = graph.filter_by_state("DEFERRED")
 if not graph.filter_by_state("CONFIRMED") and deferred:
     details = "; ".join(f"{h.hypId} ({h.resolution.reason if h.resolution
                          else '?'})" for h in deferred[:5])
     raise AuditIncompleteError("orchestrator",
       f"{len(deferred)} hypotheses could not be evaluated (and none
         confirmed): {details}")
 report = _report(graph, flagged.fileSummaries, trace)
```

This runs **before** `_report`, so `derive_graph_verdict` is only ever called in
one of two states: `confirmed >= 1` (any number of deferrals is fine), or
`deferred == 0`. The truth table:

| CONFIRMED | DEFERRED | outcome | verdict |
|---|---|---|---|
| ≥ 1 | 0 | `DANGEROUS` | issued |
| ≥ 1 | ≥ 1 | `DANGEROUS` | issued — a proven attack is not made less proven by an unrelated broken run |
| 0 | 0 | `SAFE` | issued |
| **0** | **≥ 1** | **`AuditIncompleteError`** | **no verdict; `NPMGUARD-0031`, retryable** |

**Mechanism 2 — the assertion (defence in depth).** `graph.py:322-325` is
unreachable *from `AuditPipeline.run`*, precisely because Mechanism 1 fires
first. It exists so that any *other* caller of `derive_graph_verdict` — a test, a
future consumer, a refactor that reorders the pipeline — cannot produce a `SAFE`
with unevaluated nodes. It fails loudly as an `AssertionError`, which
`AuditService._execute` maps to `NPMGUARD-9999`, `retryable=False`
(`service.py:332-333`) — an unmistakable bug signature rather than a silent
downgrade.

Assertion 1 is likewise defence in depth: after `run_orchestrator` returns, every
dispatched node has been transitioned in all branches, and the budget-exhausted
path DEFERs every remaining `OPEN` node before breaking
(`orchestrator.py:167-177`), so no `OPEN` or `IN_PROGRESS` node should survive.

Both assertions are documented in the contract as the intended semantics
(`shared/src/graph.ts:48-54`):

> `DEFERRED` — the run or judge could not complete (machinery broke → the audit
> is an `AuditIncompleteError`, never a verdict)

### 18.2 `_report` — assembling the shipped object

```
 _report(graph, summaries, trace, *, dealbreaker=None)   pipeline.py:122-136
   verdict = derive_graph_verdict(graph)
   AuditReport(
     schemaVersion   = 2,
     verdict         = verdict.verdict,
     rationale       = verdict.rationale,
     counts          = verdict.counts,
     confirmedHypIds = verdict.confirmed_hyp_ids,
     hypotheses      = graph.all(),        ← ALL of them, every state
     fileSummaries   = summaries,
     dealbreaker     = dealbreaker,        ← always None on this path
     trace           = trace)
```

`hypotheses` carries **every** node, including the 13 refuted ones, each with its
`resolution.reason` and `evidenceRefs`. The report is not a list of findings; it
is the complete record of what was suspected, what was run, and what each run
showed. A consumer can reconstruct the entire reasoning chain from it.

The final report for the running example:

```
┌─ AuditReport — test-pkg-env-exfil@2.0.1 ──────────────────────────────────┐
│ schemaVersion   2                                                          │
│ verdict         "DANGEROUS"                                                │
│ rationale       "1 confirmed hypothesis with cited dynamic evidence."      │
│ counts          {total:14, open:0, inProgress:0, confirmed:1,              │
│                  refuted:13, deferred:0}                                   │
│ confirmedHypIds ["hyp-0008"]                                               │
│ hypotheses      14 nodes; hyp-0008 CONFIRMED with                          │
│                   evidenceRefs=[{kind:"run",                               │
│                     id:"run_e8596819e848454e91d54b5a5e",                   │
│                     hash:"5033b1e9253fb81b…"}]                             │
│                   resolvedAt="2026-07-23T23:25:46.569521Z"                 │
│                   resolution={reason:"…Event e147 shows an HTTP GET to     │
│                     that exact endpoint…", by:"worker:experimenter"}       │
│ fileSummaries   2 rows (setup.js, index.js)                                │
│ dealbreaker     null                                                       │
│ trace           6 PhaseLogs: resolve, inventory, intent-extraction, flag,  │
│                  hypothesize, orchestrator                                 │
└────────────────────────────────────────────────────────────────────────────┘
```

### 18.3 What "evidence-bound" means, as a single chain

Putting §11 through §18 together, here is the complete causal chain from source
text to verdict, with nothing omitted. Every arrow is a mechanism that can only
be traversed one way.

```
 [1] setup.js:120,123 exists in a real file on disk
      │  read by run_flag (phases.py:457), numbered, sent to the flag model
      ▼
 [2] FLAG raises a suspicion — Flag{file:"setup.js", lines:["120-120",
     "123-123"], why:"Probes IMDS asynchronously and exfiltrates all stolen
     data — auto-execution on require/import."}
      │  no code path exists from a Flag to a report without a Hypothesis:
      │  run_hypothesize asserts len(hypotheses) == len(flags) (phases.py:797)
      ▼
 [3] HYPOTHESIZE arms it — Hypothesis hyp-0008 with a 4-call experiment
      │  compile_experiment must succeed (experiments.py:612-663)
      │  AND dry_run_load must find no unresolved module
      │      (hypothesis_agent.py:337-343)
      │  graph.add refuses an OPEN node with an empty experiment
      │      (graph.py:100-105); the orchestrator re-asserts at dispatch
      │      (orchestrator.py:180-183)
      ▼
 [4] A REAL CONTAINER RUNS IT — run_e8596819e848454e91d54b5a5e
     bait planted, IMDS stubbed, setup.js required, five sensors recording
      │  the artifact is SEALED: contentHash = sha256(canonical JSON with
      │  contentHash blanked) (evidence.py:315-320)
      │  the store re-hashes independently; a mismatch RAISES
      │      (orchestrator.py:189-195)
      ▼
 [5] 192 events → a rendered timeline with contiguous ids e1..e147
      │  render_timeline returns `ids`, the exact set of citable ids
      │      (evidence.py:323-326, 259-267)
      ▼
 [6] THE JUDGE reads (hypothesis, setup-as-context, timeline) and must point
     at a real line: {"malicious":true, "citedEvents":["e147"], "reason":"…"}
      │  validate_verdict rejects malicious-without-citation and rejects any
      │  id not in timeline.ids (orchestrator.py:81-89)
      │  confirmed = malicious AND ∃ a cited id that exists
      │      (orchestrator.py:104-105)
      ▼
 [7] graph.transition("hyp-0008", "CONFIRMED", evidence_refs=[EvidenceRef])
      │  Guard 2 REFUSES CONFIRMED or REFUTED with zero evidenceRefs
      │      (graph.py:214-217)
      ▼
 [8] derive_graph_verdict: counts.confirmed == 1 → DANGEROUS
      │  Assertion 1: no OPEN/IN_PROGRESS node may exist (graph.py:309-312)
      │  Assertion 2: SAFE with any DEFERRED node is impossible
      │      (graph.py:322-325)
      │  Pipeline gate: 0 confirmed + ≥1 deferred → AuditIncompleteError
      │      (pipeline.py:436-445)
      ▼
 [9] AuditReport{verdict:"DANGEROUS", confirmedHypIds:["hyp-0008"]}
     → save_report to disk → ONE TRANSACTION: row→'done' +
       verdict_reached frame (service.py:284-325)
```

Every link is a *checked* link. Remove step 4 and step 7 refuses to fire. Remove
the citation and step 6 rejects the candidate. Break the sandbox and step 8
raises instead of returning `SAFE`. That is what "evidence-bound" means here: not
that evidence is *attached* to the verdict, but that no code path reaches a
verdict without traversing the evidence.

### 18.4 What would have made `hyp-0008` REFUTED or DEFERRED instead

Same hypothesis, same experiment, counterfactual outcomes. All ten branches are
real code paths.

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ → REFUTED  (contributes to SAFE)                                         │
 │                                                                          │
 │ R1 The judge returns malicious=false.                                    │
 │    e.g. the IMDS GET never appears because probeIMDS timed out. Then     │
 │    confirmed=False, error=None, judge_failed=False,                      │
 │    unresolved_module=False → the else-branch → REFUTED with the run as   │
 │    evidence.                          orchestrator.py:248-256           │
 │                                                                          │
 │ R2 The judge returns malicious=true but citedEvents is empty.            │
 │    validate_verdict rejects it as a candidate; if every retry also       │
 │    fails, kit raises → judge_failed → DEFERRED (not refuted).            │
 │    But a SURVIVING malicious=true whose only cited ids were filtered out │
 │    by `cited = [id for id in citedEvents if id in timeline.ids]` yields  │
 │    confirmed=False with no error → REFUTED.  orchestrator.py:104-105     │
 │                                                                          │
 │ R3 The run crashed with a NON-module CrashError (e.g. a TypeError).      │
 │    error.kind == "CrashError" ∉ {SetupError,SensorError,TimeoutError}    │
 │    and is_unresolved_module is False → REFUTED. The judge still saw the  │
 │    "# note: run error — CrashError: …" header line and decided.          │
 │                                        orchestrator.py:231-236          │
 └──────────────────────────────────────────────────────────────────────────┘
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ → DEFERRED  (blocks SAFE entirely; with 0 confirmed ⇒ audit ERRORS)      │
 │                                                                          │
 │ D1 SetupError — `cp -a /pkg-src/. /pkg/` failed, a plantFiles write      │
 │    failed, the stubUrl proxy did not become ready within 120 s, its      │
 │    redirect could not be installed or did not verify, a stub pattern     │
 │    was out of the redirect's reach, a redirect or the proxy was no       │
 │    longer in force at the end of the run (§14.3), or trigger.kind was    │
 │    "lifecycle"/"bin".                                                    │
 │      observation.py:235-243, 226-232, 241-247; experiments.py:453-590    │
 │                                                                          │
 │ D2 SensorError — tcpdump did not confirm 'listening on' within 15 s;     │
 │    tcpdump was not running at stop; tshark parse failed; the strace log  │
 │    was unreadable; the L4 __NPMGUARD_TRACE__ markers were absent from    │
 │    stdout; the instrumentation file could not be written.                │
 │      sensors.py:557-559, 399-405, 443-445; observation.py:245-255,       │
 │      275-293                                                            │
 │                                                                          │
 │ D3 TimeoutError — the run exceeded EXPERIMENT_BUDGET.wallMs = 20 000 ms; │
 │    the container was killed and a synthetic "truncated" event added.     │
 │      observation.py:265-270                                             │
 │                                                                          │
 │ D4 judge_failed — ANY exception from the judge model call (provider      │
 │    outage, budget, unrepairable output). Note the JudgeVerdict           │
 │    fabricated in that path has malicious=False, but judge_failed=True    │
 │    routes it to DEFER, so a dead judge can never refute.                 │
 │      orchestrator.py:100-103, 231-247                                   │
 │                                                                          │
 │ D5 unresolved_module — CrashError whose detail contains "Cannot find     │
 │    module" or "MODULE_NOT_FOUND": the program never loaded.             │
 │      observation.py:78-86; orchestrator.py:226-241                      │
 │                                                                          │
 │ D6 per-hypothesis timeout — the whole setup+run+judge exceeded           │
 │    PER_HYPOTHESIS_SECONDS = 360.                orchestrator.py:257-271 │
 │                                                                          │
 │ D7 sandbox unavailable — RunUnderObservationError (docker run failed 3×) │
 │    or DockerUnavailableError (no docker binary).                        │
 │      observation.py:199-224; orchestrator.py:272-283                    │
 │                                                                          │
 │ D8 internal error — any other exception, e.g. the artifact hash          │
 │    mismatch at orchestrator.py:193. Logged with a full traceback, then   │
 │    this ONE hypothesis is deferred.             orchestrator.py:284-303 │
 │                                                                          │
 │ D9 global budget exhausted — the orchestrator's elapsed time passed      │
 │    global_budget_ms before this node was ever dispatched.               │
 │      orchestrator.py:167-177                                            │
 └──────────────────────────────────────────────────────────────────────────┘
```

**A committed example of D5.** `engine/tests/fixtures/llm/is-number@7.0.0/` is a
real recorded audit of a genuinely benign package that nonetheless **cannot**
produce `SAFE`. Its `manifest.json` provenance note says so outright:

> Benign integer check; the only is-number run exercising dynamic stages. NOTE:
> recorded run artifacts crashed on a driver-path bug
> (CrashError/Cannot-find-module) which the CURRENT orchestrator DEFERS rather
> than REFUTES — replay reaches `AuditIncompleteError`, not SAFE.

Both artifacts show:

```
 triggerUsed = {kind:"entrypoint", target:"/pkg/npmguard-driver.js"}
 exitCode    = 1
 error       = {kind: "CrashError",
                detail: "node exited 1; stderr: … Error: Cannot find module
                         './/pkg/npmguard-driver.js' …"}
 timeline header: "# note: run error — CrashError: … Cannot find module
                   './/pkg/npmguard-driver.js' …"
 timeline body:   e11 require .//pkg/npmguard-driver.js  ← then nothing
```

Trace it through: `is_unresolved_module` → `True` → both nodes DEFERRED →
`confirmed == 0` and `deferred == 2` → `pipeline.py:437` → `AuditIncompleteError`
→ `NPMGUARD-0031`, `retryable=True`, `audit_error` frame. **A benign package
produces an error rather than a false `SAFE`.** That is the invariant working
exactly as designed, and it is the single clearest demonstration in the
repository.

(The `.//pkg/...` in that recording is a historical bug in the trigger-command
builder. The current `build_trigger_command` uses `posixpath.join("/pkg",
target)`, and `posixpath.join` returns an absolute second argument unchanged, so
today the same input yields `/pkg/npmguard-driver.js`. The fixture's value is now
as a regression corpus for the DEFER path.)

---

<a name="19-the-failure-surface"></a>
## 19. The failure surface — every way this can not produce a verdict

### 19.1 The error taxonomy

`engine/npmguard/errors.py`. All inherit `NpmGuardError(KitError)`, which carries
`code`, `http_status`, `retryable`, an optional `details` dict, and an optional
`stage` (`errors.py:33-46`).

The taxonomy is now **closed and enforced**: `errors.py:32-40` states the invariant
that every declared class is constructed somewhere in `npmguard/`, and
`tests/test_error_taxonomy.py` checks it by reading construction sites out of the
package with `ast` rather than trusting a grep. Three codes that had no producer were
deleted in `b9b805d` and their numbers **reserved, never recycled**, because a
deployed client may still branch on a code string.

| Code | Class | HTTP | Retryable | Constructed where | Meaning |
|---|---|---|---|---|---|
| `NPMGUARD-0001` | `PackageNotFoundError` | 404 | no | `resolve.py:58` | the registry returned 404 for `{name}/{version}` |
| `NPMGUARD-0003` | `PackageTooLargeError` | **413** | no | `pipeline.py:325-328` | more FLAG source files than `max_source_files` allows. A **refusal**, not a truncation — see §24.18. Carries **no `stage`**: inventory succeeded and FLAG never started, so naming either would send a reader to the wrong place (the same reason `QueueFullError` has none) |
| `NPMGUARD-0020` | `DockerUnavailableError` | 503 | yes | `observation.py:209`, `deps.py:165` | the `docker` binary is not on PATH (`FileNotFoundError`) |
| `NPMGUARD-0030` | `AuditTimeoutError` | 504 | yes | `pipeline.py:91` | a `_timed_phase` exceeded its budget; carries `stage=phase` |
| `NPMGUARD-0031` | `AuditIncompleteError` | 503 | yes | 14 sites — see below | the audit could not complete; carries `stage` |
| `NPMGUARD-0040` | `QueueFullError` | 503 | yes | `service.py:76` | ≥ 50 durable `queued` rows |
| `NPMGUARD-9999` | `NpmGuardError` (base) | 500 | no | never constructed | reaches the wire as a literal from the non-`NpmGuardError` fallback (`service.py:332`, `api.py`) |

**Retired — reserved, never recycled** (`errors.py:15-30`). These three rows used to
be in the table above with "Raised where: **nowhere**". They are no longer error
classes at all, so an exhaustive handling table should carry **no** arm for them:

| Retired code | Was | Why it went |
|---|---|---|
| `NPMGUARD-0002` | `ValidationError` | **Unrepresentable**, not merely unraised: request failures are declared as `ApiError{error}` with no `code` field, so a validation code has nowhere to go without a contract change. See §24.11 — the audit routes hand-roll a code-less 400 in `api.py::_body`, and the FastAPI-bound routes that reach `kit_spine`'s handler emit `KIT-0400`. |
| `NPMGUARD-0010` | `LLMUnavailableError` | Its slot is occupied by `AuditIncompleteError`, which carries the stage. Provider exhaustion surfaces as kit's `EndOfRope`/`OutputInvalid` and crosses the wire as `0031`, or as an explicitly degraded intent. |
| `NPMGUARD-0050` | `SessionLimitError` | Its raise site was **provably removed** in `07f46fd`, when the running-count cap became a bounded wait queue plus a fixed worker pool. The admission bound that remains is `QueueFullError` (`0040`). |

`NPMGUARD-0031` is the workhorse. Its **14** construction sites, by stage — note the
three new `inventory` sites, which are the §24.12 fix:

```
 stage="inventory"                                      ← new in 95cfb38 (§24.12)
   inventory.py:267  package.json could not be read: {OSError type}
   inventory.py:273  package.json is not valid JSON: {exc}
   inventory.py:275  package.json is not a JSON object but a {type}

 stage="flag"
   phases.py:402  file escapes package root: {relative}
   phases.py:490  could not analyze {path}: file-unreadable
   phases.py:570  could not analyze {path}: model call failed: {exc}

 stage="hypothesize"
   phases.py:750            could not arm {file} ({why}) after bounded repair: {exc}
   phases.py:757            one-shot experiment for {file} did not load: …
   hypothesis_agent.py:194  agentic build failed to arm {file} ({why}): {exc}
   hypothesis_agent.py:232  proposal did not produce a valid hypothesis: {exc}
   hypothesis_agent.py:401  agent finished without a compiled trigger

 stage="orchestrator"
   pipeline.py:442  {n} hypotheses could not be evaluated (and none
                    confirmed): {hypId (reason); …}   ← at most 5 listed

 stage="shutdown"
   service.py:229, 252  engine stopped
```

The two `shutdown` sites are `fut.set_exception(...)` rather than `raise`, which is
why the enforcing test counts *construction* and not `raise`: `exc = X(); raise exc`
is the same producer, and so is handing the instance to a future.

### 19.2 How a failure becomes an observable

```
 pipeline.run raises
   │  pipeline.py:458-469 — `except BaseException:` → cleanup_package(acquired)
   │  the temp workdir is removed before the exception leaves the pipeline.
   │  BaseException, not Exception: a worker cancelled mid-audit (shutdown) is
   │  the likeliest way out of here, and CancelledError is not an Exception.
   ▼
 AuditService._execute except-block            service.py:330-346
   message   = str(exc) or type(exc).__name__
   code      = exc.code      if NpmGuardError else "NPMGUARD-9999"
   retryable = exc.retryable if NpmGuardError else False
   _finish(audit_id, error=message, event_type="audit_error",
           payload={"error": message, "code": code, "retryable": retryable})
     └─ ONE TRANSACTION: row → status='error', error=message
                       + append the audit_error frame
   log.exception("audit failed", audit_id, package_name, code)
   raise                            ← the worker sets it on the future
   ▼
 THREE observable surfaces
 ┌─ SSE ────────────────────────────────────────────────────────────────────┐
 │ event: audit_error                                                       │
 │ data: {"type":"audit_error","auditId":"…","timestamp":"…","seq":N,       │
 │        "error":"Audit incomplete (orchestrator): 2 hypotheses could not  │
 │                 be evaluated (and none confirmed): hyp-0001 (Program-    │
 │                 under-test could not be loaded (…)); hyp-0002 (…)",      │
 │        "code":"NPMGUARD-0031","retryable":true}                          │
 │ shape: shared/src/events.ts:169-175 — all three fields REQUIRED          │
 │ this is a TERMINAL_EVENT, so the SSE stream returns (events.py:10, 117)  │
 └──────────────────────────────────────────────────────────────────────────┘
 ┌─ the durable row ────────────────────────────────────────────────────────┐
 │ audit_sessions{status:'error', error:<message>, report:NULL}             │
 │ GET /audit/{id}/report → 500 {"error":"Audit failed",                    │
 │                              "message":session.error}   api.py:436-439   │
 └──────────────────────────────────────────────────────────────────────────┘
 ┌─ the synchronous HTTP caller ────────────────────────────────────────────┐
 │ the future's exception surfaces from `await result.future` and           │
 │ _audit_error(exc) renders {"error":"Audit failed", "message", "code",    │
 │ "retryable"} with exc.http_status              api.py:200-209, 287-288   │
 └──────────────────────────────────────────────────────────────────────────┘
```

The crucial property: **no failure path writes a report.** `_finish` is called
with `report=None`, so `audit_sessions.report` stays NULL and no file is written
under `data/reports/`. There is no partial report, no `verdict: "UNKNOWN"`, no
`SAFE`-with-a-warning. The set of things a consumer can receive is exactly:
`{DANGEROUS report, SAFE report, error}`.

`retryable=True` on `NPMGUARD-0031` is meaningful and wired: `submit` accepts a
session in `status == 'error'` and calls `reset_to_queued` to clear the terminal
payload (`service.py:112-117`, `persistence.py:176-192`), so a paid-but-errored
audit is genuinely re-runnable on the same payment claim. This is the argument that
made the §24.12 manifest fix **retryable** rather than non-retryable: a caller can
re-run, and a `latest` request can even resolve to a fixed version in the meantime,
where a non-retryable classification would burn the claim on a package the caller
cannot repair.

### 19.3 The failure map, by phase

```
 PHASE            CAN FAIL WITH                                    RESULT
 ─────────────────────────────────────────────────────────────────────────
 admission        QueueFullError (0040)                            no row
 resolve          PackageNotFoundError (0001)                      error
                  ValueError (tar escape / link escape /
                    ambiguous root / malformed registry JSON)      9999
                  AssertionError (path escapes workdir)            9999
                  AuditTimeoutError("resolve", 240000) (0030)      error
 deps             DockerUnavailableError (0020)                    error
                  everything else → recorded in the event, audit CONTINUES
 inventory        AuditTimeoutError (0030)                         error
                  AuditIncompleteError ×3 (0031) — manifest        error
                    unreadable / not valid JSON / not an object
                    (inventory.py:267, 273, 275)   ← 95cfb38, §24.12
 dealbreaker      — cannot fail; returns DANGEROUS                 report
 size gate        PackageTooLargeError (0003, 413)                 error
                    len(flag_source_files) > max_source_files;
                    OFF by default (max_source_files = 0).
                    Placed AFTER the dealbreaker so a free correct
                    DANGEROUS is never discarded over a size bound,
                    and BEFORE intent so the refusal costs ZERO
                    model calls   (pipeline.py:325-328)  ← 37a6343
 intent           AuditTimeoutError (0030)                         error
                  BudgetExhausted / CancelledError / bugs          propagate
                  EndOfRope / OutputInvalid → fallback_intent(degraded=True)
 flag             AuditIncompleteError ×3 (0031)                   error
                  AuditTimeoutError (0030)                         error
 (zero flags)     — cannot fail; returns SAFE                      report
 hypothesize      AuditIncompleteError ×5 (0031)                   error
                  AuditTimeoutError (0030)                         error
                  BudgetExhausted                                  propagate → 9999
 graph build      HypothesisGraphError (duplicate hypId /
                    missing parent)                                9999
                  AssertionError (unarmed OPEN node)               9999
 orchestrator     AuditIncompleteError (0031) — the deferred gate  error
                  AssertionError (unarmed at dispatch)             9999
                  per-hypothesis failures are ABSORBED as deferrals
 verdict          AssertionError ×2 (unresolved / SAFE-with-
                    deferred)                                      9999
 save_report      UnversionedReportError — CAUGHT, not fatal:      report
                    verdict + row + SSE frame all land; only the
                    data/reports/ file is skipped, loudly
                    (service.py:316-337)          ← 95cfb38, §24.3
 finalize         AssertionError (rowcount != 1)                   9999
```

**Only one shape of "swallowed" is left in that table, and it is the benign one.**
`deps` failures are swallowed *and reported in the event stream*, and the downstream
defer-on-module-crash rule catches the consequence — a coverage gap that is visible
and that blocks `SAFE`.

The row that used to sit beside it no longer exists. An earlier revision of this
section said a malformed `package.json` "is swallowed *silently* into
`package = {}`". That was true when written and is **false now**: since `95cfb38` it
is a loud, located `AuditIncompleteError` at `inventory.py:264-279`, which is why the
`inventory` row above gained three `0031` sites. The correction is recorded rather
than deleted because the reason it survived is the useful part — an audit that
proceeds with *no manifest knowledge at all* still looks complete from the outside,
and both dealbreaker checks pass trivially on empty input, so nothing downstream
could notice. See §24.12.

Note also that `save_report`'s row changed *kind*, not just line number: it used to
be a `9999` that discarded a completed audit, and is now a caught, logged skip. The
half of that trap which is still open — an explicit-version call filing a report
under the caller's guess — is in §24.1, not here, because it produces no failure at
all.

---

<a name="20-events"></a>
## 20. `events` — the SSE wire

`engine/npmguard/events.py`.

### 20.1 Emission

```
 audit_channel(audit_id) = f"audit_{audit_id.replace('-','')}"    events.py:28-31
   ← Kit notifiers need a Postgres-safe identifier, so UUID hyphens are
     stripped; the same durable channel then works for SQLite polling and
     for LISTEN/NOTIFY

 AuditEmitter(audit_id, stream).emit(event_type, payload)         events.py:34-57
   → stream.append(channel, event_type, _json_value(payload or {}))

 _json_value(value)                                              events.py:18-25
   BaseModel → model_dump(mode="json", exclude_none=False)   ← recursively
   dict/list/tuple → mapped
   else → as-is
   ⇒ every Optional engine field reaches the wire as an explicit `null`.
     This is why the shared schemas use .nullable() and never .optional()
     (shared/src/models.ts:87-91).
```

Ordinary frames are appended in their own transaction. Terminal frames are
appended with `session=db` inside `AuditService._finish`'s transaction
(`service.py:269-271`), which is what makes the row transition and the frame
atomic.

### 20.2 Wire framing

```
 _wire_event(audit_id, envelope)                       events.py:60-80
   payload = dict(envelope["data"]) if it is a dict else {}
   return {"type": envelope["type"], "auditId": audit_id,
           "timestamp": envelope["ts"], "seq": envelope["seq"], **payload}
   ⚠ `**payload` comes LAST, so a payload key named type/auditId/timestamp/seq
     would SHADOW the envelope value. No current payload uses those names.
     (§24.13)

 _format_event(audit_id, envelope)                     events.py:83-86
   f"id: {seq}\nevent: {type}\ndata: {compact json}\n\n"
   ⇒ the SSE `id:` field IS the durable sequence number, which is what makes
     Last-Event-ID resumption exact.
```

A real frame, from the running example's recording:

```
 id: 67
 event: verdict_reached
 data: {"type":"verdict_reached","auditId":"b184aed2-cddc-4c14-8c71-
        d9ed27a91cbd","timestamp":"…","seq":67,"verdict":"DANGEROUS",
        "rationale":"1 confirmed hypothesis with cited dynamic evidence.",
        "counts":{"total":14,"open":0,"inProgress":0,"confirmed":1,
        "refuted":13,"deferred":0},"confirmedCount":1}
```

Note `verdict_reached` carries both `counts` (the full object) and
`confirmedCount` (a scalar duplicate of `counts.confirmed`) — the latter for
consumers that want the headline without parsing the object
(`service.py:319-324`).

### 20.3 Reading

```
 sse_events(audit_id, stream, *, after=-1, follow, heartbeat=15)  events.py:89-118
 ┌───────────────────────────────────────────────────────────────────────┐
 │ if not follow:                     ← a FINISHED audit: drain and stop │
 │     cursor = after                                                    │
 │     loop: rows = await stream.read_after(channel, cursor)              │
 │           no rows → return                                            │
 │           yield each formatted; cursor = last seq                      │
 │           len(rows) < READ_BATCH → return                             │
 │                                                                       │
 │ else:                              ← a LIVE audit: follow             │
 │     async for frame in stream.sse(channel, after, heartbeat):          │
 │         frame.startswith(":") → yield the heartbeat verbatim           │
 │         else: parse the `data: ` line, re-frame it, yield              │
 │         if envelope["type"] in TERMINAL_EVENTS: return                 │
 │                    TERMINAL_EVENTS = {verdict_reached, audit_error}    │
 └───────────────────────────────────────────────────────────────────────┘
 route: api.py:371-393
   cursor = int(Last-Event-ID header or ?since= or -1)
   follow = session.status in ("queued","running")
     ◀── 'queued' is included, so a client that connects while the audit is
         still waiting gets a live stream rather than an empty replay
   headers: Cache-Control: no-cache, X-Accel-Buffering: no
```

### 20.4 The complete event vocabulary

`shared/src/events.ts:184-225` declares a discriminated union of **exactly 17**
types, with a comment recording that seven previously-declared members
(`agent_thinking`, `agent_tool_call`, `agent_tool_result`, `agent_reasoning`,
`finding_discovered`, `verify_started`, `verify_test_result`) had zero emit sites
and were deleted: "an unreachable member costs a dead SSE listener, a dead fold
arm, and a reader who must re-derive that it is dead."

| # | type | emitted at | payload |
|---|---|---|---|
| 1 | `audit_enqueued` | `service.py:120-122` | `queuePosition` |
| 2 | `audit_started` | `pipeline.py:172-173` | `packageName` |
| 3 | `phase_started` | `pipeline.py:74`, `:363` | `phase` |
| 4 | `phase_completed` | `pipeline.py:83`, `:378-380` | `phase`, `durationMs` |
| 5 | `dependencies_provisioned` | `pipeline.py:217-226` | `installed`, `packageCount`, `skipped`, `error` |
| 6 | `file_list` | `pipeline.py:252` | `files: FileRecord[]` |
| 7 | `inventory_meta` | `pipeline.py:253-261` | `scripts`, `dependencies` (4 keyed groups), `entryPoints`, `metadata` |
| 8 | `intent_extracted` | `pipeline.py:324-330` | `statedPurpose`, `expectedCapabilities` |
| 9 | `file_analyzing` | `phases.py:478` (flag), `phases.py:768` (hypothesize) | `file` |
| 10 | `triage_progress` | `phases.py:546-549` | `current`, `total`, `file` |
| 11 | `hypothesis_emitted` | `phases.py:780-788` | `hypId`, `claim`, `severity`, `file` |
| 12 | `file_verdict` | `pipeline.py:119` | `verdict: FileVerdict` |
| 13 | `triage_complete` | `pipeline.py:386-401` | `hypothesisCount`, `hypotheses: {hypId,claim,severity,description}[]` |
| 14 | `graph_built` | `pipeline.py:404-408` | `nodeCount`, `addedCount`, `mergedCount` |
| 15 | `hypothesis_resolved` | `orchestrator.py:137-149` | `hypId`, `claim`, `severity`, `state`, `by`, `reason` |
| 16 | `verdict_reached` | `service.py:315-325` | `verdict`, `rationale`, `counts`, `confirmedCount` |
| 17 | `audit_error` | `service.py:184`, `:246`, `:315` | `error`, `code`, `retryable` |

`DependencyGroupsSchema` (`shared/src/events.ts:115-121`) is keyed
(`prod`/`dev`/`optional`/`peer`) rather than an open record, and the comment
records the bug that motivated it: "while this was
`z.record(z.record(z.string()))` the frontend read
`dependencies["dependencies"]`/`["devDependencies"]` — never present — and the UI
reported '0 prod · 0 dev' for every package. An unkeyed map cannot catch that."

---

<a name="21-the-two-report-stores"></a>
## 21. The two report stores

There are **two** places a finished report lives. They hold the same bytes and
are keyed differently, and conflating them is the single easiest way to write a
wrong consumer.

```
╔═ STORE 1: audit_sessions.report ═════════════════════════════════════════════╗
║  WHERE  a JSON column on the SQL row              persistence.py:16-30       ║
║  KEY    audit_id  (a UUID, one per AUDIT ATTEMPT)                            ║
║  WRITTEN by AuditSessionStore.finalize inside _finish's transaction          ║
║           service.py:269-271, persistence.py:210-243                        ║
║  READ   GET /audit/{audit_id}/report              api.py:420-432            ║
║           status queued|running → 202 {"status": …}                          ║
║           report is not None    → 200 the report                            ║
║           else                  → 500 {"error":"Audit failed","message":…}   ║
║  LIFECYCLE tied to the attempt. NULL while running; NULL forever on failure. ║
║  ANSWERS "what did THIS run produce?"                                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

╔═ STORE 2: data/reports/<pkg>/<version>.json ═════════════════════════════════╗
║  WHERE  a file on disk                            report_store.py:12          ║
║           DATA_DIR = (NPMGUARD_DATA_DIR or REPO_ROOT/data)/reports           ║
║  KEY    (package_name, CONCRETE version)  — NOT audit_id                    ║
║  WRITTEN by save_report, BEFORE the row leaves 'running'                     ║
║           service.py:290-292, report_store.py:114-130                          ║
║           ...unless there is no concrete version: then it is SKIPPED, loudly, ║
║           and the audit still completes (service.py:293-314, §24.3)           ║
║  READ   GET /packages          → list_reports()   api.py:598-603            ║
║         GET /package/{name}/report[?version=] → load_report()  api.py:606-620║
║         panel/jobs.py:350 (cache hit for a repo scan)                        ║
║         panel/verdict_index rebuild at boot     api.py:128-147, :787         ║
║  LIFECYCLE persists across audits. A NEW audit of the same (name, version)   ║
║           OVERWRITES it — there is no history.                               ║
║  ANSWERS "what do we know about THIS PACKAGE VERSION?"                       ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

### 21.1 Why the second key is hard, and how `save_report` gets it right

The caller does not know the concrete version. `/audit` accepts an optional
`version`; the pipeline passes `session.requested_version or "latest"`
(`service.py:291`). But `"latest"` is a *moving pointer*, and a file called
`latest.json` would silently rot the instant npm publishes a new release.
`engine/CLAUDE.md:7-8` makes it a house rule: "Reports remain at
`data/reports/<pkg>/<real-version>.json`. The real tarball version is
authoritative; never persist a `latest.json` alias."

```
 save_report(package_name, requested_version, report) -> str
                                                      report_store.py:114-130
 ┌───────────────────────────────────────────────────────────────────────┐
 │ real_version = extract_report_version(value) or requested_version     │
 │                                                                       │
 │ extract_report_version (report_store.py:104-111):                       │
 │   for phase in report["trace"]:                                       │
 │       if phase["phase"] != "inventory": continue                      │
 │       return phase["output"]["metadata"]["version"] if a non-empty str │
 │   ⇒ THE VERSION IS RECOVERED FROM THE TRACE. This is why the inventory │
 │     phase's output_summary embeds the whole metadata object            │
 │     (pipeline.py:244) — it is not decoration, it is the key source.    │
 │                                                                       │
 │ if not real_version or real_version == "latest":                      │
 │     raise UnversionedReportError(f"Cannot save report for {name}: no   │
 │       concrete version in report or request — a latest.json alias must │
 │       never be persisted")                     report_store.py:117-121   │
 │   ◀── a NAMED ValueError subclass (report_store.py:69-78), not a bare  │
 │       one: _under_data_dir's path-escape refusal is ALSO a ValueError,  │
 │       and AuditService._execute must recover from the first while never │
 │       swallowing the second. It cannot tell them apart unnamed.        │
 │   ◀── NOTE THE CONDITION. This fires only when the caller ALREADY      │
 │       admitted it does not know the version. Given an EXPLICIT version │
 │       and a report with no recoverable one, `real_version` is the       │
 │       caller's guess — truthy, not "latest" — so the write SUCCEEDS     │
 │       and files the report under that guess. That is the quiet half of  │
 │       the trap in §21.3, and §24.1 shows it reached by a demo report.   │
 │                                                                       │
 │ ATOMIC WRITE: write <version>.json.tmp, then os.replace → <version>.json│
 │   ⇒ a reader never sees a torn file                                   │
 │                                                                       │
 │ if requested_version not in (real_version, "latest"):                 │
 │     unlink <requested_version>.json, missing_ok=True                  │
 │   ⇒ clean up a stale file written under a different requested key      │
 │                                                                       │
 │ every path goes through _under_data_dir (report_store.py:81-85), which │
 │ resolves and requires the result stay under DATA_DIR, else             │
 │ ValueError("Report path escapes data directory")                      │
 └───────────────────────────────────────────────────────────────────────┘
```

For the running example: `requested_version` is `None` → `"latest"` is passed;
`extract_report_version` finds `"2.0.1"` in the inventory `PhaseLog`; the file is
written to `data/reports/test-pkg-env-exfil/2.0.1.json`.

This is also why the **dealbreaker** path still works: its two-entry trace
contains the inventory phase, so the version is recoverable (§9).

### 21.2 `load_report` — an exact hit is only a fast path

```
 load_report(package_name, version=None)              report_store.py:133-164
   directory missing → None
   version == "latest" → treated as None (a valid request, never a filename)
   if version:
       try <version>.json   ← FAST PATH
       on OSError/JSONDecodeError, FALL THROUGH — do not fail
       then SCAN every *.json in the directory and return the first whose
       extract_report_version(report) == version
       ⇒ handles a report filed under a different name but carrying the
         requested version internally
       nothing → None
   else:
       sort *.json by st_mtime DESCENDING; return the first that parses
       ⇒ "the most recently audited version"
       the returned version is extract_report_version(report) or file.stem
```

`list_reports` (`report_store.py:175-201`) walks `DATA_DIR.rglob("*.json")`,
derives `packageName` from the parent directory relative to `DATA_DIR` (so scoped
packages like `@scope/name` work), skips non-public names via `_public`
(`:106-111` — anything starting `test-pkg-`, `test-package`, or containing
`-bench-`), skips reports with no `verdict`, and returns
`{packageName, version, verdict, auditedAt}` sorted by `auditedAt` descending.
`auditedAt` is the file's **mtime**, not a field in the report.

### 21.3 The trap, stated plainly

```
 ┌─ QUESTION ──────────────────────────┬─ CORRECT STORE ────────────────────┐
 │ "show me the audit I just started"  │ Store 1, by audit_id               │
 │ "did MY audit fail, and why?"       │ Store 1 (report NULL + error text) │
 │ "is chalk@5.6.2 safe?"              │ Store 2, by (name, version)        │
 │ "list everything we have audited"   │ Store 2 (list_reports)             │
 │ "has this dependency been scanned?" │ Store 2 (panel/jobs.py:350 cache)  │
 └─────────────────────────────────────┴────────────────────────────────────┘

 The four asymmetries that bite:
 1. A FAILED audit exists in Store 1 (status='error', report NULL) and NOT AT
    ALL in Store 2. Polling Store 2 for a failure waits forever.
 2. Store 2 has NO audit_id. Given a file you cannot tell which attempt wrote
    it, or when, except by mtime.
 3. Store 2 is keyed on the CONCRETE version. A request for "latest" resolves
    through load_report's mtime scan, which answers "most recently audited",
    not "newest published".
 4. Store 2 is OVERWRITTEN by a re-audit; Store 1 accumulates one row per
    attempt. Store 1 is the history; Store 2 is the current belief.
 5. A SUCCEEDED audit can be absent from Store 2. Since 95cfb38, a report with
    no concrete version is skipped rather than discarding the audit (§24.3), so
    Store 1 holds a DANGEROUS verdict that Store 2 never learns about. This is
    reachable on every local-fixture audit, where ResolvedPackage.version is
    None by design. Treating "absent from Store 2" as "never audited" is
    therefore wrong in both directions: it misses failures (1) and successes.
```

`engine/CLAUDE.md:9-10` states the ownership rule that keeps them distinct: "SQL
owns durable sessions, event replay, LLM capture, and exact-once payment claims.
Do not replace those with process-local maps." And the top-level `CLAUDE.md`
adds: "Keep `engine/npmguard/report_store.py` as the single source of truth — do
not reintroduce IPFS, ENS, or any external pinning service."

---

<a name="22-the-contract-table"></a>
## 22. Who reads what — the contract table

| Consumer | Reads | Field | Cite |
|---|---|---|---|
| Frontend live view | SSE | all 17 event types, by `type` | `shared/src/events.ts:184-225` |
| Frontend resume | SSE | `id:` → `Last-Event-ID` header → `after` cursor | `events.py:86`, `api.py:377-381` |
| Frontend verdict banner | report | `verdict`, `rationale`, `counts` | `shared/src/backend.ts:21-31` |
| Frontend hypothesis list | report | `hypotheses[]` → `state`, `severity`, `description`, `resolution.reason` | `shared/src/graph.ts:83-104` |
| Frontend code viewer | report + HTTP | `fileSummaries[]`; source via `GET /audit/{id}/file/{path}` | `pipeline.py:180`, `api.py:396-417` |
| Frontend file badges | SSE | `file_verdict.verdict` → `capabilities`, `suspiciousLines`, `riskContribution` | `pipeline.py:111-118` |
| Frontend phase progress | SSE | `phase_started`/`phase_completed.phase`, `durationMs` | `pipeline.py:74, 72` |
| CLI | SSE + report | same wire, same terminal semantics | — |
| Repo panel scan cache | Store 2 | `load_report(name, version)` → verdict | `panel/jobs.py:350` |
| Panel verdict index (boot) | Store 2 | `list_reports()` + full report for rationale and confirmed evidence | `api.py:128-147`, `:769` |
| Public package page | Store 2 | `{report, version, packageName}` | `api.py:606-620` |
| Public package list | Store 2 | `{packageName, version, verdict, auditedAt}`, `_public`-filtered | `api.py:598-603` |
| Sync HTTP caller | future | the full report dict, or the mapped error | `api.py:283-285`, `:187-196` |
| CRE (API-key) caller | HTTP 202 | `{status, auditId, packageName, version, queuePosition}` | `api.py:273-283` |
| `report_store.save_report` | report | `trace[phase=="inventory"].output.metadata.version` | `report_store.py:104-111` |
| Judge (LLM) | timeline + hypothesis | `timeline.text` and `timeline.ids`; `claim.kind`, `gating`, `severity`, `description`, `focusLines`, `experiment` | `orchestrator.py:65-79` |
| `graph.transition` | hypothesis | `evidenceRefs` (must be non-empty for CONFIRMED/REFUTED) | `graph.py:214-217` |
| `derive_graph_verdict` | graph | node `state` only — nothing else | `graph.py:295-331` |

The last row is worth dwelling on. The verdict function reads **only** the state
field of each node. Not the claim, not the severity, not the description, not the
evidence. All the meaning has already been forced into `state` by the time it
runs, and the guards on `transition` are what make that state trustworthy. This
is what makes the verdict logic 37 lines long.

---

<a name="23-code-vs-design-docs"></a>
## 23. Where the code diverges from the design docs

The two specs describe the intended shape. Five differences exist between them
and the shipped code. In every case the code is authoritative and the divergence
is deliberate or benign.

**1. `ObserveFlags` was supposed to be deleted; it survived and is used.**

- Spec: "`ObserveFlags` becomes vestigial (full oracle always) — delete or
  default all-on" (`docs/specs/2026-07-10-triage-hypothesis-redesign.md:97`),
  with the technical decision "(a) always all-on, delete `ObserveFlags` ✅…
  the invariant should be structural, not a defaulted flag" (`:137`).
- Code: `ObserveFlags` is a live contract type
  (`shared/src/evidence.ts:165-173`), `DEFAULT_OBSERVE` has **four** of five
  flags off — `kernel`, `network`, `fsDiff` and `inspector`, with only `node`
  on (`observation.py:50-56`) — and `run_under_observation` takes an
  `observe` argument. (An earlier revision of this section said "three of
  five". That was never true; it was four when the sentence was written.
  The conclusion is unaffected, but a reader sizing the default off that
  sentence would get it wrong.)
- Why the code is right: the flags earned a second, genuinely different consumer.
  `dry_run_load` uses `LOAD_CHECK_OBSERVE` — node sensor only, 10 s budget
  (`observation.py:68-75`) — because a load check must be cheap. The full-oracle
  invariant is instead enforced at the *call site*: the orchestrator always
  passes `FULL_ORACLE` (`orchestrator.py:25`, used at `:120`), and every real
  artifact records `observe` so the claim is auditable after the fact
  (`hyp-0008`: all five `true`).

**2. "A hypothesis that can't be evaluated → the audit is an ERROR, not
`DEFERRED`."**

- Spec: `docs/specs/2026-07-10-triage-hypothesis-redesign.md:104`.
- Code: `DEFERRED` is a real, first-class state
  (`shared/src/graph.ts:55-61`, `graph.py:18`) and the orchestrator uses it
  nine ways (§18.4). The *audit* then errors at `pipeline.py:436-445` — but
  **only when nothing confirmed**.
- Why the code is right, and why the difference matters: it is strictly more
  useful. A deferral records *which* hypothesis failed and *why*, in a durable
  node with a `resolution.reason` and often an `evidenceRef`, and the error
  message quotes up to five of them. Aborting at the first failure would lose
  that. Crucially, it also lets an audit that *did* confirm something still
  ship a `DANGEROUS` verdict despite unrelated machinery failures — the spec's
  formulation would have thrown that away.

**3. `claim.kind` was to become "an optional derived display label."**

- Spec: `docs/specs/2026-07-10-triage-hypothesis-redesign.md:96`, `:121`.
- Code: `claim` is a **required** field of `Hypothesis`
  (`shared/src/graph.ts:86`) with a closed 13-value `kind` and a 5-value
  `gating`. But the *behavioural* half of the decision holds completely: nothing
  branches on `claim.kind` anywhere. Its only readers are prompt text
  (`orchestrator.py:72`) and event payloads (`phases.py:784`,
  `pipeline.py:373, 348`, `orchestrator.py:143`).
- Verdict: the dispatch-elimination goal is met; the schema is stricter than the
  spec proposed. `gating` in particular does real work in the prompt, telling the
  judge which evasion the experiment was designed to defeat.

**4. The timeline format is not the one the spec sketched.**

- Spec sketch (`docs/specs/2026-07-08-evidence-timeline-judge.md:80-93`): one
  merged chronological list with a `t+Ns` stamp on every line, including L4.
- Code: **two sections** — `── [L4] node calls — logical order, no clock ──`
  and `── wall-clock t+ — [L1] syscall · [L2] network · [L3] fs-diff
  (mtime-coarse) ──` (`evidence.py:415-423`).
- Why the code is right: L4 timestamps are array indices, not times
  (`evidence.py:226`). Rendering `t+0.00s` next to an L4 event would assert a
  time the sensor never measured. The spec anticipated the problem
  (`docs/specs/2026-07-08-evidence-timeline-judge.md:71-73`, "L4's timestamp is
  a logical index… We do not try to reconcile the clocks") and the code solved
  it by labelling the sections instead of faking a clock. The code also adds
  run-collapsing with `[xN]` (`evidence.py:427-435`), which the spec did not
  describe.

**5. The confirmation mapping is split in two.**

- Spec (`docs/specs/2026-07-08-evidence-timeline-judge.md:118`):
  `confirmed = malicious && citedEvents.length > 0 && citedEvents.every(id =>
  timeline.has(id))`.
- Code: the `every` clause is a *retryable rejection* inside `validate_verdict`
  (`orchestrator.py:85-87`), and the final expression is an `exists`:
  `verdict.malicious and bool(cited)` where `cited` is the filtered subset
  (`orchestrator.py:104-105`).
- Effect: identical for any candidate that survives validation, and more
  forgiving of a model that cites four real ids plus one typo — the typo is
  dropped rather than discarding a correct verdict.

One further note on the earlier spec: it describes a `withCoverageGap` guard that
downgrades a clean `SAFE` to `UNKNOWN`
(`docs/specs/2026-07-08-evidence-timeline-judge.md:184-187`). That mechanism is
**gone**, superseded by the later spec's verdict collapse. `VerdictEnum` has
exactly two values (`shared/src/models.ts:12`) and a coverage gap is now an error
rather than a third verdict. Reading the older spec in isolation will mislead
you.

---

<a name="24-observations"></a>
## 24. Observations

Findings from reading the code and the committed data. Each item states what was
observed, the evidence, and why it might matter.

### 24.0 Status — what has since been fixed, what is tracked, and where this section was wrong

These findings were triaged into the phase plan (design doc **D-9**, goals
G28–G32), not filed. **Read this subsection before trusting any item below.**
Acting on the fixes corrected this section's own analysis in five places and
turned up several defects it missed entirely.

Status is per finding, against **`16426a6`**. "Fixed" means a landed commit plus a
test that fails when the fix is reverted; "tracked" means still true in the code
today; "superseded" means the finding's subject no longer exists in the shape it
described.

| # | Finding (short) | Status | By | What actually happened |
|---|---|---|---|---|
| §24.1 | demo recording is a hybrid of real and curated data | **tracked, now pinned** | `0d73449` | Still a hybrid. Every curated value is now pinned by a test that computes engine truth *from engine code* (not from this doc), with a docstring telling you to delete the test when the recording is re-recorded. A re-record turns red instead of letting a curated value rot into a specification. This section's table was also **missing a divergence** and **named the wrong error** — see the corrections below. |
| §24.2 | demo `riskContribution` for `index.js` contradicts the code | **tracked, now pinned** | `0d73449` | Still `3` in the recording against `8` from `SEVERITY_SCORE` over the recording's own severities. The test now derives `8` independently. |
| §24.3 | a `save_report` `ValueError` becomes a non-retryable `NPMGUARD-9999` | **FIXED** | `95cfb38` | The refusal is now the named `UnversionedReportError` (`report_store.py:81-90`) and `AuditService._execute` catches it (`service.py:316-337`). A completed audit is never discarded over a filing key: the verdict reaches the row and the SSE frame, and only the secondary `data/reports/` file is skipped — never faked as a `latest.json` alias. |
| §24.4 | `timeout_scale` computed over a different file set than FLAG reads | **FIXED** | `95cfb38` | `phases.flag_source_files` (`phases.py:447-462`) is now the single definition of "files this audit will read". `run_flag` fans out over exactly that list (`phases.py:473`) and the pipeline scales its budgets over exactly that list (`pipeline.py:314-319`), so the two cannot denote different sets. Measured on the corpus: the unfiltered list bought 2.05× budget where the real set needs 1.025×. |
| §24.5 | `FileFlagResponse.capabilities` is not deduplicated | **FIXED** | `95cfb38` | Dedup now happens **before** the truncation to 12, so repeats can no longer displace distinct values. The duplication was systematic rather than a one-off: 3 of 4 committed bundles repeat capabilities, `CREDENTIAL_THEFT` up to five times. None reaches the cap, which is exactly why the displacement never bit in the recording. |
| §24.6 | `file_analyzing` means two different things | **tracked** | — | Unchanged: still emitted once per file in FLAG (`phases.py:509`) and once per **flag** in HYPOTHESIZE (`phases.py:799`). |
| §24.7 | the L4 network URL drops the port | **FIXED** | `ced29f2` | The URL now carries the authority the caller requested, port included, and emits a port **only** when one was supplied — inventing `:80` would be the mirror-image mismatch. The method is read off the second argument too, so `request(url, {method:'POST'})` no longer logs as GET. This section's causal account was **incomplete** — see below. |
| §24.8 | no sensor captures request or response bodies | **FIXED for request bodies; the heading is now FALSE as written** | `ced29f2` | Request bodies are captured at L4 — `{method, url, body, bodyBytes}` (`evidence.py:286-297`) — bounded at 2 KiB per request and 64 KiB per run, with `bodyBytes` recording the *true* size so truncation is visible rather than silent. The renderer prints a body preview and names which planted `setupApplied.env` canaries the body or URL carries, with an 8-character floor so `CI=1` cannot be cited as proof (`evidence.py:595-607`). The section's own test question — *"was the canary token actually in the exfiltrated payload?"* — **is** now answerable from the timeline. Three narrower gaps remain and are what §24.8 should say: **response** bodies are never captured at all (the instrument records the call, not its outcome); L2/pcap carries no payloads; and planted **file** contents are still stored as hashes only, so a file canary in a payload remains unmatchable. |
| §24.9 | a single confirmation carries the whole `DANGEROUS` verdict | **tracked (design), 4 factual errors corrected** | `a33f6ec` | The structural point stands: each judge sees one hypothesis and one timeline, and nothing notices cross-hypothesis incoherence. Four of this item's own claims were wrong; they are corrected below and established in [`../specs/2026-07-25-cross-hypothesis-coherence.md`](../specs/2026-07-25-cross-hypothesis-coherence.md). |
| §24.10 | instrumentation `require` noise attributed to the package | **FIXED** | `ced29f2` | The require hook moved into its own fragment (`instrumentation-require-hook.js`), concatenated *after* the instrument's own requires. Order is the mechanism, not a filter, per the evidence-timeline spec. `parse_l4_trace` now **raises** if any require's `from` is the instrument, so a misattributed capability DEFERs with a located cause instead of reaching a verdict. This section **misattributed `module`** — see below. |
| §24.11 | three declared error codes have no raise sites | **FIXED** | `b9b805d` | `NPMGUARD-0002`, `0010` and `0050` are **deleted**, not wired, and their numbers are reserved in a named RETIRED block (`errors.py:15-30`) because a deployed client may still branch on a code string. Enforced by `tests/test_error_taxonomy.py`, which reads construction sites out of the package with `ast` rather than trusting a grep. This item's account of *request* validation was **half wrong** — see below. |
| §24.12 | a malformed `package.json` is silently treated as empty | **FIXED** | `95cfb38` | Now a loud, located `AuditIncompleteError` in `load_manifest` (`inventory.py:238-279`). Two modes that were *worse* than swallowed — invalid UTF-8 and valid-JSON-but-not-an-object — escaped as unmapped non-retryable 500s and are now located too. A BOM-prefixed manifest, which is a valid npm manifest, was silently emptied and now parses. |
| §24.13 | `_wire_event` lets a payload key shadow the envelope | **FIXED** | `95cfb38` | Asserted unreachable at **both** boundaries — producer-side to kill it at birth, reader-side to cover writers that bypass `AuditEmitter` (`service._finish` appends the terminal frame straight to the stream) and rows written by an older engine (`events.py:101-104`). |
| §24.14 | `Budget.maxSyscalls` / `maxBytesCapture` recorded but never enforced | **tracked** — and the *class* was proven live by `47b8c15` | — | Still true, re-verified at `16426a6`: the only occurrences are the declaration in `contract/models.py:92-93` and the `DEFAULT_BUDGET` literal at `observation.py:58`. No reader exists. A sealed artifact still asserts a capture bound the run never applied. |
| §24.15 | `inspectorLogHash` is always `null` | **tracked** | — | Still true: `observation.py:434` passes `None` unconditionally. Structurally unfillable in its current form — the inspector's output is merged into the same stdout blob that `stdoutHash` already covers — so the honest fix is to delete the field, not to fill it. |
| §24.16 | the workdir can leak between `resolve` and the pipeline's `try` | **FIXED** | `95cfb38` | Ownership is now established *at acquisition*: `acquired` is assigned inside the phase operation and the `try` opens before it (`pipeline.py:174-188`), so the handler covers the resolve `PhaseLog` write and `set_package_path`, which used to sit outside it. The handler is `except BaseException` (`pipeline.py:458-469`), which matters more than the disk error the finding described: `except Exception` does not cover cancellation, so **shutdown mid-audit always leaked** — a far likelier path. |
| §24.17 | `add_or_merge` discards the incoming node's experiment | **FIXED** | `ced29f2` | A merge now requires description similarity **and** a byte-identical `experiment` **and** an identical `claim`. Once two nodes ask the same question, one run resolves both, so unioning `focusLines` is honest rather than a coverage claim for something never executed — the invariant holds by construction, with no new state. The survivor also takes the **max** severity; keep-first let a `low` duplicate demote a `critical` out of its dispatch slot. |
| §24.18 | `triage_max_files` is configured but unused | **FIXED twice: by deletion (`b9b805d`), then by building the refusal it argued for (`37a6343`)** | `b9b805d`, `37a6343` | **Eight** settings were dead, not two, and all eight were deleted rather than wired — two named bounds the code actively contradicts. Then `max_source_files` landed as the honest form of the bound: a **refusal** raising `PackageTooLargeError` (`NPMGUARD-0003`, 413) before the first model call, defaulting to `0` = off. This item's cost account also stopped one step short of the real consequence, and its corpus measurement is superseded by a larger independent one. All in §24.18. |
| §24.19 | `Trigger.kind` has two unrunnable values | **tracked** | — | Still true, re-verified: `compile_experiment` accepts `lifecycle` and `bin` (`experiments.py:638`), `build_trigger_command` returns `None` for both (`observation.py:145-146`), and `LifecycleHook` (`shared/src/evidence.ts:86-88`) still has no producer anywhere. This is the open half of **G31**. |

**Defects this section missed entirely.** Each was found by acting on the items
above, and each is larger than most of what the section found.

1. **`stubUrl` never intercepted the running example at all** — now fixed
   (`b1b0a43`). It worked by setting `HTTP_PROXY`/`HTTPS_PROXY`, and Node core's
   `http`/`https` ignore proxy environment variables. The recorded L1 shows it:
   `connect(19, 127.0.0.1:9999) = -1` — the package dialled its real endpoint and
   never touched the proxy on `127.0.0.1:18080`. So
   `setupApplied.stubUrls[].responseHash` attested a canned response that was
   never served, and the experiment's central manipulation silently did not apply.
   Same defect class as §24.14 (a sealed artifact asserting a bound the run never
   applied) but worse, because a hypothesis's logic may *depend* on the stub. The
   three-part fix is detailed in §14.3: a nat REDIRECT in the container's network
   namespace, a `responseHash` read back from the proxy's own **served ledger**
   (`null` when the stub answered nothing, so non-null *is* the statement "this was
   served"), and an unappliable stub raised as a `SetupError` coverage gap that
   bars `REFUTED` without ever blocking detection.
2. **`*` was never a wildcard** — now fixed (`b1b0a43`). `matchStub` escaped every
   regex metacharacter *except* `*`, so the character survived into the compiled
   regex as a quantifier on whatever preceded it:
   `http://169.254.169.254/latest/meta-data/*` meant "…/meta-data" plus
   zero-or-more slashes, and matched no sub-path at all. Every wildcard stub in the
   recorded corpus was inert **twice over**, which is why neither defect was
   noticed — fixing either alone would have changed nothing observable. §14.3's own
   description of the intent was accurate about the intent and wrong about the code.
3. **Two `stubUrl` calls silently dropped the first** — now fixed (`b1b0a43`). The
   stub list rides in one env var, so `compose`'s `envs.update` let the second
   manipulation overwrite the first while `applied.stubUrls` still listed both
   patterns — an artifact naming a stub the proxy never loaded.
   `compile_experiment` now folds every `stubUrl` call into one manipulation, which
   removes the state rather than detecting it.
4. **The L1 peer address was never parsed** — now fixed (`ced29f2`, `67f830f`).
   `re.search(r'sin_addr="([^"]+)"')` matches nothing strace emits; the real form
   is `sin_addr=inet_addr("127.0.0.1")`. Every inet `connect` in the committed
   corpus carries the peer in its `raw` while `addr` is `null`, so the renderer
   printed a bare `connect socket`. It now renders `connect 127.0.0.1:9999`, which
   answers the same three refutations as §24.7 **from an independent sensor**.
5. **`http.get` / `https.get` were invisible at L4** — now fixed (`ced29f2`),
   because Node's `get` calls the module-internal `request()` rather than the
   exported one. `hyp-0008`'s artifact contains exactly one L4 network event; the
   IMDS probe that carried the whole verdict reached the timeline only via pcap.
6. **Seven more parser defects of the same class as #4** — now fixed (`67f830f`),
   found by capturing real producer output *first* and only then reading the
   parser. strace splits a syscall across `<unfinished ...>`/`<... resumed>` and
   **both halves were dropped** (3 of 3 pairs lost in a 165-line trace, including a
   real process spawn); `= -1` was treated as failure although `EINPROGRESS` means
   the connect *succeeded* (113 of 157 connects in the corpus are `-1`);
   `recvfrom`'s peer was never parsed (221 real peers discarded); tshark files DNS
   and HTTP under `mdns`/`llmnr`/`ssdp` layers that match our own filter (6 of 13
   packets tshark itself selected produced zero events); `find -printf` rows were
   split on tabs, so a file named with a tab or newline is invisible to fs-diff —
   a free evasion, not an edge case; `tar c` exits 2 for a missing directory *and*
   writes a valid empty archive, which became
   `DependencyProvision(installed=True, package_count=0)` — success claimed for
   total failure; and npm strips a UTF-8 BOM from `package.json` where
   `json.loads` raises on it, so real dependencies were reported absent. The rule
   is now mechanically enforced: `tools/parser_fixture_lint.py` runs from a test in
   the default suite and requires every external-format shape in `tests/` to appear
   in a committed fixture.
7. **A non-node install hook bypassed the missing-install-script dealbreaker** —
   found by `0d73449`, **now FIXED in `10a288a`**. `{"install": "sh install.sh"}`
   with `install.sh` **absent** yielded no dealbreaker and only an advisory `warn`,
   because `extract_script_file_ref` only read a reference out of a `node …`
   command. The precise unanalysable install-time execution the check exists to
   catch walked through another interpreter.

   **What fixing it turned up is the more useful lesson, and it inverts the
   framing of the original finding.** Measuring before changing anything showed the
   *same* narrowness was calling **14 real, heavily-installed published packages
   DANGEROUS** — a **~6% false-DANGEROUS rate** over the 236 hooked packages among
   1360 manifests on this machine. So the hole and the false positives had **one
   root cause**: a recogniser narrower than the claim it was read as, failing in
   **both** directions at once. Widening the interpreter list first — the obvious
   reading of the original finding — would have multiplied an unmeasured
   false-positive problem.

   The 14, by cause: 11 via `prepare`/`prepublish` running dev scripts their own
   `files` key keeps out of the tarball (npm never runs those hooks for a registry
   tarball installed as a dependency — see §7.1 correction 1); 2 via `protobufjs`'s
   `node scripts/postinstall`, where the file ships as `scripts/postinstall.js` and
   node's extensionless resolution was narrower in the *resolver* than in the
   *loader that decides what actually runs*; 1 via `msw`'s
   `node -e "import(…)"`, where inline code was read as a filename.

   The fix splits one check into **two outcomes for two different facts**: a hook
   naming a file the tarball does not ship (any interpreter, including
   `./install.sh` via its shebang) is a **dealbreaker** — an assertion about the
   *package*; a hook whose code cannot be located at all is a **critical coverage
   gap** — an assertion about *this engine*, carrying no accusation. Measurement
   forced that second branch: unresolvable install hooks are dominated by ordinary
   native-build tooling (`node-gyp rebuild`, `prebuild-install`), so a dealbreaker
   there would condemn every native addon on the registry. After: **zero
   dealbreakers on that corpus, 5 coverage gaps, 231 clean** — and `sh install.sh`
   with the file absent trips. Full account in §7.3.

   Three further recogniser-narrower-than-its-claim defects were found by auditing
   the same family, all fixed: `LIFECYCLE_SCRIPTS` was a `frozenset`, so iteration
   order varied **per process** and reached `entryPoints.install` and therefore the
   hypothesize prompt text — a live fixture-replay hazard; `_exports_entries` did
   not recurse into arrays (140 of 1317 real manifests use npm's array fallback);
   and `.jsx`/`.cts` were absent from the extension map, so those files were
   classified `unknown` and read by no model. One more is reported and **not**
   fixed: 13 of 94 real `bin` targets are extensionless, so a declared executable
   entry point reaches no model (§7.2).
8. **`NPMGUARD_DEMO_SPEED=fast` stops the engine booting** — found by `0d73449`,
   pinned. See the new §24.20: this is one instance of a class this section missed
   completely.
9. **The demo writes its terminal frame durably *before* the report row** — found
   by `0d73449`, the inverse of the real path, where `AuditService._finish` makes
   the report durable first. A Phase-5 gallery that fetches the report when
   `verdict_reached` arrives can observe a non-terminal row.
10. **Two more demo-path gaps** — a malformed recording silently disappears from
    the gallery (`_load` swallows per file with only a log line), and
    `DemoRecording` never loads the recording's own version, so a future
    demo-to-`save_report` route has no honest version to pass.

Two further findings of this class became new items below. **§24.20 undeclared
configuration** has since been **fixed** (`37a6343`) — and fixing it showed the
finding was itself incomplete, because declaring a knob does not make a boot error
name it. **§24.21 dead wire vocabulary** is still open.

**Where this section was wrong** — recorded as corrections rather than silently
revised, because in every case the reason the defect survived is the useful part.

1. **§24.10 misattributes `module`.** Its recorded `from` is `<root>`, not the
   instrument — it is Node's own `-e` bootstrap, and the original instrument
   required `module` *before* installing its hook, so it was never logged at all.
   Six of the seven (`fs`, `http`, `https`, `child_process`, `crypto`,
   `inspector`) genuinely carry `from: /tmp/_instrument.js`; the seventh needed
   different treatment, and is now *annotated* rather than dropped — dropping
   parentless requires would blind the timeline to an evasive
   `Module._load(name, null)`.
2. **§24.7's causal account is incomplete in a way that matters.** L1 also knew
   the endpoint — `htons(9999)` and `inet_addr("127.0.0.1")` are in every
   recorded `raw` — and lost it to the dead regex above. **Two independent
   sensors were understating the same fact**; §24.7 blames only L4.
3. **§24.9 now explains itself.** The reason no other layer could corroborate the
   IMDS GET that carried the whole verdict is that L4 was structurally blind to
   `http.get`.
4. **§24.11's account of request validation is half wrong.** Pydantic's part is
   right; `kit_spine`'s `RequestValidationError` handler is not. That handler
   (`kit_spine/errors.py:90-96`) only fires for routes FastAPI itself binds, and
   the audit routes do **not** bind their bodies that way — `api.py::_body`
   (`api.py:181-197`) reads `await request.json()` and calls `model_validate`
   itself, returning a **hand-rolled, code-less 400**. So a request-validation
   failure on `POST /audit`, `POST /audit/stream` or the checkout route crosses the
   wire as `{"error": "Invalid request", "details": [...]}` with **no `code` field
   at all** — which is why `NPMGUARD-0002` was *unrepresentable* rather than merely
   unraised: `ApiError` is declared as `{error: string}` (`shared/src/panel.ts:531-534`,
   `contract/models.py:20-21`) with nowhere for a code to go. On the FastAPI-bound
   routes that *do* reach the kit handler, the code is `KIT-0400`, not an
   `NPMGUARD-*` value.
5. **§24.18 understates itself 4×, and its cost account stops one step short.**
   **Eight** settings were dead, not two: `triage_max_files`, `max_agent_turns`,
   `investigation_enabled`, `test_gen_model`, `test_gen_mode`,
   `max_findings_to_prove`, `verify_timeout_sec`, `max_docker_exec_timeout_sec`.
   Extending the scope is what let the enforcing test pass with an **empty**
   exemption list. Two of them are not merely unread but **wrong**, so "wire it up"
   was never an option: `max_docker_exec_timeout_sec` defaulted to 30 s beside a
   180 s `docker_exec` npm install in `deps.py`, so wiring it as named would clamp
   dependency provisioning 6×; and `max_agent_turns` defaulted to 30, *above* the
   agent's own computed ceiling of 24. The cost account is corrected in §24.18
   itself: joined to §8.1/§8.2 the real behaviour past the cap is not overspend but
   **total loss of spend**.
6. **§23 claims `DEFAULT_OBSERVE` has "three of five flags off". It has four.**
   `kernel`, `network`, `fsDiff` and `inspector` are all `False`; only `node` is
   `True` (`observation.py:51-57`). This was four at the time the sentence was
   written, so the claim was never true. It does not change §23's conclusion —
   the flags earned a second consumer in `dry_run_load` and the full-oracle
   invariant is enforced at the call site — but a reader counting defaults off this
   sentence would mis-size the default.
7. **§24.8 was wrong about L1 even before the L4 body capture landed.** It said L1
   "records `write`/`sendto` with only an fd". strace runs with **`-s 4096`** and
   the event's `raw` is the verbatim syscall line, so up to 4096 bytes of every
   `write`/`sendto`/`read`/`recvfrom` **buffer** have always been captured into the
   artifact and covered by `straceLogHash` — `sensors.py`'s own docstring quotes a
   real captured `sendto(19, "{\335\1\0…", 47, 0, NULL, 0)`. What was true is that
   the *renderer* never surfaced those bytes. Since `67f830f`, `sendto` and
   `recvfrom` additionally carry a parsed peer `{family, addr, port}`, so "only an
   fd" is now false for them in the normalized event too. The honest framing is
   *captured but unrendered*, which is a materially different defect from *not
   captured* — and it is the same rendering-lottery shape as §24.9's correction 3.
8. **§16.1 documents the L3 `find` command that `67f830f` replaced — i.e. it
   describes the fixed defect as current behaviour.** The doc shows
   `find /pkg /home/node -type f -printf '%p\t%s\t%T@\n' | sort`. The real command
   is `find <paths> -type f -printf '%s\t%T@\t%p\0' | sort -z` — path **last**,
   records **NUL**-terminated, paths `shlex.quote`d. The reversal is the whole
   point of the rewrite: with the path first and tab/newline delimiters, a file
   named with a tab or a newline was silently dropped from the fs-diff, which is a
   free evasion. `parse_snapshot` now asserts rather than skipping.
9. **§16.1 says `TRACED_SYSCALLS` has "20 of them". It has 21** — and the doc's own
   list immediately below it enumerates 21. It was 21 before `67f830f` too, so this
   is a miscount that was never true.
10. **§6 says the archive-cap breach returns `None`. It raises.** `_stream_tar`
    raises `DependencyStreamError("exceeded the 268435456 byte extraction cap")`;
    the caller catches it and surfaces
    `error="node_modules extraction failed: …"`. The distinction matters because
    the doc's version implies a silent value path where the code has an explicit
    typed failure.

**And one claim in this document that was simply false:** an earlier revision of
this section said proxy environment variables are honoured by "`fetch`/undici and
userland clients". Node 22's global `fetch` does **not** honour them — verified in
the sandbox image (`node v22.23.1`): with `HTTP_PROXY`, `http_proxy`, `HTTPS_PROXY`
and `NO_PROXY=""` all set, core `http`, `fetch` and a raw socket every one dialled
the real endpoint and the proxy logged zero requests. The mechanism was inert for
every Node client, not just for core `http`.

One correct fix is written and deliberately **not** landed: `_describe` reuses
the fd table for a `connect` without checking `is_socket`, so an AF_UNIX connect
on a recycled fd inherits a file path (`connect /etc/localtime` — a *false*
target, worse than a vague one). The one-line fix shifts event ids in 9 of 14
`dns-exfil` artifacts, which breaks two judge citations pinned to the old
rendering. That is a legitimate input change, not a bug in the fix — the id count
*shrinks* because two rows correctly collapse into one — but landing it requires
a paid re-record, so it is pinned as `xfail(strict=True)` in `test_evidence.py`
C14b and flips green when the re-record happens. The `sensors.py` fix above
already removes that fallback for every AF_INET/AF_INET6 connect, so the
residual exposure is AF_UNIX only.

**§24.9 is wrong in four places**, established by
[`../specs/2026-07-25-cross-hypothesis-coherence.md`](../specs/2026-07-25-cross-hypothesis-coherence.md)
and worth reading before relying on it:

1. *"thirteen refutations cited the same observed behaviour"* — **impossible by
   contract.** `validate_verdict` (`orchestrator.py:89`) forbids citations on a
   non-malicious verdict, so `citedEvents` is empty on all thirteen. §24.9 names
   the mechanism and its opposite in one breath. Measured on the judges' *prose*
   instead: **8 of 13**. The other five ran against `index.js` on 59–73-row
   timelines with zero egress and zero credential reads, and are honest.
2. *"largely artefacts, not genuine absence of malice"* — **understated.** **Zero
   of seven** were absence of malice: six were decided on facts the sealed
   artifact held and the renderer dropped, one on a fact no sensor captured.
3. *"the redundancy of 8-flags-per-file is what saved the audit"* — **mostly
   wrong, and this is the important correction.** `connect(→169.254.169.254:80)`
   *and* `write(18, "GET /latest/meta-data/ HTTP/1.1…", 82)` appear in **9 of 9**
   `setup.js` artifacts; only **3 of 9** rendered anything at L2. So the decisive
   fact was *universally present and selectively rendered* — a rendering lottery,
   not a framing lottery. `hyp-0001.timeline.txt:126-129` shows the IMDS probe as
   `connect socket` / `write socket` / `read socket`, and `hyp-0005`'s judge wrote
   *"there is no evidence of a request to the IMDS"* while reading those three
   lines. The `sensors.py` fix above collapses that lottery to 9/9.
4. **A defect §24 misses entirely:** the *"setup is test context, not proof"*
   guard (`orchestrator.py:77`) is **one-directional**. It stops a judge
   confirming its own experiment design and says nothing about using the setup to
   *acquit* — `hyp-0002` and `hyp-0003` both did, on the basis of the `stubUrl`
   manipulation that never applied.

And the root cause underneath all of it, which is neither a sensor nor a
renderer: **`JudgeVerdict.malicious` is a `bool`** (`phases.py:204-209`). A judge
that means *"the timeline does not carry the fact this claim turns on"* has no way
to say so, and `orchestrator.py:248-256` launders that answer into `REFUTED`,
which contributes to `SAFE`. Two of the seven refutations say exactly that in
their prose.

> **Still a `bool` on `dev`, and this is the one place not to read ahead.** A
> three-valued `decision` — which would let a judge say "the timeline does not carry
> this fact" as a *third* answer rather than as prose inside a refutation — is built,
> but it lives on branch **`judge-third-answer`** and is **not merged**, because
> landing it changes the judge prompt and therefore needs a paid re-record (the
> fixture loader fails loud by design). So: `malicious: bool` is the current
> contract, `REFUTED` is still where an "I cannot tell" lands, and any reasoning
> about verdict quality on `dev` must assume that. Do not describe the third answer
> as shipped.

Finally, a note on why all of this survived a green suite: **the C2 test in
`test_sensors.py` asserted a line shape strace never emits**
(`sin_addr="1.2.3.4"`). A whitebox test written against an imagined format is
how a dead regex stays green for its whole life — code and test shared one wrong
belief, so they agreed with each other forever. The replacement class uses lines
copied verbatim from a committed artifact's `raw`, `67f830f` added a tier that
runs the real instrument under real node (all three JS defects were unreachable
from Python unit tests), and `tools/parser_fixture_lint.py` now makes the rule
mechanical rather than advisory.

> **Sections that may need another pass.** `evidence.py`, `sensors.py`,
> `phases.py`, `orchestrator.py`, `graph.py`, `inventory.py`, `pipeline.py`,
> `config.py` and `docker.py` were all being modified while this status was
> written, and several landed mid-pass. Everything above is verified against
> **`16426a6`**. Five commits arrived during this pass and each forced a rewrite
> rather than a line-number bump: `47b8c15` (the transfer cap — §16.5, §24.14),
> `a72f1af` (durable verdict domain — G3, phase-0 §B6), `10a288a` (install hooks —
> §7, §24.0 item 7), `37a6343` (`max_source_files` + the config surface — §19.1,
> §19.3, §24.18, §24.20) and `16426a6` (bench v1 deleted — design-doc G22).
> §14.3, §16.1–16.5, §17.4 and §24.8 remain the sections whose subjects move most
> often. One thing deliberately **not** written ahead: the judge's three-valued
> `decision` lives on branch `judge-third-answer` and is not merged, so
> `JudgeVerdict.malicious` is described as the `bool` it still is on `dev`.

### 24.1 The committed demo recording is a hybrid of real and curated data

`engine/demo-data/test-pkg-env-exfil.json` mixes faithfully-recorded engine
output with hand-authored presentation values. `DemoService` replays the recorded
`events` array **verbatim** (`demo.py:107`) and finalises the row with the recorded
`report` (`demo.py:124`), so nothing is regenerated and these values are what a
demo viewer sees.

Faithful (byte-identical to the LLM fixture bundle for prod audit
`b184aed2-cddc-4c14-8c71-d9ed27a91cbd`): `report.verdict`, `rationale`, `counts`,
`confirmedHypIds`, all 14 `hypotheses` including `experiment`, `evidenceRefs`
(`run_e8596819e848454e91d54b5a5e` / `5033b1e925…`), and every
`resolution.reason`.

Curated, and demonstrably not engine output:

| Field | Recording | Engine would produce |
|---|---|---|
| `intent_extracted.expectedCapabilities` | `["FILESYSTEM"]` | `["load configuration files","detect environment variables","parse .env files"]` (`exchanges/001_intent_ea097cd1.json`) |
| `report.fileSummaries[setup.js].capabilities` | `[ENV_VARS, CREDENTIAL_THEFT, NETWORK, FILESYSTEM]` | `[DATA_EXFILTRATION, ENV_VARS, FILESYSTEM, NETWORK, OBFUSCATION, PROCESS_SPAWN, FILESYSTEM, NETWORK]` (`exchanges/003_flag_24133fb1.json`) |
| `report.fileSummaries[setup.js].summary` | one line, 92 chars | the model's four-sentence summary |
| `dependencies_provisioned` | `{installed: true, packageCount: 0, skipped: null}` | `{installed: false, packageCount: 0, skipped: "no runtime dependencies"}` — the package has no `dependencies` key, so `deps.py:128-129` returns exactly that |
| `file_list[].fileType` | `"javascript"` | `"js"` — `EXTENSION_TYPE_MAP[".js"] == "js"` (`inventory.py:20`) and `SOURCE_FILE_TYPES == {"js","ts"}` (`config.py:254`) |
| `file_list[].permissions` | `"0644"` | `"644"` — `format(stat.S_IMODE(info.st_mode), "o")` (`inventory.py:157`) emits no leading zero. Added in this pass; the original table missed it. A consumer parsing the demo's four-character form (or matching on it) breaks on live traffic. |
| `report.trace[].input` / `.output` | `{}` on all six phases | populated summaries |
| `report.trace[].durationMs` | round numbers (1400.0, 320.0, 2100.0, 5200.0, 8600.0, 41800.0) | measured values |
| `file_verdict[index.js].riskContribution` | `3` | `8` — see §24.2 |

Three of these have real consequences. A frontend built against the demo's
`fileType: "javascript"` would not match live traffic, where the value is `"js"`;
the same holds for `permissions: "0644"` against the engine's `"644"`.

And the empty `trace[].output` means `report_store.extract_report_version` returns
`None` for this report — every `trace[].output` is `{}`, so there is no `inventory`
phase carrying `metadata.version`. The demo path never calls `save_report` today
(`DemoService` finalises the row directly), so nothing breaks. A future change that
ran a demo report through `save_report` hits a **two-sided** trap, and the quieter
side is the dangerous one (`report_store.py:126-133`):

- called with `"latest"` or an empty version → raises the named
  `UnversionedReportError` (**not** a bare `ValueError` — renamed in `95cfb38`, see
  §24.3), which is loud and located;
- called with an **explicit** version → `real_version = None or requested_version`
  is truthy and not `"latest"`, so it **silently succeeds** and files the report
  under the caller's guess. A demo report would land in `data/reports/` as though
  it were a real audit of that version.

The second case is the one to guard: the refusal only fires when the caller already
admitted it does not know the version.

### 24.2 The demo's `riskContribution` for `index.js` contradicts the code

`engine/demo-data/test-pkg-env-exfil.json`, `file_verdict` for `index.js`:
`riskContribution: 3`.

`3` is `SEVERITY_SCORE["low"]` (`pipeline.py:53`). But `_emit_file_verdicts`
(`pipeline.py:100-130`) computes `max((node.severity or "medium" for node in nodes),
key=lambda value: SEVERITY_SCORE[value], default="low")` over that file's
hypotheses (`pipeline.py:111-115`), and `index.js`'s six hypotheses in the same
recording are
`hyp-0009 low`, `hyp-0010 high`, `hyp-0011 high`, `hyp-0012 high`,
`hyp-0013 high`, `hyp-0014 low`. The max is `high` → `8`. The frame also carries
six `suspiciousPatterns`, so `nodes` was non-empty and the `if nodes else 0`
branch does not apply. (`setup.js`'s value of `10` is consistent: six `critical`
plus two `high`.) A curated value, per §24.1 — but a UI calibrated on it will
under-report risk for multi-severity files.

### 24.3 A `save_report` `ValueError` becomes a non-retryable `NPMGUARD-9999` — **FIXED (`95cfb38`)**

*As found:* `report_store.save_report` raised a bare `ValueError` when no concrete
version could be determined. It was called from `AuditService._execute` outside any
`NpmGuardError` mapping, so the fallback classified it as `NPMGUARD-9999` with
`retryable=False` and HTTP 500. The audit had *completed* — a verdict computed, the
graph resolved, the evidence sealed — and was then discarded as a non-retryable
server error.

*Why the "in practice unreachable" caveat in the original was wrong.* It said the
inventory `PhaseLog` always carries `metadata.version`, so only a package published
without a `version` field would take this path. In fact
`ResolvedPackage.version` is `None` **by design on every local fixture path**, so
this was reachable on ordinary development and test audits, not just exotic
packages. That is the same mistake in the opposite direction as §24.13's
"latent rather than live".

*Now:* the refusal is the named `UnversionedReportError` (`report_store.py:81-90`),
a `ValueError` subclass so the behaviour is unchanged for anything that was already
catching `ValueError`, but nameable — which matters because `_under_data_dir`'s path-escape
refusal is also a `ValueError` and the one caller that must treat them differently
could not tell them apart. `AuditService._execute` now catches it
(`service.py:316-337`): the verdict reaches the row and the terminal SSE frame, and
only the secondary `data/reports/` file is skipped. It is skipped **loudly** (a
`log.error` naming the audit and package) and never faked as a `latest.json` alias.
See §24.1 for the half of this trap that is still open — an explicit-version call
silently files under the caller's guess.

### 24.4 `timeout_scale` is computed over a different file set than FLAG analyses — **FIXED (`95cfb38`)**

*As found:* the pipeline built its own `sources` list filtering only on `fileType`
and `isBinary`, while `run_flag` additionally applied the noise filter — dropping
`.d.ts`, `test/`, `tests/`, `__tests__/`, `__mocks__/` and `*.test.*`/`*.spec.*`. A
package that is 90% test files therefore received a
`flag`/`hypothesize`/`orchestrator` budget scaled for files that would never be
read.

*Now:* `phases.flag_source_files` (`phases.py:447-462`) is the single definition of
"the files this audit will read". `run_flag` fans out over exactly that list
(`phases.py:473`) and the pipeline scales its budgets over exactly that list
(`pipeline.py:314-319`), so the two cannot denote different sets. The noise filter
is `_noise` at `phases.py:406-413`.

The original's "the error direction is safe (too much budget, not too little)" was
true but incomplete, and the measurement is the interesting part: on the corpus the
unfiltered list bought **2.05×** budget where the real set needs **1.025×**. A
budget inflated 2× is not free — see §24.18 for what over-budgeting actually costs
when the phase does time out.

### 24.5 `FileFlagResponse.capabilities` is not deduplicated — **FIXED (`95cfb38`)**

*As found:* `normalize_bounded_response` filtered to `CAPABILITY_VALUES` and
truncated to 12 but never deduped, and — the part that mattered — the truncation
happened **before** dedup, so repeats could crowd out distinct values. The real
recorded response for `setup.js` (`exchanges/003_flag_24133fb1.json`) contains
`["DATA_EXFILTRATION","ENV_VARS","FILESYSTEM","NETWORK","OBFUSCATION",
"PROCESS_SPAWN","FILESYSTEM","NETWORK"]` — `FILESYSTEM` and `NETWORK` twice.

*Now:* dedup runs before the bound (`phases.py:181-197`), so the 12 slots carry 12
**distinct** capabilities. The duplication turned out to be systematic rather than a
one-off: 3 of 4 committed bundles repeat capabilities, `CREDENTIAL_THEFT` up to five
times in a `dns-exfil` file. None reaches the cap, which is precisely why the
displacement never bit in the recording — the defect was invisible in exactly the
data available to notice it. Duplicates used to flow through
`FileSummary.capabilities` (`phases.py:588`) onto `AuditReport.fileSummaries` and
into the `file_verdict` frame (`pipeline.py:124`, emitted at `:119`).

### 24.6 `file_analyzing` means two different things

`file_analyzing` is emitted once per file during FLAG (`phases.py:509`) and once
per **flag** during HYPOTHESIZE (`phases.py:799`). The running example emits 16:
2 for two files, then 14 for fourteen flags — eight of which name `setup.js`
consecutively. A consumer treating the frame as "starting a new file" will show
`setup.js` opening eight times in a row. `triage_progress` (which carries
`current`/`total`) is only emitted during FLAG (`phases.py:578`); the
hypothesise fan-out has no progress frame, only `hypothesis_emitted` per
completion.

Still open. Nothing in the commits since has touched the frame's two meanings.

### 24.7 The L4 network URL drops the port, and it changed six judgements

`assets/instrumentation-monkey.js:28` builds the logged URL as:

```js
const url = typeof options === 'string' ? options
  : proto + '://' + (options.hostname || options.host) + (options.path || '/');
```

`options.port` is never included. `setup.js` POSTs to
`http://localhost:9999/exfil` (its `exfiltrate` builds `options` from
`new URL(EXFIL_URL)` with `port: url.port`), but the timeline renders
`e60 net POST http://localhost/exfil`
(`sandbox/hyp-0008.timeline.txt:64`).

Three judges cited that exact mismatch as grounds to refute — verbatim from the
recording:

- `hyp-0001`: "Event e61 shows a POST to `http://localhost/exfil`, not the
  hardcoded URL specified in the hypothesis (`http://localhost:9999/exfil*`)."
- `hyp-0006`: "the hypothesis specified POST to `http://localhost:9999/exfil`,
  not to `http://localhost/exfil`. No event matches the suspected endpoint."
- `hyp-0007`: "the timeline shows a POST to `http://localhost/exfil` (port 80,
  not 9999)."

This is precisely the class the design doc calls a rendering bug rather than a
predicate to add (`docs/specs/2026-07-08-evidence-timeline-judge.md:52-53`). It
biases toward false negatives: the judge sees a *less* incriminating URL than the
one the package used.

**FIXED (`ced29f2`).** The URL builder now derives the authority from whichever
shape the caller used — `options.hostname`, a `"host:port"` string split rather
than duplicated or dropped, or a `URL` instance carrying its own authority — and
emits a port **only** when one was supplied
(`assets/instrumentation-monkey.js:146-169`). Synthesising a default `:80`/`:443`
would be the mirror-image mismatch, and the code says so at `:25-37`. The method is
read off the second argument too, so `request(url, {method:'POST'})` no longer logs
as GET. Goal **G28**.

Two things this item got wrong, both recorded in §24.0: its causal account blamed
L4 alone when L1 had the endpoint in every recorded `raw` and lost it to a dead
regex, and the same L4 blindness explains §24.9's missing corroboration.

### 24.8 Request bodies ARE now captured; response bodies and planted-file contents are not

**The original heading — "No sensor captures request or response bodies" — is no
longer true, and the sentence that made it concrete is now false.** It said "was the
canary token actually in the exfiltrated payload?" is not answerable from any
timeline. It is.

*As found, and one part of it was never right.* L4 recorded `{method, url}` only;
L2 records `{host, method, path}` from tshark's HTTP dissector; and L1 was described
as recording `write`/`sendto` "with only an fd". That last claim was **wrong even
then**: strace runs with `-s 4096` and an L1 event's `raw` is the verbatim syscall
line, so up to 4096 bytes of every `write`/`sendto`/`read`/`recvfrom` **buffer** have
always been captured into the artifact and covered by `straceLogHash` —
`sensors.py`'s own docstring quotes a real captured
`sendto(19, "{\335\1\0…", 47, 0, NULL, 0)`. What was true is that the *renderer*
never surfaced those bytes. *Captured but unrendered* is a materially different
defect from *not captured*, and it is the same shape as §24.9's correction 3: the
fact was in the sealed artifact and the timeline dropped it.

*Now* (`ced29f2`): L4 records `{method, url, body, bodyBytes}`
(`evidence.py:286-297`). `body` is a captured prefix bounded at 2 KiB per request
and 64 KiB per run (`assets/instrumentation-monkey.js:141-143`, wrapping
`ClientRequest.write`/`end` at `:78-104`); `bodyBytes` is the **true** submitted
size, so `len(body) < bodyBytes` means truncated and `bodyBytes == 0` means no body
— truncation is visible rather than silent. The renderer prints a bounded preview
and appends `· carries planted env <KEYS>` for any `setupApplied.env` value found in
the URL or body (`evidence.py:595-607`), with an 8-character floor so a value like
`CI=1` cannot be cited as proof. Goal **G29**. Since `67f830f`, `sendto` and
`recvfrom` also carry a parsed peer `{family, addr, port}`, so "only an fd" is false
for them in the normalized event too.

`hyp-0004`'s refutation — "the timeline does not provide any evidence that the
contents of those files were transmitted to the exfiltration endpoint; the POST
request is recorded but its payload is not specified" — stays valid as history. The
gap it names is closed.

**Three narrower gaps remain, and they are what this item now asserts:**

1. **Response bodies are never captured at all.** The instrument records the call,
   not its outcome.
2. **L2/pcap carries no payloads.** tshark is filtered to
   `dns.qry.name or http.request or tls.handshake.extensions_server_name`.
3. **Planted *file* contents are still hashes only**
   (`shared/src/evidence.ts:119-124`), so a canary planted in a *file* and then
   exfiltrated cannot be correlated — only `setupApplied.env` canaries can. Tracked.

One detail of the original's last sentence was also wrong: the stub proxy does
**not** receive-and-discard the body. It never reads the request body at all — there
is no `request.on('data')` in `assets/stub-proxy.js`. It logs
`method + url + stub#/reject` to stderr and records
`{stub, method, url, status, responseHash}` to the served ledger
(`assets/stub-proxy.js:96-125`).

### 24.9 A single confirmation carries the whole `DANGEROUS` verdict

Of eight hypotheses on `setup.js`, seven were refuted and one confirmed. The
seven refutations were largely artefacts (§24.7, §24.8), not genuine absence of
malice — the timeline plainly shows nine credential files read and an HTTP POST.
The verdict was correct because `hyp-0008` happened to be phrased around the IMDS
GET, which the L2 pcap sensor rendered with a literal host the judge could match.
The redundancy of 8-flags-per-file is what saved the audit; a slightly different
FLAG output could have produced 8 refutations and a `SAFE` verdict on live
malware. Nothing in the code notices that thirteen refutations cited the same
observed behaviour, and the founding rule offers no cross-hypothesis check: each
judge sees one hypothesis and one timeline, by design
(`docs/specs/2026-07-08-evidence-timeline-judge.md:157`, "One judge per run").

### 24.10 Instrumentation `require` noise is attributed to the package — **FIXED (`ced29f2`)**

*As found:* the instrument installed the `Module._resolveFilename` hook **before**
requiring its own dependencies, so `fs`, `http`, `https`, `child_process`, `crypto`,
`inspector` and `module` appeared as `require` events at the head of every timeline
(`e1`–`e7` in `hyp-0008`), as though the package required them. Not cosmetic: a
judge weights `child_process` and `crypto` as capabilities, so the timeline claimed
the package reached for tools it never touched.

*Now:* the hook lives in its own fragment, `assets/instrumentation-require-hook.js`,
which `docker.instrumentation_source` concatenates **after** the monkey patches and
the optional inspector — so everything the instrument requires for itself is already
resolved before the hook exists, and the first `require` event in a trace is the
package's own. Order is the mechanism, not a filter, which is what the spec
specified (`docs/specs/2026-07-08-evidence-timeline-judge.md:199-204`). The
engine-side counterpart is load-bearing: `evidence.parse_l4_trace` **raises** if any
`require` event's `from` is the instrument, so re-ordering the fragment fails loud
instead of silently misattributing capabilities again, and a misattributed capability
DEFERs with a located cause rather than reaching a verdict.

**This item misattributed one of the seven.** `module`'s recorded `from` is `<root>`,
not the instrument — it is Node's own `-e` bootstrap. The original instrument
required `module` *before* installing its hook, so it was never logged at all. Six of
the seven genuinely carry `from: /tmp/_instrument.js`; the seventh is now
**annotated** rather than dropped, because dropping parentless requires would blind
the timeline to an evasive `Module._load(name, null)`
(`assets/instrumentation-require-hook.js:23` records `'<root>'` explicitly).

### 24.11 Three declared error codes have no raise sites — **FIXED by deletion (`b9b805d`)**

*As found:* nothing constructed `ValidationError` (`NPMGUARD-0002`),
`LLMUnavailableError` (`NPMGUARD-0010`) or `SessionLimitError` (`NPMGUARD-0050`), so
a consumer building an exhaustive code-handling table carried three dead branches.

*Now:* all three classes are **deleted**, not wired. Their numbers are **reserved and
never recycled**, in a named RETIRED block with the reason each went
(`errors.py:15-30`), because a deployed client may still branch on a code string.
Each deletion rested on three independent arguments rather than one grep: an `ast`
scan for *construction* (not `raise` — `exc = X(); raise exc` is the same producer),
an execution probe (each `__init__` made to raise, then the full default suite and
the e2e tier run), and a per-class argument. Enforced going forward by
`tests/test_error_taxonomy.py`: the taxonomy is closed, every concrete class has a
producer, and retired codes appear nowhere executable.

**This item's account of request validation was half wrong**, and the correct version
is what made `0002` deletable rather than wireable. Pydantic's part is right;
`kit_spine`'s `RequestValidationError` handler is not the mechanism on these routes.
That handler (`kit_spine/errors.py:90-96`) only fires for routes **FastAPI itself
binds**, and the audit routes do not bind their bodies that way — `api.py::_body`
(`api.py:181-197`) reads `await request.json()` and calls `model_validate` itself,
returning a **hand-rolled, code-less 400**:

```python
except PydanticValidationError as exc:
    return None, JSONResponse(
        {"error": "Invalid request", "details": exc.errors(...)}, status_code=400
    )
```

Used by `POST /audit` (`api.py:262`), `POST /audit/stream` (`:293`) and the checkout
route (`:441`). So a request-validation failure on those routes crosses the wire with
**no `code` field at all** — which is why `NPMGUARD-0002` was *unrepresentable*
rather than merely unraised: `ApiError` is declared as `{error: string}`
(`shared/src/panel.ts:531-534`, `contract/models.py:20-21`) and there is nowhere for
a code to go without a contract change. On the FastAPI-bound routes that *do* reach
the kit handler, the code is `KIT-0400` — a kit code, never an `NPMGUARD-*` value.

Note in passing: `_body`'s Pydantic branch also emits a `details` key that `ApiError`
does not declare. Zod's default object parse strips unknown keys rather than
failing, so no client breaks — but the wire carries a field the contract does not
describe.

### 24.12 A malformed `package.json` is silently treated as empty — **FIXED (`95cfb38`)**

*As found* (`inventory.py:237-241` at the time):

```python
try:
    package = json.loads((package_path / "package.json").read_text("utf-8"))
except (OSError, json.JSONDecodeError):
    package = {}
```

The audit continued with no name, no version, no scripts, no entry points and no
dependencies — and **both dealbreaker checks passing trivially** on empty input
(`scripts` empty, `install` empty), which can only bias toward `SAFE`. An
unparseable manifest is a strictly larger coverage gap than an unreadable source
file, and it was the only one of three comparable gaps that was swallowed: an
unreadable source file already raised, and an ambiguous tarball root was already
checked.

*Now:* `load_manifest` (`inventory.py:238-279`) fails loud and located, raising
`AuditIncompleteError("inventory", …)` — `NPMGUARD-0031`, retryable — at three
points:

```
 inventory.py:267   package.json could not be read: {OSError type}
 inventory.py:273   package.json is not valid JSON: {exc}
 inventory.py:275   package.json is not a JSON object but a {type}
```

Two of those modes were **worse than swallowed** before: invalid UTF-8 and
valid-JSON-but-not-an-object escaped as unmapped non-retryable 500s
(`NPMGUARD-9999`). And a BOM-prefixed manifest — which npm accepts, since npm strips
the BOM itself — was silently emptied and now parses, because `json.loads` is handed
**bytes** on purpose so it does the encoding detection.

Retryable rather than non-retryable is a deliberate choice recorded at the site: the
gap is the same size as an unreadable source file, `0031` already denotes "could not
read this input", nothing auto-retries, and a non-retryable classification would burn
a paid claim on a package the caller cannot repair.

The `main` default this item cites downstream is now `inventory.py:114`; the
comparison cases are `phases.py:490` (unreadable source file) and `resolve.py`'s
ambiguous-root check. The `save_report` half of the downstream chain is §24.3, now
also fixed.

### 24.13 `_wire_event` lets a payload key shadow the envelope — **FIXED (`95cfb38`)**

*As found:* `_wire_event` spread `**payload` **after** `type`, `auditId`, `timestamp`
and `seq`, so a payload containing any of those four names would override the
envelope's value — including `type`, the SSE union discriminator.

*Now:* asserted unreachable at **both** boundaries. The envelope keys are a named set
and `_wire_event` asserts the payload cannot intersect it (`events.py:101-104`), naming
the offending seq, type, audit and field on failure. Producer-side to kill it at
birth; reader-side because a row can reach the wire from a writer that never went
through `AuditEmitter` — `service._finish` appends the terminal frame straight to the
stream — or from an older engine that wrote the row.

**This item's "latent rather than live" was the wrong reason to relax.** It verified
that no *current* emit site uses those names, which is a property of today's
producers, not of the reader. The reader also serves durable rows written by past
engines and by non-`AuditEmitter` writers, and neither is covered by that check. That
is exactly why the fix asserts on the read side too.

### 24.14 `Budget.maxSyscalls` and `maxBytesCapture` are recorded but never enforced

`DEFAULT_BUDGET = {"wallMs": 60_000, "maxSyscalls": None, "maxBytesCapture":
1_000_000}` (`observation.py:58`), and both fields are sealed into every artifact
(`hyp-0008`: `maxSyscalls: null`, `maxBytesCapture: 1000000`). Re-verified at
`1002b5b`: the only occurrences of either name in the whole tree are that literal
and the contract declaration (`contract/models.py:92-93`). No reader exists. The
caps that actually exist are unrelated to them: `docker_exec` bounds each stream at
**64 MiB** and **raises** rather than truncating (`docker.py:127`, `MAX_EXEC_OUTPUT_BYTES`
— see below), and `deps._stream_tar` caps the dependency archive at 256 MiB (`deps.py:20`). So an artifact asserts a capture bound the run
never applied.

**Still open.** Note that this is the same defect class as the `stubUrl`
`responseHash` defect in §24.0 — a sealed artifact making a statement about a run
that the run never made — and that one was judged the larger of the two because a
hypothesis's logic can *depend* on a stub. The `responseHash` half was fixed by
making the field a fact read back from the run; the honest fix here is the same
shape or deletion, not a new enforcement path. It is also a live counterexample to
**G31** in the *artifact* vocabulary rather than the wire vocabulary.

**And the class stopped being hypothetical.** `47b8c15` proved this exact failure
against real docker, on a cap that *did* exist rather than one that did not: a
**13,002,771-byte** packet capture in the container arrived as **7,864,320 bytes** on
the host — **60.5%** — with hashes differing, `artifact.error: None`, and **zero
truncation rows**. So the sealed artifact attested a full capture over 60% of one and
**remained `SAFE`-eligible**. The mechanism was `base64 -w0` inflating 4/3, so any
capture over roughly 7.5 MB crossed the old 10 MiB slice while `base64` itself exited
0. Two properties of the old cap are worth recording because they invert the intuition
that a cap is a safety feature:

- **It protected nothing.** `communicate()` had already buffered the whole stream, and
  the slice was applied to the finished copy — so it was pure corruption with **no
  memory bound at all**.
- **A silent prefix is worse than a loud failure**, because a prefix is
  indistinguishable from a complete stream at every later boundary. The new cap bounds
  each stream *while reading* in 256 KiB chunks, and on breach kills the producer,
  drains to EOF so no pipe fd leaks, and raises naming the stream, bytes read, cap and
  exact docker command. Two outcomes remain — both streams are the process's complete
  output, or `timedOut` marks it cut short. A prefix is no longer one of them.

The new bound is **64 MiB**, chosen structurally rather than by taste and coupled by
an import-time assert (`docker.py:208-211`): every file a sensor reads back lives on
the container's 64 MiB `/tmp` tmpfs, so a *whole* sensor file transferred **raw** can
never hit the cap, and only an encoding hop can. That makes the two numbers a stated
relationship instead of two constants edited for different reasons in different files.

### 24.15 `inspectorLogHash` is always `null`

`observation.py:434` passes `"inspectorLogHash": None` unconditionally, even
though `observe.inspector` is `true` on every full-oracle run and inspector
events *are* collected (three `script_parsed` events in `hyp-0008`). The other
five sensor hashes are computed from their raw sources
(`stdoutHash`, `stderrHash`, `fsDiffHash`, `pcapHash`, `straceLogHash`). The
inspector's raw output has no separate artefact — it is merged into the same
stdout blob as the monkey log by `instrumentation-flush.js`, which `stdoutHash`
already covers — so the field is structurally unfillable in its current form
rather than merely forgotten.

**Still open**, and the analysis above points at the resolution: a field that is
structurally unfillable is declared vocabulary with no producer, so the consistent
move is to delete it rather than to keep sealing `null` into every artifact.
Deleting it is *not* free — removing a key changes the canonical form of every
sealed artifact and therefore its `contentHash` (the constraint recorded at
`shared/src/evidence.ts:139-140`), so this is a re-record-gated change like the
`_describe` fix in §24.0.

### 24.16 The workdir can leak between `resolve` and the pipeline's `try` — **FIXED (`95cfb38`)**

*As found:* the pipeline ran the resolve phase, appended to `trace`, called
`log.write("resolve.json", …)` and `sessions.set_package_path(audit_id, …)` — all
**before** the `try:` whose `except Exception: cleanup_package(resolved); raise`
provided cleanup. `resolve_package` cleans up its own workdir on internal failure
and `AuditService._execute` cleans up on success, but an exception from `log.write`
(a disk error) or `set_package_path` (a database error) left the extracted package
in `/tmp/npmguard-*` with no owner.

*Now:* ownership is established **at acquisition**. `acquired` is assigned inside
the phase operation and the `try` opens before it (`pipeline.py:174-188`), so the
handler covers every step after acquisition — including the two that used to sit
outside it and including the phase wrapper's own `phase_completed` emit. The
handler is at `pipeline.py:458-469`.

**The fix is bigger than the finding, and the reason matters more than the
finding did.** The handler is now `except BaseException`, not `except Exception`.
`except Exception` does not cover `CancelledError`, so a worker cancelled
mid-audit — engine shutdown — **always** leaked the whole extracted tree. That is a
far likelier path than the disk error this item described, and it was invisible to
the finding because the finding reasoned about which *statements* sat outside the
`try` rather than about which *exceptions* the handler caught. `resolve.py` had the
identical bug in its own cleanup and was fixed the same way in `67f830f`
(`resolve.py:142-153`, `except BaseException`).

### 24.17 `add_or_merge` discards the incoming node's experiment — **FIXED (`ced29f2`)**

*As found:* the merge kept only `focusFiles` and `focusLines`, dropping the incoming
hypothesis's `experiment`, `claim`, `severity` and `hypId`. So when two descriptions
landed within Jaro-Winkler 0.88, the *second* experiment was never run even though it
might plant different bait or defeat a different gate — and the kept node's
`focusLines` grew to cover the merged region, making the report read as though both
regions had been tested by the surviving experiment. `graph_built.mergedCount` was
the only signal (0 for the running example, so it is not exercised there).

*Now:* `add_or_merge` (`graph.py:169-233`) merges only when the description is
similar **and** the compiled `experiment` is byte-identical **and** the `claim`
matches — i.e. only when two nodes ask the same question of the same run. Similar
prose alone is no longer enough. Once two nodes genuinely ask the same question, one
run resolves both, so unioning `focusLines` is honest rather than a coverage claim
for something never executed: the invariant holds **by construction**, with no new
state to maintain. Goal **G30**.

The survivor also takes the **max** severity, which was a second defect inside the
first: keep-first let a `low` duplicate demote a `critical` out of its dispatch slot
(`graph.py:236-238` records why).

The observation about Jaro-Winkler weighting shared *prefixes* heavily still holds
and is still worth knowing — it just no longer causes a dropped experiment, because
prose similarity is now necessary rather than sufficient.

### 24.18 `triage_max_files` is configured but unused — **FIXED by deletion (`b9b805d`); this item understated itself 4×**

*As found:* `config.py` declared `triage_max_files: int = Field(default=80, ge=1,
le=1000)` with no reader. `run_flag` analyses every non-noise source file with no cap
(`phases.py:473`, the fan-out at `:448`), bounded only by the concurrency semaphore
and the scaled phase timeout.

*Now:* **eight** settings were dead, not the two this item named, and all eight were
**deleted rather than wired**: `triage_max_files`, `max_agent_turns`,
`investigation_enabled`, `test_gen_model`, `test_gen_mode`, `max_findings_to_prove`,
`verify_timeout_sec`, `max_docker_exec_timeout_sec`. Extending the scope is what let
the enforcing test (`tests/test_config_surface.py`, an `ast` scan for
`settings.<field>`) pass with an **empty** exemption list; the reasoning is recorded
at `config.py:76-102`.

**Two of the eight named bounds the code actively contradicts, so "wire it up" was
never an option:**

- `max_docker_exec_timeout_sec` defaulted to **30 s** beside a **180 s**
  `docker_exec` npm install (`deps.py:16`, `INSTALL_WALL_MS = 180_000`). Wiring it as
  named would clamp dependency provisioning **6×**.
- `max_agent_turns` defaulted to **30**, *above* the agent's own computed ceiling of
  **24** (`hypothesis_agent.py:361`, `budget = min(24, max(10, 3 * (n_tools + 2)))`).

`triage_model` and `investigation_model` **are** used, at `llm_runtime.py:153-154`.

**Why deleting `triage_max_files` was right rather than lazy, measured not assumed.**
Over the 418 published packages expanded on this machine, the engine's own filter
gives a median of **3** source files, p90 **33**, p99 near **500**, and a tail of
**3953** (`viem`). So the declared default of 80 truncates mainstream packages
including `zod`, `graphql`, `jsdom` and `viem`. A visible truncation must become an
ERROR by this project's own rule, which means you would spend 80 model calls to
deliver nothing. The units are wrong too: cost is tokens, the knob counts files, and
one bundled 500 KB file costs more than 80 small modules. The honest form of that
bound is a **refusal**, which is a different semantic than the name promises.

**And this item's cost account stops one step short of the real consequence.** It
said "a package with 500 source files gets 500 model calls in the FLAG phase", which
reads as an overspend. Joined to §8.1 and §8.2 it is worse than that. FLAG's budget is
`FLAG_TIMEOUT_MS × timeout_scale` = `600_000 ms × ≤4` = **2400 s at the cap**
(`pipeline.py:61`, `:270-273`), and `timeout_scale` saturates at 4 once the set
exceeds 140 files, so it stops growing long before the file count does. The fan-out
runs 8 at a time (`phases.py:479`), so wall time is about `⌈N/8⌉ × L` for a
per-call latency `L`. The phase therefore times out past roughly:

```
 ⌈N/8⌉ × L > 2400 s   ⇒   N > 19200 / L
   L =  3 s  ⇒  N > 6400
   L = 10 s  ⇒  N > 1920
   L = 60 s  ⇒  N >  320      (llm_timeout_seconds default)
```

Past that threshold — **~320 to ~6400 files depending on provider latency, which is
the only variable that decides it** — `_timed_phase` raises `AuditTimeoutError`
(`pipeline.py:91`, `NPMGUARD-0030`) and the pipeline produces **no report at all**.
Every model call already made was still paid for. So the real behaviour is not
overspend, it is **total loss of spend**: the audit pays for hundreds or thousands of
FLAG calls and delivers nothing. The retryable classification is honest but does not
help — a retry on the same package hits the same wall.

**The refusal this item argued for has LANDED (`37a6343`).** `max_source_files`
(`config.py:178-240`) is the only bound on **one audit's** model spend —
`llm_budget_usd_24h` is deployment-wide and cannot stop a single runaway audit. It is
compared against **the exact list `run_flag` fans out over**, so the number *is* the
worst-case FLAG call count, and it raises `PackageTooLargeError`
(`NPMGUARD-0003`, 413, non-retryable) at `pipeline.py:325-328`.

Three details of the design answer questions this item raised:

- **A refusal, not a truncation.** Reading the first N of 3953 files and reporting
  `SAFE` would be a coverage gap wearing a green badge, and the unread files are
  exactly where a payload hides. This is the same argument as §7.3's
  `install-coverage-gap` and §18.1's deferred gate.
- **Placement is load-bearing, and was falsified rather than reasoned.** It sits
  *after* the dealbreaker early return, so a free correct `DANGEROUS` is never
  discarded over a size bound, and *before* `intent`, so a refusal costs **zero**
  model calls. Moving it one phase later made an e2e mock log **three** real model
  requests — the intent call plus its provider-chain fallbacks. One misplaced refusal
  costs three calls, not one.
- **Non-retryable, deliberately.** The *input* is what is out of bounds, so nothing
  about waiting changes it; a retryable 413 would tell a client to loop forever.

**The measurement in this item is superseded by a larger, independent one.** §24.18's
figures came from 418 published packages; `37a6343` re-measured over **650** installed
packages counted *through `flag_source_files` itself*: median **2** source files, p90
**33**, p95 **81**, p99 **647**, max **3953** (`viem`), then `lucide-react` 2016,
`es-toolkit` 1893, `jsdom` 647, `zod` 275 — and **183 of the 650 have zero source
files**. Refusal rate by bound: 500 → **1.08%**, 1000 → **0.77%**, 2000 → **0.31%**,
4000 → **0%**. Both measurements agree on the conclusion — the declared default of 80
would have truncated mainstream packages — and the newer one is the number to quote.

**Default is `0` = OFF, and that is the one owner decision left open.** The refusal
lands *after* the payment claim, because the file count is a property of the extracted
tarball and the claim precedes `resolve`. An errored row is re-submittable
(`reset_to_queued`, §19.2) but a re-submit hits the same refusal, so switching this on
needs either a refund path or a pre-payment probe — and a pre-payment probe **cannot
exist as specified**, because the nearest registry signal (`dist.unpackedSize`, in
bytes) measures a different thing than source-file count. `0` keeps both options open
at zero behavioural cost, matching `llm_budget_usd_24h` in the same file. **1000 is
the documented recommended production value.**

A per-audit **USD** ceiling was assessed and deliberately not built, for a reason that
belongs here: it would trip *mid-FLAG* — spend-then-fail, the exact failure this
removes — and a naive version under-counts precisely when it matters, because
`total_cost_usd` is nullable and the existing tracker estimates NULL rows, so a plain
`SUM` over a **live** audit reads about zero on a deferred-cost provider.

### 24.19 `Trigger.kind` has two unrunnable values

`compile_experiment` accepts `kind ∈ {entrypoint, lifecycle, bin, subpath}`
(`experiments.py:638`) matching the contract (`shared/src/evidence.ts:82`), but
`build_trigger_command` returns `None` for `lifecycle` and `bin`
(`observation.py:145-146`), which becomes
`SetupError("trigger.kind='lifecycle' has no run command")` and therefore a
DEFER — that is, a *coverage gap that blocks `SAFE`*. Both generators always emit
`kind: "entrypoint"` (`phases.py:727`, `hypothesis_agent.py:326`), so this is
unreachable today; a future generator or a replayed/hand-written experiment could
reach it. `LifecycleHook` (`shared/src/evidence.ts:86-88`) is likewise a declared
enum with no producer anywhere.

**Still open, and it is now the named open half of G31.** `b9b805d` closed the error
codes and the config keys under that goal by deletion; the two unrunnable
`TriggerKind` members and `LifecycleHook` are the same defect in the *evidence*
vocabulary and were not touched. Re-verified at `1002b5b`.

### 24.20 The settings surface was enforced in only one direction — **FIXED (`37a6343`), and the obvious fix was not enough**

**A defect class §24 missed entirely.** `config.py` carried an enforced invariant that
every declared setting has a production reader (§24.18). **The converse was not
enforced**, and five knobs read `os.environ` directly — so they appeared in no
settings surface, got no type, no bound, and no validation. `config.py` is the file
someone sizing a deployment reads; these five were the mirror image of the defect its
own invariant names.

As found (line numbers as they then stood):

| Env var | Read at | Parsed | Failure mode on a bad value |
|---|---|---|---|
| `NPMGUARD_TRIAGE_CONCURRENCY` | `phases.py` ×2 (FLAG + HYPOTHESIZE fan-outs) | `int()` | `ValueError` **mid-audit**, inside the fan-out, mapped to nothing → `NPMGUARD-9999`, non-retryable, after the audit has already spent |
| `NPMGUARD_DEMO_SPEED` | `demo.py:35` | `float()` at **module scope** | **the engine does not boot** — `api.py` imports `demo`, so the traceback names neither the knob nor the module |
| `NPMGUARD_NPM_REGISTRY` | `resolve.py:13` | string, module scope | no validation; a typo'd URL fails at the first registry fetch as a resolve error |
| `NPMGUARD_DATA_DIR` | `report_store.py:12` | `Path(...).resolve()`, module scope | silently relocates the whole report store |
| `NPMGUARD_AUDIT_LOG_DIR` | `audit_log.py:27` | `Path(...)`, per call | as above for `audit-logs/` |

**Now:** five variables moved to validated `Settings` fields, and the invariant is
**bidirectional** — every declared setting has a reader *and* every `NPMGUARD_*` the
engine reads is declared (`tests/test_config_surface.py`, C1 and C3). Two reads
survive as **named debt with their exact one-line swap written out**, not as
judgements that the knob is fine where it is: `NPMGUARD_TRIAGE_CONCURRENCY`
(`phases.py`, two sites) and `NPMGUARD_DATA_DIR` (`report_store.py` module scope).
Neither could be declared alone, because C1 forbids a declared knob with no reader —
declaration and swap have to land in one change, and both files were owned by other
changes in flight. A second test (`test_no_exemption_outlives_its_reader`) deletes the
licence when the read goes, which is how an exemption list rots from "two items of
named debt" into "the rule does not apply here".

**Two things this item got wrong, and the first is the one that matters.**

1. **Declaring a knob is necessary but NOT sufficient, and the note this section
   previously carried implied otherwise.** It said declaring the three knobs would mean
   "a bad value is refused at boot naming the thing an operator greps `.env` for".
   That does not follow: **pydantic-settings names the FIELD, never the variable.**
   Measured across all three error kinds it produces, a bad `NPMGUARD_DEMO_SPEED`
   reported `demo_speed` — so an operator was told to grep `.env` for a name that does
   not appear there. Anyone acting on this item as originally written would have
   shipped exactly that. The fix is a second mechanism: `Settings.__init__` wraps
   `ValidationError` into `ConfigError`, rendering `loc → NPMGUARD_<LOC>`
   (`config.py:49`, `:23`, `:217-226`). It covers all ~50 knobs at once, including
   inherited `KitSettings` fields and the cross-field `llm_base_url` rule, and it
   reports pydantic's *message* only — never the input value — so a malformed
   `NPMGUARD_ENCRYPTION_KEY` is diagnosable without the secret reaching a log.
2. **Dismissing `ops.py` as "just a CLI entry point" was wrong on substance, and it
   hid a live bug.** This section wrote off its two reads because "its argument-parsing
   conventions apply instead". But `NPMGUARD_CRE_API_KEY` was read with raw
   `os.environ`, which **cannot see a key supplied in `.env`** — the one place the
   engine documents for it. An operator with the key configured exactly where the
   engine says to put it was told it was missing. Declaring it as `cre_api_key`
   (`config.py:243`) fixes that. The lesson generalises: "this file is a CLI" is a
   claim about the file's role, not about where its configuration comes from, and only
   the latter decides whether a raw `os.environ` read is correct.

**One exclusion that is deliberate and worth not "fixing".** The two variables the
engine *writes into the sandbox container* for `stub-proxy.js` are **not** declared. An
operator setting those in `.env` must have no effect, so declaring them would assert
the opposite. This is why C3 scans environment **access sites** with `ast` rather than
string literals — a literal scan cannot tell a read from a write, and would have
demanded a `Settings` field that must not exist.

### 24.21 Four wire types are declared, generated, and read by nobody

**A second defect class §24 missed, and it is in the contract rather than the
config.** `shared/src/models.ts` declares `Finding`, `Proof`, `Confidence` and
`TriageResult`. All four are generated into `engine/npmguard/contract/models.py`
(`Finding` at `:174`, `Proof` at `:296`, `TriageResult` at `:461`) and into
`shared/contract/contract.schema.json`. **None has a producer or a reader anywhere in
`engine/`, `shared/`, `frontend/` or `cli/`** — the only non-generated references are
the declarations themselves and one comment in `engine-types.ts` mentioning
`Proof.capability`. `Confidence` is referenced only *by* `Finding` and `Proof`, which
are themselves dead.

They are residue from the v1 pipeline: `Finding`'s own comment explains that its
defaults are "friendly to non-deterministic LLM outputs (MiniMax sometimes omits a
field)" from "the triage/investigation outputs", and the archived engine review
records an `investigate` phase with a 30-turn cap that emitted `Finding[]` with
self-reported `SUSPECTED`/`LIKELY`/`CONFIRMED`. That phase is gone. Its vocabulary
is not.

This is exactly the class `b9b805d` attacked in `errors.py` and `config.py`, and
`d1c4cd7` attacked in the verdict domain — declared vocabulary nothing produces or
reads, forcing exhaustive handling tables to carry unreachable arms. It is worse here
than in `config.py` for one structural reason: **`shared/` is the generator input**,
so every dead type is republished into the Python contract models and the JSON schema
on every regeneration, and any consumer generating a client from the schema inherits
four types no engine will ever send.

It is also a direct counterexample to **G31** ("No declared value in the wire
vocabulary lacks a producer") as currently marked, and the goal's own "verified by"
line — "grep per enum" — is what would have caught it, since `Confidence` is an enum
whose only readers are two dead objects.

---

## Appendix — the running example as one table

Every hypothesis in the `test-pkg-env-exfil@2.0.1` audit, in dispatch order,
from `engine/demo-data/test-pkg-env-exfil.json` (states and reasons) and
`engine/tests/fixtures/llm/test-pkg-env-exfil@2.0.1/hypotheses.json` (claims).

| # | hypId | file | claim | sev | state | why |
|---|---|---|---|---|---|---|
| 1 | hyp-0001 | setup.js | env_exfil | critical | REFUTED | POST rendered as `localhost/exfil`, not the hypothesised `localhost:9999/exfil` |
| 2 | hyp-0002 | setup.js | cred_theft | critical | REFUTED | reads judged consistent with a config loader; no external transmission shown |
| 3 | hyp-0003 | setup.js | cred_theft | critical | REFUTED | POST went to a stubbed localhost, not an external attacker host |
| 4 | hyp-0006 | setup.js | env_exfil | critical | REFUTED | no event matched the hypothesised endpoint (port mismatch) |
| 5 | hyp-0007 | setup.js | cred_theft | critical | REFUTED | POST to port 80, not the claimed 9999 |
| 6 | **hyp-0008** | setup.js | cred_theft | critical | **CONFIRMED** | **e147 = HTTP GET `169.254.169.254/latest/meta-data/`; plus e51–e59 credential reads and e60 exfil POST** |
| 7 | hyp-0004 | setup.js | cred_theft | high | REFUTED | files were read but the POST payload is not captured |
| 8 | hyp-0005 | setup.js | env_exfil | high | REFUTED | claimed the IMDS probe was absent (it was at e147, outside this run's timeline) |
| 9 | hyp-0010 | index.js | binary_drop | high | REFUTED | `/home/node/.npmrc` never opened |
| 10 | hyp-0011 | index.js | persistence | high | REFUTED | no user-supplied path was read; the planted canary was never accessed |
| 11 | hyp-0012 | index.js | cred_theft | high | REFUTED | no sensitive value entered the config object; no network or file write |
| 12 | hyp-0013 | index.js | env_exfil | high | REFUTED | planted `/pkg/.env` never read; the canary never accessed |
| 13 | hyp-0009 | index.js | telemetry | low | REFUTED | no `SAFE_TEST_MODE`-gated telemetry observed |
| 14 | hyp-0014 | index.js | destructive | low | REFUTED | `/pkg/.env` was read successfully at e24; no error was swallowed |

`counts{total:14, open:0, inProgress:0, confirmed:1, refuted:13, deferred:0}` →
`derive_graph_verdict` → **`DANGEROUS`** · *"1 confirmed hypothesis with cited
dynamic evidence."*

---

## Source index

```
 engine/npmguard/service.py         admission, queue, workers, _finish, _execute
 engine/npmguard/pipeline.py        the nine phases, _timed_phase, _report,
                                      dealbreaker + zero-flag early returns
 engine/npmguard/resolve.py         tarball/fixture acquisition, escape checks
 engine/npmguard/deps.py            --ignore-scripts dependency provisioning
 engine/npmguard/inventory.py       file classification, dealbreakers, flags
 engine/npmguard/phases.py          intent, FLAG, one-shot HYPOTHESIZE,
                                      run_hypothesize, JudgeVerdict schema
 engine/npmguard/hypothesis_agent.py  propose + agentic build + fallback union
 engine/npmguard/experiments.py     compile_experiment, 6 builders, TOOL_CATALOG
 engine/npmguard/graph.py           state machine, dedup, derive_graph_verdict
 engine/npmguard/orchestrator.py    the full-oracle loop, judge_evidence
 engine/npmguard/observation.py     run_under_observation, dry_run_load
 engine/npmguard/sensors.py         strace, tcpdump/tshark, fs-diff
 engine/npmguard/docker.py          docker_exec, ContainerSpec
 engine/npmguard/assets/            instrumentation-monkey/-inspector/-flush,
                                      stub-proxy
 engine/npmguard/evidence.py        canonicalisation, sealing, ArtifactStore,
                                      render_timeline
 engine/npmguard/events.py          AuditEmitter, SSE framing, sse_events
 engine/npmguard/report_store.py    data/reports/<pkg>/<version>.json
 engine/npmguard/persistence.py     audit_sessions, payment_claims
 engine/npmguard/errors.py          the NPMGUARD-00xx taxonomy
 engine/npmguard/config.py          Settings, SOURCE_FILE_TYPES, SKIP_DIRS
 engine/npmguard/llm_runtime.py     the six LLM roles and their model tiers
 engine/npmguard/audit_log.py       per-run audit-logs/<stamp>_<pkg>/
 engine/prompts/{intent,flag,hypothesis,propose,agent,judge}/v1.md
 shared/src/{models,graph,backend,evidence,events}.ts   the cross-process contract
 docs/specs/2026-07-08-evidence-timeline-judge.md
 docs/specs/2026-07-10-triage-hypothesis-redesign.md
 engine/demo-data/{test-pkg-env-exfil,chalk}.json
 engine/tests/fixtures/llm/{test-pkg-env-exfil@2.0.1,chalk@5.6.2,
                            is-number@7.0.0,test-pkg-dns-exfil@0.2.1}/
```
