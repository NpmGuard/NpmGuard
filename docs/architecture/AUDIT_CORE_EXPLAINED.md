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
| `engine/demo-data/chalk.json` | 0 | 0 | zero-flag early return (`pipeline.py:302-307`) | `"No suspicions were raised."` |
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
                                  ▼   AuditPipeline.run(...)   pipeline.py:146
 ┌──────────────┐  emit audit_started {packageName}
 │              │
 │  ① RESOLVE   │ IN : ("test-pkg-env-exfil", None)
 │  240 s cap   │ OUT: ResolvedPackage(path=/tmp/npmguard-XXXX/test-pkg-env-
 │              │      exfil, workdir=/tmp/npmguard-XXXX, version=None)
 └──────┬───────┘      resolve.py:100-136
        │              ⚠ path MUST live inside workdir — asserted, resolve.py:33
        ▼
 ┌──────────────┐  emit dependencies_provisioned
 │ ② DEPS       │ IN : package.json.dependencies = {}
 │ best-effort  │ OUT: DependencyProvision(installed=False, package_count=0,
 │ 180 s cap    │      skipped_reason="no runtime dependencies")  deps.py:61-63
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
 │              │      dealbreaker=None      inventory.py:237-253
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
 │              │        degraded=False)          phases.py:357-382
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
 │              │      + one FileSummary per file    phases.py:392-529
 └──────┬───────┘
        │  ⚡ if flags == [] → SAFE, 0 hypotheses, RETURN (§12)
        ▼
 ┌──────────────┐  emit file_analyzing ×14, hypothesis_emitted ×14,
 │ ⑥ HYPOTHESIZE│       file_verdict ×2, triage_complete
 │ 1200 s × 1.0 │ IN : 1 Flag  (fan-out: 8 concurrent)
 │ LLM: invest. │ OUT: 1 Hypothesis with a COMPILED, DRY-RUN-VERIFIED
 │ 1 flag →     │      experiment: ToolCall[]         phases.py:718-768
 │ 1 hypothesis │      hyp-0001 … hyp-0014
 └──────┬───────┘
        ▼
 ┌──────────────┐  emit graph_built {nodeCount:14, addedCount:14, mergedCount:0}
 │ ⑦ GRAPH      │ fuzzy-dedup on description (Jaro-Winkler ≥ 0.88)
 │              │ every node admitted OPEN and armed        graph.py:223-230
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
 │ ⑨ VERDICT    │ derive_graph_verdict(graph)              graph.py:250-286
 │              │ OUT: DANGEROUS · "1 confirmed hypothesis with cited dynamic
 │              │      evidence." · counts{total:14,open:0,inProgress:0,
 │              │      confirmed:1,refuted:13,deferred:0}
 │              │      confirmedHypIds=["hyp-0008"]
 └──────┬───────┘
        ▼  AuditResult(report, package_path, resolved)  ← RETURNED, not emitted
 ┌────────────────────────────────────────────────────────────────────────┐
 │ AuditService._execute                                 service.py:273-323│
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
  `pipeline.py:154-157` and enforced at `service.py:263-271`.
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

`queue_size` defaults to 50 (`config.py:40`), `max_concurrent` comes from
`max_running_sessions`, default 4 (`config.py:47`, wired at `api.py:664-669`).
The comment at `config.py:41-46` explains the choice of 4: each concurrent audit
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
    mid-drain.                                            service.py:199-207
 2. asyncio.wait(inflight, timeout=deadline)  — let workers finish naturally.
 3. Cancel every worker task, gather with return_exceptions=True.
 4. For each still-owned id: _shutdown_finalize (0031 it ONLY if it reached
    'running'; LEAVE it 'queued' otherwise) and ALWAYS resolve its future.
                                                          service.py:226-230
```

The post-condition is: *no owned session is left `running` and no owned future
is unresolved.* Never-started `queued` rows are deliberately **not** finalised to
error, because "a graceful shutdown must not drop a claimed paid audit that a
crash would have preserved" (`service.py:192-195`) — crash/graceful parity on
the never-drop rule.

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

And in `_execute` (`service.py:273-306`) the ordering across stores is also an
invariant:

```
 result = await pipeline.run(...)          ← returns; never emits terminal
 report = result.report.model_dump(mode="json", exclude_none=False)
 save_report(name, requested_version or "latest", result.report)   ← DISK FIRST
 _finish(..., event_type="verdict_reached", payload={verdict, rationale,
                                            counts, confirmedCount})  ← THEN ROW
 finally: result.cleanup()                 ← unconditional workspace rmtree
```

`service.py:284-288`: "the report is durable on disk before the row leaves
`running`, and `verdict_reached` commits atomically with `running→done` — a
client acting on the terminal frame always finds the persisted report." The
`finally` is unconditional so a save/finalize failure cannot leak the temp
workspace (`service.py:303-305`).

On any exception (`service.py:307-323`):

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
| The report is on disk before any client can see the verdict frame | ordering in `_execute` (`service.py:284-302`) |

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
┌─ ResolvedPackage ─────────────────────────────── resolve.py:16-35 ────────┐
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
  (`resolve.py:139-142`).
- `deps.provision_dependencies` may unpack a `node_modules` tree *into*
  `resolved.path` without any risk of mutating a committed fixture tree
  (`resolve.py:29-32`).
- `deps.py:56-60` can reason that "`node_modules` exists ⇒ the package **ships**
  it" rather than "residue from a previous audit".

### 5.2 The two acquisition paths

```
 resolve_package(name, version)                          resolve.py:100-136
 workdir = mkdtemp(prefix="npmguard-")
   │
   ├── name.startswith("test-pkg-") and the fixture dir exists?   :38-42
   │     ┌───────────────────────────────────────────────────────────────┐
   │     │ OFFLINE SHORT-CIRCUIT — no network                             │
   │     │ shutil.copytree(fixture, workdir/name, symlinks=True)          │
   │     │ _reject_escaping_symlinks(path, workdir)            :73-82      │
   │     │   every symlink whose .resolve() leaves workdir → ValueError    │
   │     │   ("bench fixtures are live malware and may ship symlinks")     │
   │     │ ⇒ ResolvedPackage(path, workdir, version=None)                  │
   │     └───────────────────────────────────────────────────────────────┘
   │       ↑ our running example takes THIS path — hence version=None,
   │         and the concrete "2.0.1" is recovered later from package.json.
   │
   └── otherwise: the npm registry
         GET {NPM_REGISTRY}/{name}/{version or "latest"}          :45-57
           404               → PackageNotFoundError   NPMGUARD-0001, HTTP 404
           malformed JSON    → ValueError (no `version`/`dist.tarball` string)
           else              → (resolved_version, tarball_url)
         stream the .tgz to workdir/package.tgz (httpx, 60 s, redirects)
         _safe_extract(archive, workdir/extracted)                 :60-70
           for every member:  (dest/member.name).resolve() must stay under root
                              → else "tar entry escapes extraction root"
           for sym/hard links: (target.parent/linkname).resolve() must too
                              → else "tar link escapes extraction root"
           then extractall(..., filter="data")   ← Python's own hardening
         path = _package_root(extracted, name)                     :85-97
         ⇒ ResolvedPackage(path, workdir, version=resolved_version)

 any exception → shutil.rmtree(workdir, ignore_errors=True); raise      :134-136
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
(`resolve.py:86-89`) states the principle: "Absence or ambiguity is a checked
error, never an arbitrary-first-dir guess."

`NPM_REGISTRY` is read from `NPMGUARD_NPM_REGISTRY`, defaulting to
`https://registry.npmjs.org` (`resolve.py:13`).

**Phase result for the running example** (`pipeline.py:163-179`):

```
 IN : {"packageName": "test-pkg-env-exfil", "version": null}
 OUT: {"path": "/tmp/npmguard-<rand>/test-pkg-env-exfil", "version": null}
 timeout: 240_000 ms → exceeded ⇒ AuditTimeoutError("resolve", 240000)
 side effect: sessions.set_package_path(audit_id, str(resolved.path))  :180
              ← this is what lets GET /audit/{id}/file/{path} serve source
                to the frontend later (api.py:390-411)
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
(`deps.py:52-55`):

> Best-effort by design. A failure leaves `node_modules` absent; the orchestrator
> then DEFERS (never REFUTES) any experiment that crashes on the missing module,
> so an install failure can never be laundered into a false SAFE verdict.

### 6.2 How it installs code without executing it

```
 provision_dependencies(package_path, settings)             deps.py:43-149
 ┌──────────────────────────────────────────────────────────────────────┐
 │ if (package_path/"node_modules").exists():                            │
 │     → DependencyProvision(False, 0,                                   │
 │         skipped_reason="node_modules already present")        :56-60   │
 │     (safe to interpret as "the package SHIPS it", per the             │
 │      ResolvedPackage invariant — never cross-run residue)             │
 │                                                                       │
 │ deps = package.json["dependencies"] filtered to str→str      :31-40    │
 │ if not deps: → (False, 0, skipped_reason="no runtime dependencies")    │
 │     ◀── our running example stops HERE                        :61-63   │
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
 │   -w /work  <sandbox_image>  sleep infinity                  :65-95   │
 │ FileNotFoundError on the docker binary → DockerUnavailableError        │
 │                                          NPMGUARD-0020        :98-99  │
 │ non-zero start → (False, 0, error="install container failed to start") │
 │                                                              :100-103 │
 └──────────────────────────────────────────────────────────────────────┘
                     ▼
 write /work/package.json = {"name":"npmguard-install-target",
   "version":"0.0.0","private":true,"dependencies":deps}       :106-114
                     ▼
 npm install --ignore-scripts --omit=dev --no-package-lock                
             --no-audit --no-fund --loglevel=warn      wall 180_000 ms
                                                              :115-129
   ◀── --ignore-scripts is THE safety property: dependency CODE is never
       executed. Packages are downloaded and unpacked, nothing more.
   timed_out → error="npm install exceeded 180000ms budget"
   exit != 0 → error="npm install exit={code}: {stderr[:300]}"
                     ▼
 _stream_tar(container, "/work", "node_modules")               :152-181
   docker exec <c> tar c -C /work node_modules  →  read stdout in 1 MiB
   chunks; if total > 256 MiB → kill, return None
     → error="node_modules exceeded 268435456 byte extraction cap"
   ◀── WHY tar-over-exec instead of `docker cp`? deps.py:17-20: docker cp
       cannot read a tmpfs mount, and /work IS a tmpfs.
                     ▼
 tarfile.extractall(package_path, filter="data")                :143-144
 installed = count of directories directly under node_modules   :145
 → DependencyProvision(True, installed)
                     ▼
 finally: docker rm -f <container>, exceptions suppressed       :147-149
```

Note the return shape carefully: `DependencyProvision(installed: bool,
package_count: int, skipped_reason: str|None, error: str|None)`
(`deps.py:23-28`). **Every** failure mode returns a value with `error` set — none
of them raise — except `DockerUnavailableError`, which does raise and aborts the
audit. The pipeline emits the whole thing as a `dependencies_provisioned` frame
and continues regardless (`pipeline.py:182-201`).

For the running example: `dependencies` is absent from `package.json`, so
`_runtime_dependencies` returns `{}` and the phase returns
`installed=False, package_count=0, skipped_reason="no runtime dependencies"` —
no container is created at all.

Two more details: this phase is **not** wrapped in `_timed_phase`, so it has no
`AuditTimeoutError` — its bound is the internal 180 s `INSTALL_WALL_MS`. And it
runs *before* inventory, so the `node_modules` tree it creates is invisible to
inventory's file walk, which skips `node_modules` via `SKIP_DIRS`
(`config.py:129`, applied at `inventory.py:141`).

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
                                                      inventory.py:90-125
 ┌───────────────────────────────────────────────────────────────────────┐
 │ LIFECYCLE_SCRIPTS = {preinstall, install, postinstall, prepare,        │
 │                      prepublish}                              :17     │
 │                                                                       │
 │ entryPoints.install  ← for each lifecycle hook present, the file      │
 │   extract_script_file_ref("node setup.js")                    :65-69  │
 │     split on whitespace; require parts[0] == "node";                  │
 │     return the first later part not starting with "-"                 │
 │     ⇒ "setup.js"        (a non-`node` script yields None)             │
 │                                                                       │
 │ entryPoints.runtime  ← [main or "index.js"] + module? + every string  │
 │   leaf of the "exports" tree (recursive, _exports_entries :72-78),    │
 │   deduped by dict.fromkeys                                    :112-117│
 │                                                                       │
 │ entryPoints.bin      ← "bin" as string, or every string value of the  │
 │   "bin" object                                                :80-87  │
 └───────────────────────────────────────────────────────────────────────┘
```

For the running example: `install=["setup.js"]` (from `preinstall: "node
setup.js"`), `runtime=["index.js"]` (from `main`), `bin=[]`.

`metadata.repository` is passed through **verbatim** (`inventory.py:104`) because
npm permits either a shorthand string or an object; the shared schema models it
as that real union rather than `unknown`, so consumers must branch instead of
rendering `[object Object]` (`shared/src/backend.ts:63-70`).

### 7.2 File classification

```
 classify_files(package_path)                        inventory.py:138-160
 for path in package_path.rglob("*"):
   skip if any path part ∈ SKIP_DIRS {node_modules, .git, .svn}   config.py:129
   skip non-files; skip on OSError
   is_binary, binary_type = _binary(path)            ← first 4 bytes  :128-135
       ELF   \x7fELF
       MachO \xcf\xfa\xed\xfe   or   \xce\xfa\xed\xfe
       PE    MZ                                                      :35-40
   FileRecord(
     path        = POSIX path relative to the package root,
     fileType    = "binary" if is_binary else EXTENSION_TYPE_MAP.get(suffix,
                                                                "unknown"),
     sizeBytes   = st_size,
     permissions = octal mode, e.g. "644",
     isBinary, binaryType)
```

`EXTENSION_TYPE_MAP` (`inventory.py:18-34`) is the vocabulary the rest of the
pipeline filters on:

```
 .js .mjs .cjs → "js"      .ts .tsx .mts → "ts"      ← SOURCE_FILE_TYPES
 .json → "json"   .md .txt → "doc"   .html .css → "web"
 .sh → "shell"    .map → "sourcemap"   .yml .yaml → "config"
 anything else → "unknown"
```

`SOURCE_FILE_TYPES = frozenset({"js", "ts"})` (`config.py:128`). Only files of
those two types, and not binary, reach the FLAG pass. A `.sh` file, a `.wasm`
file, or an `unknown` extension is inventoried and may raise structural flags but
is **never read by the FLAG model**.

### 7.3 Structural checks — dealbreakers first, then flags

`run_inventory_checks(scripts, entry_points, files)` returns
`(flags, dealbreaker)` and returns **early with `([], dealbreaker)`** on either
dealbreaker (`inventory.py:163-234`):

```
 ┌─ DEALBREAKER 1: shell-pipe ───────────────────────── :166-171 ──────────┐
 │ for EVERY script (not just lifecycle hooks): does its value match any of │
 │   curl … | sh        curl … | bash                                      │
 │   wget … | sh        wget … | bash                                      │
 │   curl … |           ← broadest: curl piped into ANYTHING               │
 │   wget … -O … && (sh|bash|chmod)                              :41-48    │
 │ → DealBreaker(check="shell-pipe",                                       │
 │               detail="Script '{key}' contains shell pipe: {value}")      │
 └─────────────────────────────────────────────────────────────────────────┘
 ┌─ DEALBREAKER 2: missing-install-script ───────────── :172-178 ──────────┐
 │ for each reference in entry_points.install: is it in {f.path for f}?     │
 │ → DealBreaker(check="missing-install-script",                           │
 │     detail="Install script references '{ref}' but file not found in      │
 │             package")                                                    │
 │ ◀── why is a MISSING file dangerous? Because the manifest declares that  │
 │     `npm install` will execute it. The file will be resolved at install  │
 │     time from wherever it then exists — so the audit cannot see what     │
 │     will run. Unanalysable install-time execution is the danger.         │
 └─────────────────────────────────────────────────────────────────────────┘
```

Otherwise, four families of advisory flag are accumulated:

| Check | Severity | Condition | Source |
|---|---|---|---|
| `lifecycle-scripts` | `info` | any of `preinstall/install/postinstall/prepare/prepublish` present; detail lists them | `inventory.py:180-189` |
| `non-node-script` | `warn` | a lifecycle script whose first token is not `node` | `inventory.py:190-200` |
| `binary-detected` | `warn` | `file.isBinary`; detail names the magic type | `inventory.py:201-210` |
| `executable-outside-bin` | `warn` | `mode & 0o111` and path does not start `bin/` or `bin\` | `inventory.py:211-219` |
| `hidden-dotfile` | `info` | basename starts `.` and is not in `STANDARD_DOTFILES` `{.npmignore, .gitignore, .browserslistrc, .editorconfig}` nor prefixed `.eslintrc`/`.prettierrc`/`.babelrc` | `inventory.py:220-233`, `:49-50` |

**Running example, exact result:**

```
 dealbreaker = None
   · no script contains a shell pipe ("node setup.js" does not match)
   · entry_points.install = ["setup.js"] and "setup.js" IS in files ✓
 flags = [ InventoryFlag(severity="info", check="lifecycle-scripts",
             detail="Package declares lifecycle hooks: preinstall",
             file=None) ]
   · non-node-script: "node setup.js" starts with node → no flag
   · binary-detected: none of the three files has a magic prefix
   · executable-outside-bin: 0o644 & 0o111 == 0 → no flag
   · hidden-dotfile: no dotfiles
```

Note `file=None` on that flag. That matters immediately: the FLAG phase builds a
per-file fact map keyed on `flag.file` and skips flags with no file
(`phases.py:412-415`), so this particular flag reaches **no** file's prompt. The
`preinstall` hook's significance is instead conveyed to the model through
`entryPoints.install`, which is threaded into the hypothesise prompt
(`phases.py:580`), not the flag prompt.

---

<a name="8-phase-timing"></a>
## 8. Phase timing, timeouts, and the timeout scale

Every LLM-bearing or filesystem-bearing phase goes through one wrapper:

```
 _timed_phase(name, operation, timeout_ms, input_summary,
              output_summary, emitter) → (T, PhaseLog)   pipeline.py:54-75
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
| (dependencies) | none — internal 180 000 ms wall | **no** | `pipeline.py:182`, `deps.py:16` |
| `inventory` | 60 000 ms | yes | `pipeline.py:203-223` |
| `intent-extraction` | 120 000 ms | yes | `pipeline.py:264-274` |
| `flag` | 600 000 ms × `timeout_scale` | yes | `pipeline.py:286-299` |
| `hypothesize` | 1 200 000 ms × `timeout_scale` | yes | `pipeline.py:309-336` |
| `orchestrator` | 2 400 000 ms × `timeout_scale`, as an **internal budget** | **no** | `pipeline.py:363-380`, `orchestrator.py:167` |

The orchestrator is timed and emits `phase_started`/`phase_completed` manually
(`pipeline.py:363, 376-380`) but is **not** wrapped in `asyncio.timeout`. Its
budget is checked *between* hypotheses, and exhausting it does not raise — it
DEFERS every remaining `OPEN` node (`orchestrator.py:167-177`). This is a
meaningful difference: an over-budget `flag` phase kills the audit with
`NPMGUARD-0030`; an over-budget orchestrator produces deferrals, which then
(usually) become `NPMGUARD-0031` at `pipeline.py:391-399`.

### 8.2 `timeout_scale`

```
 sources = [f for f in inventory.files
            if f.fileType in SOURCE_FILE_TYPES and not f.isBinary]
 source_kb = sum(f.sizeBytes for f in sources) / 1024
 timeout_scale = max(
     min(4, 1 + max(0, len(sources) - 20) * 0.025),   ← +2.5% per file over 20
     min(4, 1 + max(0, source_kb - 200) / 500),       ← +1 per 500 KB over 200
 )                                                    pipeline.py:238-247
```

Both terms are clamped at 4, so the scale is always in `[1.0, 4.0]`. It grows
with *either* file count or total source size, whichever demands more.

For the running example: `sources` = `index.js` + `setup.js` (`package.json` is
`fileType == "json"`, excluded). `len(sources) = 2`, `source_kb = 3599/1024 =
3.51`. Both terms evaluate to `1.0`, so `timeout_scale = 1.0` and the budgets are
600 s / 1200 s / 2400 s exactly.

One subtlety worth stating precisely: this `sources` list is **not** the same
list FLAG actually analyses. FLAG applies an additional `noise()` filter
(`phases.py:400-411`) that drops `.d.ts` files, test/mock directories, and
`*.test.*`/`*.spec.*` files. So a package that is 90% tests gets a timeout budget
scaled for files that will never be read. See Observations §24.4.

---

<a name="9-the-dealbreaker-path"></a>
## 9. The dealbreaker path — a verdict with zero hypotheses

If `inventory.dealbreaker` is non-`None`, the pipeline builds a report **by
hand** and returns immediately:

```
 pipeline.py:249-262
 ┌───────────────────────────────────────────────────────────────────────┐
 │ if inventory.dealbreaker:                                             │
 │     report = AuditReport(                                             │
 │         schemaVersion   = 2,                                          │
 │         verdict         = "DANGEROUS",          ◀── HARDCODED         │
 │         rationale       = f"Dealbreaker: {check} — {detail}",          │
 │         counts          = EMPTY_COUNTS,   # all six fields 0  :40      │
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

**1. Sequencing.** The dealbreaker test sits at `pipeline.py:249`, *before*
`intent-extraction` (`:264`), *before* `flag` (`:286`), *before* `hypothesize`
(`:309`). No hypothesis has been created because no phase that creates
hypotheses has run. `fileSummaries` is empty for the same reason. The `trace`
therefore contains exactly two `PhaseLog` entries.

**2. It would be impossible to express otherwise.** The normal verdict function
`derive_graph_verdict` (`graph.py:250-286`) can **only** return `DANGEROUS` when
`counts.confirmed >= 1`, and a `CONFIRMED` node can only exist if a sandbox run
produced an `EvidenceRef` that a judge cited (`graph.py:170-172`). A dealbreaker
is a *static* determination — no sandbox ran, no evidence exists. So a dealbreaker
cannot be routed through the graph; it must bypass `_report`/`derive_graph_verdict`
entirely. That is exactly what `pipeline.py:250-260` does: it constructs
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
(`report_store.py:35-42`) reads it out of the `inventory` phase's `PhaseLog`
output, which is present in this two-entry trace.

---

<a name="10-intent"></a>
## 10. `intent` — establishing the benign baseline

`engine/npmguard/phases.py:357-382`. This is the first LLM call. Its job is to
answer: *what does this package claim to be for?*

The reason this comes first is the reason the whole system works. "Reads
`process.env`" is not evidence of anything. "Reads `process.env` **in a
terminal-colour library**" is. Every downstream prompt is given this baseline so
the model can reason about *deviation from purpose* rather than absolute
suspiciousness.

```
┌─ PackageIntent ──────────────────────────────── phases.py:73-83 ──────────┐
│ statedPurpose        : str                                                │
│ expectedCapabilities : list[str]  (max_length=12)   ◀── FREE-FORM STRINGS │
│ rationale            : str                                                │
│ degraded             : SkipJsonSchema[bool] = False ◀── OFF-WIRE MARKER   │
│ model_config = ConfigDict(extra="forbid")                                 │
└───────────────────────────────────────────────────────────────────────────┘
```

`degraded` is wrapped in `SkipJsonSchema`, which keeps it out of the JSON schema
sent to the model — the model cannot set it. Only `fallback_intent` sets it
`True` (`phases.py:347-354`). The invariant at `phases.py:378-382`:

> **intent is either LLM-validated or explicitly `degraded=True`.**

### 10.1 The real call

```
 IN — prompt built at phases.py:363-367 (dependencies list from
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
(`phases.py:77`). But `FileFlagResponse.capabilities` is
`list[Capability]` — a closed 21-value enum (`phases.py:30-53, 168`). So no code
ever compares "expected" against "observed" capabilities: the units do not even
match. The "is this beyond intent?" judgement is made **entirely inside the
model**, by putting the English purpose text and the enum instruction in the
same prompt. There is no capability-matching table anywhere in the engine, and
the design spec says that is deliberate: "no hand-coded taxonomy, per-category
strategy tables"
(`docs/specs/2026-07-10-triage-hypothesis-redesign.md:5-7`).

### 10.2 `find_readme` and the degraded fallback

```
 find_readme(package_path, inventory)                    phases.py:330-344
   docs = {f.path for f in inventory.files
           if f.fileType == "doc" and not f.isBinary}
   try in order: README.md README.MD Readme.md readme.md README
                 README.markdown README.txt              :307-315
   read as utf-8; on OSError, try the next candidate
   if len > 16_000: content[:16_000] +
       "\n\n[... truncated, original was {n} bytes ...]"
   else → None
```

```
 extract_intent error handling                           phases.py:368-382
   try:  llm.run("intent", …, context=("audit", audit_id))
         return PackageIntent.model_validate(result.output)
   except (EndOfRope, OutputInvalid):
         return fallback_intent(inventory)
```

Only two exception classes fall back, and the choice is precise
(`phases.py:377-382`): `EndOfRope` (the provider chain is exhausted) and
`OutputInvalid` (no candidate survived validation) are *retryable provider*
failures. `BudgetExhausted` (the 24-hour spend cap), `CancelledError`, and plain
code bugs all **propagate** and kill the audit. The comment calls this "the same
budget-terminal discipline as the hypothesize phases."

The fallback itself (`phases.py:347-354`) is careful not to invent anything:

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

`engine/npmguard/phases.py:392-529`. One model call per source file, run
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
   f"[{flag.severity}] {flag.check}: {flag.detail}"     phases.py:412-415

 semaphore = Semaphore(NPMGUARD_TRIAGE_CONCURRENCY, default 8)    :417
 responses = [None] * len(source_files)   ← index-aligned, order preserved :416
 await _gather_fail_fast(analyze(i) for i in range(len(source_files)))  :520
```

`_gather_fail_fast` (`phases.py:289-304`) is a small but important utility.
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
 analyze(index)                                        phases.py:421-518
 ┌──────────────────────────────────────────────────────────────────────┐
 │ contents = _safe_file(package_path, file.path).read_text("utf-8")     │
 │   _safe_file resolves and requires the result stay under the package  │
 │   root, else AuditIncompleteError("flag", "file escapes package        │
 │   root: …")                                          phases.py:385-389│
 │   OSError → AuditIncompleteError("flag", "could not analyze {path}:    │
 │             file-unreadable")                                  :427-430│
 │                                                                       │
 │ ┌─ BRANCH A: len(contents) > 500_000 ──────────────────── :431-442 ──┐ │
 │ │ NO model call. Synthesise a response that keeps the file in scope: │ │
 │ │   summary = "File is {kb}KB — too large for the FLAG read"         │ │
 │ │   capabilities = []                                                │ │
 │ │   flags = [FlagDraft(lines=["1-1"], why="File {path} is {kb}KB —   │ │
 │ │            too large to read statically; needs a dynamic run to    │ │
 │ │            inspect.")]                                             │ │
 │ │ ◀── ONE flag, so the file still becomes a hypothesis and still gets│ │
 │ │     RUN. An unreadable file is never silently cleared.             │ │
 │ └────────────────────────────────────────────────────────────────────┘ │
 │ ┌─ BRANCH B: not contents.strip() ─────────────────────── :443-444 ──┐ │
 │ │ NO model call. FileFlagResponse(summary="Empty file",              │ │
 │ │   capabilities=[], flags=[])   ← genuinely nothing to test         │ │
 │ └────────────────────────────────────────────────────────────────────┘ │
 │ ┌─ BRANCH C: the normal path ───────────────────────────── :446-510 ─┐ │
 │ │ emit file_analyzing {file}                                         │ │
 │ │ prompt = intent block + "## File: {path}" + numbered source        │ │
 │ │          (+ "## Structural facts" if facts[path]) + task text      │ │
 │ │ llm.run("flag", …, validate=validate_response)                     │ │
 │ │ ANY exception → AuditIncompleteError("flag", "could not analyze     │ │
 │ │   {path}: model call failed: {exc}")               :507-510         │ │
 │ └────────────────────────────────────────────────────────────────────┘ │
 │                                                                       │
 │ responses[index] = (file.path, response)                              │
 │ async with lock: complete += 1                                        │
 │   emit triage_progress {current, total, file}          :512-518        │
 └──────────────────────────────────────────────────────────────────────┘
```

`number_lines` (`phases.py:285-286`) prefixes every line with `1: `, `2: `, …
The whole flag contract is expressed in those numbers, so the model must be able
to see them.

The task text appended to every prompt (`phases.py:451-456`) is the precision
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
┌─ FileFlagResponse ─────────────────────────── phases.py:164-187 ──────────┐
│ summary      : str                                                        │
│ capabilities : list[Capability]     ← the 21-value enum, phases.py:30-53  │
│ flags        : list[FlagDraft]      ← max_length=8                        │
└───────────────────────────────────────────────────────────────────────────┘
┌─ FlagDraft ────────────────────────────────── phases.py:85-161 ───────────┐
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
 LAYER 1 — key renaming (FlagDraft.normalize_provider_shape)   :95-130
   lines ← lineRanges | line_range | f"{start_line}-{end_line or start_line}"
   why   ← description | reason | flag
   then every alias key is popped so extra="forbid" still holds.
   Rationale (:98-104): providers get the JSON schema but some models still
   rename fields; keeping this at the boundary "lets Kit validate and capture
   a typed result without weakening the report schema downstream."

 LAYER 2 — value coercion (FlagDraft.normalize_lines)          :132-161
   42            → "42-42"          (int)
   [42, 58]      → "42-58"          (2-int list/tuple)
   " 42 - 58 "   → "42-58"          (regex-normalised whitespace)
   "42"          → "42-42"
   "42: const x" → "42-42"          (leading number then colon)
   anything else → kept as the stripped string  (Layer 3 handles it)
   a non-list/str/int item → ValueError("invalid line range …")

 LAYER 3 — semantic validation (run_flag.validate_response)    :458-496
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

`CRITICAL_SUMMARY` (`phases.py:316-327`) is four case-insensitive patterns:
`credential(s) (theft|stealer|harvesting|exfiltration)`; `(steal|harvest|
exfiltrate)` near `(credentials|secrets|tokens|keys|env|npm|aws|ssh|kube|docker|
metadata|imds)`; `(ssh keys|aws credentials|npm tokens|github tokens|cloud
metadata|imds)`; `(malware|trojan|supply chain attack)`.

There is also a bounded-response normaliser on the container
(`FileFlagResponse.normalize_bounded_response`, `phases.py:171-187`): a
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
 phases.py:521-529
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

`Flag` (`phases.py:198-202`) is the flat, file-tagged unit: `{file, lines[],
why}`. For the running example: 8 (`setup.js`) + 6 (`index.js`) = **14 flags**,
2 `FileSummary` rows. The `setup.js` entries come first because `source_files`
order comes from `inventory.files`, and that order is what determines hypothesis
numbering: `hyp-0001..hyp-0008` on `setup.js`, `hyp-0009..hyp-0014` on
`index.js`.

---

<a name="12-the-zero-flag-early-return"></a>
## 12. The zero-flag early return (the `chalk` path)

```
 pipeline.py:302-307
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
picks the `total == 0` branch of the rationale (`graph.py:281-286`).

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
 _emit_file_verdicts(summaries, hypotheses, emitter)     pipeline.py:78-108
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
 SEVERITY_SCORE = {"low":3, "medium":6, "high":8, "critical":10}  :41
```

This is called twice in the pipeline: once in the zero-flag path with an empty
hypothesis list (`pipeline.py:304`) and once after `hypothesize`
(`pipeline.py:339`). It is **display only** — nothing reads `FileVerdict` back
into the verdict logic. `suspiciousLines` is `null` for a clean file, which is
why `shared/src/models.ts:109-115` insists on `.nullable()` rather than
`.optional()`: `events.py` dumps payloads with `exclude_none=False`, so an
absent value arrives on the wire as an explicit JSON `null`, and
`z.string().optional()` would throw on it.

---

<a name="13-hypothesize"></a>
## 13. `hypothesize` — hypothesis, claim, experiment

`engine/npmguard/phases.py:718-768` (orchestration),
`phases.py:552-715` (one-shot generator), `engine/npmguard/hypothesis_agent.py`
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
║                                    list; phases.py:734                        ║
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
║  kind ∈ 13 values          phases.py:54-68 / graph.ts:9-23                    ║
║    env_exfil  cred_theft  binary_drop  obfuscation  persistence  destructive  ║
║    propagation  dos_loop  clipboard_hijack  dom_inject  telemetry  dns_exfil  ║
║    build_plugin_exfil                                                         ║
║                                                                               ║
║  gating ∈ 5 values | null   phases.py:69 / graph.ts:27-33                      ║
║    time_gate  geo_gate  ci_gate  inspector_gate  docker_gate                  ║
║    ← "this payload only fires when it thinks it is NOT being watched"         ║
║                                                                               ║
║  ⚠ NOTHING IN THE ENGINE BRANCHES ON claim.kind. Verified: the only reads     ║
║    are prompt text (orchestrator.py:72) and event payloads (phases.py:753,    ║
║    pipeline.py:327,348, orchestrator.py:143). There is no dispatch table,     ║
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
                                                    experiments.py:408-414
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
(`experiments.py:416-427`):

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

And `trigger_targets` (`phases.py:532-535`) computes the allow-list of things the
model may trigger:

```
 dict.fromkeys([*runtime, *install, *bin, flag.file])
 for hyp-0008: ["index.js", "setup.js"]
   runtime=["index.js"] + install=["setup.js"] + bin=[] + flag.file="setup.js"
```

### 13.3 Two generators behind one port, and a union of them

```
┌─ HypothesisGenerator (Protocol) ─────────────── phases.py:538-549 ────────┐
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
   phases.py:552-715                       hypothesis_agent.py:153-404
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

Wired as the default at `pipeline.py:142-144`, with the rationale in the comment:

> One-shot primary, agentic two-phase fallback: the union arms the flags one-shot
> alone can't (measured no single approach wins every route).

`engine/CLAUDE.md:14-15` adds the boundary rule: "Hypothesis generation is
behind `HypothesisGenerator`; keep Kit-specific changes inside
`KitHypothesisGenerator`."

### 13.4 The one-shot generator

```
 KitHypothesisGenerator.generate                        phases.py:559-715
 ┌───────────────────────────────────────────────────────────────────────┐
 │ contents = _safe_file(package_path, flag.file).read_text() (OSError→"")│
 │ focus    = contents[:40_000] + "\n… (truncated)" if longer     :574    │
 │ targets  = trigger_targets(flag, entry_points)                 :575    │
 │ output   = hypothesis_submission(targets)   ← a DYNAMIC Pydantic model │
 │                                               built per call, :263-282 │
 └───────────────────────────────────────────────────────────────────────┘
```

`hypothesis_submission(targets)` uses `pydantic.create_model` to build the JSON
schema handed to the model, with the valid trigger targets **interpolated into
the field description** (`phases.py:271-281`):

```
 HypothesisPlan (extra="forbid" via StrictLlmOutput)
   description   : str
   claim         : ClaimDraft { kind: ClaimKind, gating: Gating|None }
   severity      : Severity
   setup         : ExperimentSetupPlan          phases.py:252-261
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
maps**. `EnvVarDraft` is `{name, value}` (`phases.py:213-217`), `HeaderDraft` is
`{name, value}` (`:225-228`). Models emit arrays of objects far more reliably
than free-form maps under a strict schema, and the duplicate-key check that a map
would give for free is re-added by hand in `decode_plan`
(`phases.py:609-611, 636-638`).

`EnvVarDraft.name` even carries an anti-footgun description: "Never set CI to the
string 'false'; JavaScript treats it as truthy."

Then `decode_plan` (`phases.py:590-673`) converts the nested plan into the flat
`ToolCall[]` the sandbox executes — and this is where most of the semantic
validation lives:

```
 decode_plan(submission) → (submission, calls)
 ┌───────────────────────────────────────────────────────────────────────┐
 │ target = submission.triggerTarget.strip()                             │
 │ strip a leading "runtime:" / "install:" / "bin:" prefix        :595-598│
 │                                                                       │
 │ if target not in targets:                                     :600-605│
 │     if "\n" in target or /\b(const|let|var|require|import)\b|[;{}]/:  │
 │         driver_code = target ; target = "/pkg/npmguard-driver.js"     │
 │         ← the model wrote a PROGRAM instead of naming a file; plant it │
 │     else:                                                             │
 │         CandidateRejected("triggerTarget must be one of {targets} or   │
 │                            contain a JavaScript driver")              │
 │                                                                       │
 │ setup.environment → ToolCall("setEnv", {"env": {...}})        :606-616 │
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
 │ setup.files (+ the planted driver) → ToolCall("plantFiles", …) :617-628│
 │     driver path collision → CandidateRejected("duplicate planted      │
 │                                                driver path")          │
 │ setup.dateIso    → ToolCall("setDate",   {"iso": …})           :629-630│
 │ setup.urlStubs   → ToolCall("stubUrl",   {"stubs": [...]})      :631-647│
 │     headers list→map, duplicate header → CandidateRejected            │
 │ setup.filePatches→ ToolCall("patchFile", {"patches": [...]})    :648-658│
 │ setup.preloadCode→ ToolCall("preload",   {"code": …})           :659-660│
 │ ALWAYS LAST:       ToolCall("trigger", {"kind":"entrypoint",           │
 │                     "target": target, "argv": [], "stdin": None})     │
 │                                                                :661-671│
 │ compile_experiment(calls)   ← the REAL oracle runs INSIDE the decode, │
 │                                so a non-compiling plan is a rejected  │
 │                                candidate, not a runtime failure :672   │
 └───────────────────────────────────────────────────────────────────────┘
```

Failure handling, and then the load gate:

```
 phases.py:675-698
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

The comment at `phases.py:691-692` explains why a one-shot *load* failure is a
failover rather than a retry: "The one-shot decode has no repair channel for a
payload that compiles but cannot load. Fail over to the agentic generator, which
dry-runs and repairs." Compiling proves the *shape* of the tool calls; only
running proves the *payload* resolves its imports.

If everything passes, the `Hypothesis` is constructed at `phases.py:699-715` with
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
                 audit_id, emitter)                     phases.py:718-768
 ┌───────────────────────────────────────────────────────────────────────┐
 │ created_at = ONE timestamp for the whole batch                 :728   │
 │ output     = [None] * len(flags)   ← index-aligned              :729   │
 │ semaphore  = Semaphore(NPMGUARD_TRIAGE_CONCURRENCY, default 8)  :730   │
 │                                                                       │
 │ arm(index):                                                           │
 │   hypothesis_id = f"hyp-{index+1:04d}"                          :734   │
 │   emit file_analyzing {file: flag.file}                          :737   │
 │   output[index] = await generator.generate(flag, …)              :738   │
 │   emit hypothesis_emitted {hypId, claim, severity, file}         :749   │
 │                                                                       │
 │ await _gather_fail_fast(arm(i) for i in range(len(flags)))        :759   │
 │ for item in output:                                                   │
 │     assert item is not None      ◀── len(hypotheses) == len(flags)     │
 │     hypotheses.append(item)                                     :761-767│
 └───────────────────────────────────────────────────────────────────────┘
```

The assertion's comment (`phases.py:762-765`) is the point of the whole phase:

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
                                                    experiments.py:311-345
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
 Every ERROR above is ExperimentCompileError (a ValueError), experiments.py:32
```

Exactly one trigger, always. `shared/src/evidence.ts:100-105` states the
consequence: "An `args` shape that a tool's schema rejects is an incoherent
experiment (an ERROR), never silently run."

### 14.2 The six builders — each returns a `Manipulation`

```
┌─ Manipulation ──────────────────────────────── experiments.py:36-46 ──────┐
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
| `stubUrl` | set 7 proxy env vars; `post_start` writes `assets/stub-proxy.js` into `/tmp` and launches it detached; wait for readiness | `{"stubUrls": [StubUrlRef(pattern, responseHash)]}` | `:201-298` |
| `patchFile` | `post_start` reads `/pkg/{path}`, applies literal `str.replace` pairs, writes back only if changed; path must be **relative** with no `..` | `{"patches": [FilePatchRef(path, patchHash)]}` | `:146-198` |
| `preload` | `post_start` writes the code to `/tmp/npmguard-preload.js`; `preload` field points at it | `{"preloadHash": sha256(code)}` | `:131-143` |

Note the deliberate asymmetry in path rules: `plantFiles` demands **absolute**
paths (`:101-104`) because it plants bait anywhere in the container filesystem
(`/home/node/.npmrc`); `patchFile` demands **relative, no-`..`** paths
(`:155-159`) because it may only rewrite files inside the package under test.

Note also that content is recorded as a **hash**, never as the literal value.
`SetupApplied` (`shared/src/evidence.ts:140-149`) carries
`PlantedFileRef{path, contentHash}`, `StubUrlRef{pattern, responseHash}`,
`FilePatchRef{path, patchHash}`, and `preloadHash` — but `env` is stored as
literal `record(string)`, because the judge needs to see planted canary *names*
and values to correlate them with observed reads.

### 14.3 `stubUrl` in detail — why a stub needs a readiness barrier

`stubUrl` is the most involved builder because it must guarantee something
subtle: *the fake HTTP server is definitely serving before the package runs*.

```
 _stub_url environment (experiments.py:241-249)
   HTTP_PROXY / HTTPS_PROXY / http_proxy / https_proxy = http://127.0.0.1:18080
   NO_PROXY = ""              ← so nothing is exempted
   NPMGUARD_STUBS = <compact JSON of the stub list>
   NPMGUARD_STUB_PORT = "18080"

 post_start (experiments.py:251-296)
 ┌───────────────────────────────────────────────────────────────────────┐
 │ write /tmp/npmguard-stub-proxy.js  (assets/stub-proxy.js bytes)        │
 │ docker exec -d <c> sh -c "node /tmp/npmguard-stub-proxy.js             │
 │                            2>/tmp/npmguard-stub-proxy.log"            │
 │   exit != 0 → RuntimeError("stubUrl proxy failed to launch: …")        │
 │                                                                       │
 │ THE BARRIER — poll the proxy's OWN markers, up to 120 s, every 100 ms: │
 │   if -f /tmp/npmguard-stub-proxy.ready → READY  → return              │
 │   elif -f /tmp/npmguard-stub-proxy.err → ERR    → RuntimeError(
 │        "stubUrl proxy crashed on startup: …")                         │
 │   (both markers are written by the proxy itself)                      │
 │ on timeout: cat the .log and raise "stubUrl proxy did not become ready │
 │   within 120s: {detail}"                                              │
 └───────────────────────────────────────────────────────────────────────┘
```

The comment at `experiments.py:270-275` records what this replaced: "the old
30×50 ms loop of node-cold-start TCP probes, which could neither distinguish a
crash from a slow bind nor survive a tail spike."

The proxy itself (`engine/npmguard/assets/stub-proxy.js`) is written to make its
own state observable, because `docker exec -d` discards stderr and `docker logs`
only shows PID 1:

```
 assets/stub-proxy.js
   process.on('uncaughtException', e => fail(e.stack))          :18
   server.on('error', e => fail('listen error: ' + e.stack))    :70
     ← a bind failure (EADDRINUSE) arrives as an EVENT, not a throw; without
       this handler it would be a silent death
   fail(reason): write reason to /tmp/npmguard-stub-proxy.err,
                 print to stderr, process.exit(3)               :13-17
   listen(PORT, '127.0.0.1', () => write /tmp/npmguard-stub-proxy.ready) :71-78

   matchStub(url):  escape every regex metacharacter in the pattern, then
     turn the escaped `\*` back into `.*`, anchor with ^…$      :29-45
     ⇒ "*" is the ONLY wildcard; everything else is literal
   matched   → writeHead(status, headers); end(body)            :53-57
   unmatched → 502 "stub-proxy: no matching stub for {url}"     :58-59
   CONNECT   → 502 (HTTPS MitM is not supported)                :62-66
```

Two consequences for reading real timelines: an HTTPS target cannot be stubbed
(only the `CONNECT` attempt is observable), and an *unmatched* HTTP request still
reaches the proxy and gets a 502 — so it appears as a `network`/`http_request`
event even though no stub served it. In the `hyp-0008` timeline, the POST is
rendered `POST http://localhost/exfil` (no port) while the stub pattern was
`http://localhost:9999/exfil` — and six other hypotheses' judges cited exactly
that mismatch as grounds to refute (§16.8).

### 14.4 `compose` and `merge_container_spec`

```
 compose(primitives: list[Manipulation]) -> ComposedSetup   experiments.py:348-395
   envs      : dict, later primitives OVERWRITE earlier keys
   ld_preload/preload/hostname : LAST non-None wins
   volumes   : concatenated        cap_add : concatenated then deduped
   post_starts : collected in order            events : concatenated
   applied   : plantFiles/stubUrls/patches EXTEND;
               env UPDATES; everything else OVERWRITES
   → SetupApplied(**applied)     ← the sealed, auditable record

 merge_container_spec(base, setup) -> ContainerSpec         experiments.py:398-405
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
 TERMINAL_STATES = {CONFIRMED, REFUTED, DEFERRED}                graph.py:17
 There is deliberately NO "inconclusive". shared/src/graph.ts:48-54:
   "a run either fired, refuted, or could not be evaluated."
```

### 15.2 `add` — the armed invariant

```
 HypothesisGraph.add(hypothesis)                          graph.py:82-103
 ┌───────────────────────────────────────────────────────────────────────┐
 │ parsed = Hypothesis.model_validate(hypothesis)   ← revalidate, always  │
 │                                                                       │
 │ if parsed.state == "OPEN" and not parsed.experiment:                   │
 │     raise AssertionError(f"graph: unarmed hypothesis {hypId} admitted  │
 │                           as OPEN")                            :84-89 │
 │   ◀── "the generators return an armed, dry-run-verified Hypothesis or  │
 │       raise, so dispatch can trust any node it picks without           │
 │       re-checking."                                                   │
 │                                                                       │
 │ if hypId already present: HypothesisGraphError("duplicate hypId: …")   │
 │ if parentHypId is not None:                                    :92-100│
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
 build_graph(audit_id, hypotheses)                        graph.py:223-230
   graph = HypothesisGraph(audit_id) ; merged = added = 0
   for h in hypotheses:
       _, did_merge = graph.add_or_merge(h)
       merged += int(did_merge) ; added += int(not did_merge)
   return graph, merged, added

 add_or_merge(h, threshold=0.88)                          graph.py:117-143
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

`similar_description` (`graph.py:63-67`) lowercases, collapses whitespace, and
compares with Jaro-Winkler ≥ `DEFAULT_MERGE_THRESHOLD = 0.88` (`graph.py:18`).
`jaro_winkler` is implemented from scratch at `graph.py:30-60`: a match window of
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
 next_open(graph)                                        graph.py:233-239
   nodes = graph.filter_by_state("OPEN")
   return min(nodes, key=lambda n: (-SEVERITY_ORDER[n.severity or "medium"],
                                    n.createdAt))    if nodes else None
 SEVERITY_ORDER = {"critical":4, "high":3, "medium":2, "low":1}     :19
```

Highest severity first; `createdAt` ascending as tie-break. But
`run_hypothesize` gives every hypothesis in a batch the **same** `created_at`
(`phases.py:728`), so the tie-break is inert and `min`'s stability leaves
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
            resolved_at=None)                            graph.py:154-191
 ┌───────────────────────────────────────────────────────────────────────┐
 │ GUARD 1 — no exit from a terminal state              :165-168         │
 │   if current.state in TERMINAL_STATES:                                │
 │       HypothesisGraphError(f"cannot transition {id} out of terminal    │
 │                             state {state}")                           │
 │                                                                       │
 │ refs = current.evidenceRefs + (evidence_refs or [])                   │
 │                                                                       │
 │ GUARD 2 — evidence is mandatory for a decision       :169-172         │
 │   if to in {"CONFIRMED","REFUTED"} and not refs:                      │
 │       HypothesisGraphError(f"transition to {to} requires at least one  │
 │                             evidenceRef (got 0)")                     │
 │   ◀── THIS is the mechanical meaning of "evidence-bound". Neither     │
 │       DANGEROUS nor SAFE can be reached without a pointer to a sealed │
 │       RunArtifact. Note it accepts refs ALREADY on the node too, so   │
 │       add_evidence() then transition() also satisfies it.             │
 │                                                                       │
 │ GUARD 3 — a deferral must say why                    :173-175         │
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

`add_evidence` (`graph.py:145-152`) appends refs without changing state — used by
the orchestrator so a DEFERRED node still points at the (unusable) run that was
attempted.

`serialize` (`graph.py:193-200`) produces `HypothesisGraphSnapshot{version: 1,
auditId, nodes, createdAt, updatedAt}` (`shared/src/graph.ts:112-118`), written
twice by the pipeline: `graph.json` right after building
(`pipeline.py:357`) and `graph-final.json` after the orchestrator
(`pipeline.py:389`). `load`/`load_from` (`graph.py:206-220`) can rebuild a graph
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
║ L1  kernel   stream "L1:seccomp"                     sensors.py:75-156       ║
║   HOW: the trigger command is wrapped in                                     ║
║        strace -f -ttt -s 4096 -o /tmp/strace.log -e trace=<20 syscalls>      ║
║        requires cap SYS_PTRACE (observation.py:147)                          ║
║   TRACED_SYSCALLS (sensors.py:13-35), 20 of them:                            ║
║     openat open read write unlink unlinkat rename renameat renameat2         ║
║     link linkat connect sendto recvfrom accept accept4 execve clone          ║
║     clone3 fork vfork                                                        ║
║   SEES: file opens/reads/writes with PATHS, process execs with ARGV,          ║
║         outbound connects with ip:port, deletes, renames, links, forks       ║
║   BLIND TO: which JavaScript line did it; read/write carry only an fd        ║
║             (resolved later by the renderer, §17.4)                          ║
║                                                                              ║
║ L2  network  stream "L2:pcap"                       sensors.py:258-446       ║
║   HOW: tcpdump -i any -U -Z root -w /tmp/npmguard-capture.pcap, started      ║
║        BEFORE the trigger, TERMed after; parsed with                          ║
║        tshark -T json -Y "dns.qry.name or http.request or                    ║
║                           tls.handshake.extensions_server_name" -2           ║
║        requires network_mode=bridge + caps NET_RAW SETUID SETGID             ║
║   SEES: dns_query{host}, http_request{host,method,path}, tls_sni{host}       ║
║   BLIND TO: HTTPS payloads (encrypted); the pcap gives SNI only              ║
║                                                                              ║
║ L3  fsDiff   stream "L3:fsDiff"                     sensors.py:226-255       ║
║   HOW: before and after the run,                                             ║
║        find /pkg /home/node -type f -printf '%p\t%s\t%T@\n' | sort           ║
║        then diff the two maps                                                ║
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
║                                    → {type:"crypto", method, algo}   :61-72  ║
║     global.setTimeout / setInterval→ {type:"timer", kind, ms}        :74-83  ║
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
║    e.g. kind="truncated" when the wall budget is hit. evidence.py:184-192)   ║
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
 default_container_spec + overrides                observation.py:137-149
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
 │ volumes      [ host <package_path> → /pkg-src  READ-ONLY ]            │
 │ tmpfs        /tmp       rw,noexec,nosuid,size=64m                      │
 │              /pkg       rw,size=256m,uid=1000,gid=1000,mode=0755       │
 │              /home/node rw,size=64m,uid=1000,gid=1000,mode=0755        │
 └───────────────────────────────────────────────────────────────────────┘
 spec_to_docker_args (docker.py:91-124) renders that, ending with
   -w /pkg <image> sleep infinity
 ⇒ the container is a long-lived shell we `docker exec` into, not a one-shot.
```

The `/pkg-src` (read-only bind) → `/pkg` (writable tmpfs) split is the key
arrangement. The host directory can never be modified by the sandbox; the first
thing the run does is `cp -a /pkg-src/. /pkg/` (`observation.py:205-207`), giving
the package a writable copy it can mutate freely. `/home/node` is a tmpfs so
planted credential bait lives in RAM and evaporates with the container. `preload`
becomes `NODE_OPTIONS=--require <path>`, appended to any existing `NODE_OPTIONS`
(`docker.py:111-115`).

### 16.3 `run_under_observation` — the exact sequence

```
 run_under_observation(package_path, experiment, settings, *, observe, budget)
                                                    observation.py:125-340
 run_id = f"run_{uuid4().hex[:26]}"              ← e.g. run_e8596819e848454e91d54b5a5e
 compiled = compile_experiment(experiment)       ← compiled a SECOND time here
 observed = ObserveFlags(**{**DEFAULT_OBSERVE, **observe})
 limits   = Budget(**{**DEFAULT_BUDGET, **budget})
 setup    = compose(compiled.setup) ; spec = merge_container_spec(base, setup)
 container = f"npmguard-run-{run_id[4:16]}"
 events   = list(setup.events) ; error = None
 ─────────────────────────────────────────────────────────────────────────────
  0. START THE CONTAINER, with up to 3 attempts        :168-193
     docker run -d …   FileNotFoundError → DockerUnavailableError (0020)
     CancelledError → `docker rm -f` FIRST, then re-raise
       ◀── the try/finally is not active yet, and `docker run -d` may have
           created the container daemon-side before the cancel landed :175-182
     exit != 0 → `docker rm -f`, sleep 0.5×(attempt+1), retry
     still failing → RunUnderObservationError("failed to start sandbox
       container", detail=f"docker run exit={c} after 3 attempts: {stderr}")
 ┌── try: ────────────────────────────────────────────────────────────────────┐
 │ 1. if network: start_pcap(container)                 :196-202              │
 │      exception → error = RunError("SensorError", str(exc))                 │
 │ 2. if error is None: cp -a /pkg-src/. /pkg/          :204-212              │
 │      exit != 0 → error = RunError("SetupError", "failed to copy …")        │
 │ 3. if error is None and node: write /tmp/_instrument.js  :214-224          │
 │      = monkey [+ inspector] + flush, concatenated (docker.py:144-150)      │
 │      exception → error = RunError("SensorError", "failed to write L4 …")   │
 │ 4. if error is None: run every setup.post_starts hook IN ORDER  :226-232   │
 │      first exception → error = RunError("SetupError", str(exc)); break     │
 │      ⇒ plantFiles writes bait; stubUrl launches + awaits the proxy;        │
 │        patchFile rewrites files; preload writes its script                 │
 │ 5. run_start_sec = time.time()   ← the L1/L3 timestamp origin  :234        │
 │    if fsDiff: snapshot_pre(container)                :235-239              │
 │      exception → error = RunError("SensorError", …)                        │
 │ 6. if error is None: THE TRIGGER                     :241-293              │
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
 │ 7. if fsDiff and error.kind not in {SetupError,SensorError}:  :295-304     │
 │      snapshot_post → events.extend(diff); fs_diff_hash = sha256(raw)      │
 │ 8. if network and error.kind != "SetupError":         :306-313             │
 │      stop_pcap → events.extend(pcap.events); pcap_hash = sha256(raw_pcap) │
 └── finally: docker rm -f <container>, exceptions suppressed  :314-316 ──────┘
 events.sort(key=lambda e: e.timestamp)                :318
 return seal_run_artifact({...})                       :319-340
```

Three structural properties of that sequence deserve naming:

**Error latching.** `error` is set once and then gates later steps. So the
*first* thing that went wrong is what the artifact reports, and later sensors do
not overwrite it. The post-run steps have carefully different gates: fs-diff
skips only on `SetupError`/`SensorError` (a crashed run still produced a
filesystem state worth diffing), and pcap-stop skips only on `SetupError` (if
setup never completed, the capture is meaningless).

**The container is always removed.** `finally` at `:314-316`, plus the special
pre-`try` cancellation handling at `:175-182`.

**Timestamps come from three different clocks.** L1 is `(strace_time -
run_start_sec) * 1e9` nanoseconds (`sensors.py:149`); L3 is `(mtime -
run_start_sec) * 1e9`, also clamped at 0 (`sensors.py:178`); L2 is
`frame.time_relative * 1e9` (`sensors.py:339-342`); **L4 is a logical index** —
`timestamp=index`, the position in the flush array (`evidence.py:142`). So the
global `events.sort` at `:318` puts all L4 events (tiny integers) before all
wall-clock events (hundreds of millions). The renderer does not fight that; it
splits them into two explicitly-labelled sections (§17.4).

### 16.4 `build_trigger_command` — how a target becomes a command line

```
 build_trigger_command(trigger, l4)                observation.py:107-122
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
piped separately via `docker exec -i` (`observation.py:255-256`) rather than
being encoded into argv.

Also note: `Trigger.kind` has four legal values in the contract
(`shared/src/evidence.ts:82`) and `compile_experiment` accepts all four
(`experiments.py:322`), but only `entrypoint` and `subpath` are runnable.
`lifecycle` and `bin` produce a `SetupError` → DEFER. In practice the generators
always emit `kind: "entrypoint"` (`phases.py:665`,
`hypothesis_agent.py:326`), and a lifecycle hook is reached by targeting its
*file* — which is why `entryPoints.install` exists and why `hyp-0008` triggers
`setup.js` directly rather than asking for `preinstall`.

### 16.5 The sensor readiness barriers

Both L2 barriers exist because "I started the sensor" is not the same as "the
sensor is capturing", and the gap between them is exactly where evidence gets
silently lost.

```
 start_pcap(container)                              sensors.py:264-306
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

 THE INVARIANT (sensors.py:283-289):
   start_pcap returns ⟺ tcpdump is CONFIRMED capturing. "`exec -d` returning
   proves only that the exec was created; a trigger must never fire into a
   dead capture (silently dropping the network-evidence burst)… On any
   failure raise (→ SensorError → DEFER), never proceed uncaptured."
```

```
 stop_pcap(container)                               sensors.py:394-446
   pkill -TERM tcpdump
     exit != 0 → RuntimeError("tcpdump was not running at stop — capture died
                  mid-run: …")
     INVARIANT (:395-398): tcpdump captured CONTINUOUSLY from start to this
     TERM. A no-match pkill means network evidence was silently lost — a
     SensorError (→ DEFER), "never an empty pcap that could refute."
   THEN the flush barrier (≤ 10 s): poll `pgrep -x tcpdump || true`
     break ONLY when exit_code == 0 AND stdout is empty
     ◀── ":413-415" — a FAILED or timed-out exec also has empty stdout and
         proves nothing; treating that as "exited" would read a torn capture
   timeout → RuntimeError("tcpdump did not flush and exit within 10s of
             SIGTERM")
   base64 -w0 the pcap out; tshark -T json -Y <filter> -2
     tshark exit != 0 → RuntimeError("tshark parse failed: …")
     ◀── ":444" — "A failed parse is missing evidence, not absent traffic —
         fail loud."
```

Every one of those `RuntimeError`s is caught at `observation.py:196-202` /
`:306-313` and turned into a `SensorError`, which the orchestrator maps to
**DEFERRED**. The consistent principle: *missing evidence must never look like
absent behaviour*.

The same principle governs L1 and L4. An unreadable strace log is a
`SensorError` (`observation.py:288-293`). Missing L4 markers are a `SensorError`
whose detail names the suspicion directly: `"L4 trace markers absent from stdout
(instrumentation evaded or suppressed)"` (`observation.py:277-281`). And in the
strace parser, an unmapped syscall is an outright `AssertionError`:

```
 sensors.py:36-42 (comment) and :116-121 (code)
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
 LOAD_CHECK_BUDGET  = {"wallMs": 10_000}              observation.py:65-72

 dry_run_load(package_path, experiment, settings) -> RunError | None
                                                      observation.py:86-104
   try:    artifact = await run_under_observation(..., LOAD_CHECK_*)
   except (DockerUnavailableError, RunUnderObservationError): return None
       ◀── best-effort: an unavailable sandbox SKIPS the gate and lets the
           full-oracle run surface real infrastructure faults
   return artifact.error if is_unresolved_module(artifact.error) else None

 is_unresolved_module(error)                          observation.py:75-83
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
(`observation.py:77-79`): the hypothesise dry-run gate (a *fixable* bad require →
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
 │    ◀── the artifact hashed ITSELF at seal time (evidence.py:224-229) and  │
 │        the store hashes it AGAIN independently (evidence.py:88-96). The   │
 │        two must agree, or the evidence is not trustworthy.                │
 │                                                                           │
 │ E. PERSIST THE HUMAN-READABLE RECORD                           :196-214   │
 │    log.write(f"timeline-{hypId}.md", result.timeline)                    │
 │    log.write(f"experiment-{hypId}.json", {hypId, confirmed, reason,      │
 │      citedEvents, runId, artifactHash, evidenceRef, wallMs, eventCount,  │
 │      eventSummary, error})                                               │
 │                                                                           │
 │ F. RESOLVE — see the decision table below                      :215-256   │
 └───────────────────────────────────────────────────────────────────────────┘
 emit hypothesis_resolved {hypId, claim, severity, state, by, reason}  :304
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
       (observation.py:57-60), so a genuine non-transient failure stays
       diagnosable rather than surfacing as an opaque "Worker error"

 except Exception as exc:                                            :284-303
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

The output schema is minimal (`phases.py:190-195`):

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
 canonicalize(value)                                  evidence.py:33-43
   _plain(value)   ← recursively model_dump every BaseModel with
                     mode="json", exclude_none=False   (:23-30)
   rfc8785.dumps(value).decode("utf-8")
     ← RFC 8785 JSON Canonicalization Scheme: deterministic key order,
       ECMAScript number/string semantics
   FloatDomainError   → ValueError("non-finite number … not representable")
   IntegerDomainError → ValueError
   CanonicalizationError → TypeError

 sha256_hex(value)     = hashlib.sha256(utf-8 bytes).hexdigest()   :46-47
 content_hash_of(value) = sha256_hex(canonicalize(value))          :50-51
```

Canonicalisation is what makes a content hash *reproducible*. Two processes
serialising the same artifact must produce byte-identical JSON, or the hash — and
therefore the evidence reference — differs for no semantic reason. `exclude_none=
False` is part of that contract: an optional field is always present as `null`,
never omitted.

### 17.2 Sealing an artifact

```
 seal_run_artifact(draft)                             evidence.py:224-229
   parsed = RunArtifact.model_validate({**draft, "contentHash": ""})
   value  = parsed.model_dump(mode="json", exclude_none=False)
   return RunArtifact.model_validate({**value,
     "contentHash": content_hash_of({**value, "contentHash": ""})})
   ⇒ the hash covers the artifact with its OWN hash field blanked, so it is
     self-verifying without circularity.
```

```
┌─ RunArtifact — THE UNIT OF EVIDENCE ────── shared/src/evidence.ts:208-228 ┐
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
│ inspectorLogHash null   ← ALWAYS null; observation.py:335 hardcodes it     │
│ eventSummary   {uniqueHosts:["169.254.169.254","localhost"],               │
│                 uniqueSyscalls:["clone","connect","execve","openat",       │
│                                 "read","sendto","write"],                  │
│                 filesWritten:[], dnsQueries:[]}                            │
│ contentHash    "5033b1e9253fb81bce034a564c19c97c6912522c16f8bf12373ee8bdea │
│                 b981c0"    ◀── THE VALUE THAT APPEARS IN EvidenceRef.hash  │
│ createdAt      "2026-07-23T10:12:20.150838Z"                               │
└────────────────────────────────────────────────────────────────────────────┘
```

`eventSummary` is derived by `compute_event_summary` (`evidence.py:195-221`):
`uniqueSyscalls` from any event whose kind is in `SYSCALL_KINDS`
(`evidence.py:18-20`); `uniqueHosts` from L4 `network` URLs (via `urlparse`
hostname) plus L2 `http_request`/`tls_sni` hosts; `filesWritten` from
`write`/`file_created`/`file_modified` paths; `dnsQueries` from `dns_query`
hosts. All four are sorted, so the summary is deterministic.

### 17.3 `ArtifactStore` — content-addressed on disk

```
 ArtifactStore(root_dir)  → self.artifacts_dir = root_dir/"artifacts"
                                                      evidence.py:69-106
   root_dir is the AuditLog run directory (pipeline.py:159), i.e.
   audit-logs/<iso-stamp>_<safe-package-name>/artifacts/

 write_blob(data, ext)   → path = <digest>[.<ext>]; write only if absent
 write_artifact(partial) → validate with contentHash="", hash the blanked
   value, set contentHash, write canonical JSON to <digest>.runartifact.json
 read_artifact(digest)   → RunArtifact.model_validate_json(...)
 verify_artifact(digest) → re-blank contentHash, re-hash, compare to digest
 merkle_root(hashes)     → pairwise sha256(concat), duplicating the last odd
                            leaf; [] → sha256("")                :54-66
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
 render_timeline(artifact) -> RenderedTimeline{text, ids}   evidence.py:238-307
 ┌───────────────────────────────────────────────────────────────────────┐
 │ home = setupApplied.env["HOME"] or "/home/node"                       │
 │ shorten(v) = "~" + v[len(home):] if v.startswith(home) else v,        │
 │              then truncate at 100 chars with "…"      :239-242, 421-422│
 │                                                                       │
 │ SPLIT the events into two groups, each sorted by timestamp:  :244-251 │
 │   node  = streams starting "L4"       ← logical order, NO clock       │
 │   clock = everything else (L1, L2, L3, engine) ← wall-clock t+        │
 │   ◀── because L4 timestamps are ARRAY INDICES, not times (§16.3)      │
 │                                                                       │
 │ fds = {0:("stdin",False), 1:("stdout",False), 2:("stderr",False)}     │
 │   ← seeded with the three standard descriptors           :252-256     │
 │                                                                       │
 │ rows = _collapse([_describe(e, shorten, fds) for e in group])         │
 │   _collapse (:310-318): consecutive rows with the SAME                │
 │   (tag, verb, target) become one row with count and first/last ts     │
 │                                                                       │
 │ ids are assigned by a single counter across BOTH sections: e1, e2, …  │
 │   and collected into `identifiers`                        :259-267    │
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
in the renderer (`evidence.py:342-360`):

```
 on kind "openat":  verb="open", target=shorten(path)
                    if int(ret) >= 0:  fds[ret] = (target, False)
 on kind "read"/"write": target = fds.get(fd, (f"fd:{fd or '?'}", False))[0]
 on kind "connect"/"sendto": verb = "connect"|"send"
                    target = f"{addr}:{port or '?'}" if addr
                             else fds.get(fd, ("socket", True))[0]
                    if fd is not None: fds[fd] = (target, True)
 the fd itself is scraped from raw with re.match(r"^\w+\((-?\d+)", raw)  :330-331
```

So `write(1, …)` renders `write stdout`, and `write(5, …)` after
`openat("~/.npmrc") = 5` renders `write ~/.npmrc`. That single mechanism is what
makes the false-positive class impossible without any predicate.

`_describe` (`evidence.py:321-418`) has an explicit arm for every `EventKind` in
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
(`evidence.py:332-339`).

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
 e40   env      https_proxy                  sweeping OUR stubUrl env vars
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

`graph.py:250-286`. Twenty-six lines. Two assertions. This is the whole verdict
logic.

```
 derive_graph_verdict(graph) -> GraphVerdict
 ┌───────────────────────────────────────────────────────────────────────┐
 │ nodes  = graph.all()                                                  │
 │ counts = HypothesisCounts(total, open, inProgress, confirmed,          │
 │                           refuted, deferred)                          │
 │                                                                       │
 │ ── ASSERTION 1 ──────────────────────────────────────────── :264-267  │
 │ if counts.open or counts.inProgress:                                  │
 │     raise AssertionError(f"derive_graph_verdict: {n} unresolved        │
 │                            node(s)")                                  │
 │   ⇒ NO VERDICT WHILE ANY SUSPICION IS STILL PENDING.                  │
 │                                                                       │
 │ confirmed_ids = [n.hypId for n in nodes if n.state == "CONFIRMED"]     │
 │                                                                       │
 │ ── DANGEROUS ────────────────────────────────────────────── :269-276  │
 │ if counts.confirmed:                                                  │
 │     return GraphVerdict("DANGEROUS",                                  │
 │       f"{n} confirmed hypothes{'esis'|'eses'} with cited dynamic       │
 │        evidence.", counts, confirmed_ids)                             │
 │   ⇒ ANY confirmation wins, regardless of how many deferrals exist.    │
 │                                                                       │
 │ ── ASSERTION 2 ──────────────────────────────────────────── :277-280  │
 │ if counts.deferred:                                                   │
 │     raise AssertionError(f"derive_graph_verdict: SAFE with {n}         │
 │                            unevaluated node(s)")                      │
 │   ⇒ A DEFERRED HYPOTHESIS CAN NEVER PRODUCE SAFE.                     │
 │                                                                       │
 │ ── SAFE ─────────────────────────────────────────────────── :281-286  │
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
 pipeline.py:390-399
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

**Mechanism 2 — the assertion (defence in depth).** `graph.py:277-280` is
unreachable *from `AuditPipeline.run`*, precisely because Mechanism 1 fires
first. It exists so that any *other* caller of `derive_graph_verdict` — a test, a
future consumer, a refactor that reorders the pipeline — cannot produce a `SAFE`
with unevaluated nodes. It fails loudly as an `AssertionError`, which
`AuditService._execute` maps to `NPMGUARD-9999`, `retryable=False`
(`service.py:309-310`) — an unmistakable bug signature rather than a silent
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
 _report(graph, summaries, trace, *, dealbreaker=None)   pipeline.py:111-125
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
      │  read by run_flag (phases.py:426), numbered, sent to the flag model
      ▼
 [2] FLAG raises a suspicion — Flag{file:"setup.js", lines:["120-120",
     "123-123"], why:"Probes IMDS asynchronously and exfiltrates all stolen
     data — auto-execution on require/import."}
      │  no code path exists from a Flag to a report without a Hypothesis:
      │  run_hypothesize asserts len(hypotheses) == len(flags) (phases.py:766)
      ▼
 [3] HYPOTHESIZE arms it — Hypothesis hyp-0008 with a 4-call experiment
      │  compile_experiment must succeed (experiments.py:311-345)
      │  AND dry_run_load must find no unresolved module
      │      (hypothesis_agent.py:337-343)
      │  graph.add refuses an OPEN node with an empty experiment
      │      (graph.py:84-89); the orchestrator re-asserts at dispatch
      │      (orchestrator.py:180-183)
      ▼
 [4] A REAL CONTAINER RUNS IT — run_e8596819e848454e91d54b5a5e
     bait planted, IMDS stubbed, setup.js required, five sensors recording
      │  the artifact is SEALED: contentHash = sha256(canonical JSON with
      │  contentHash blanked) (evidence.py:224-229)
      │  the store re-hashes independently; a mismatch RAISES
      │      (orchestrator.py:189-195)
      ▼
 [5] 192 events → a rendered timeline with contiguous ids e1..e147
      │  render_timeline returns `ids`, the exact set of citable ids
      │      (evidence.py:232-235, 259-267)
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
      │      (graph.py:169-172)
      ▼
 [8] derive_graph_verdict: counts.confirmed == 1 → DANGEROUS
      │  Assertion 1: no OPEN/IN_PROGRESS node may exist (graph.py:264-267)
      │  Assertion 2: SAFE with any DEFERRED node is impossible
      │      (graph.py:277-280)
      │  Pipeline gate: 0 confirmed + ≥1 deferred → AuditIncompleteError
      │      (pipeline.py:390-399)
      ▼
 [9] AuditReport{verdict:"DANGEROUS", confirmedHypIds:["hyp-0008"]}
     → save_report to disk → ONE TRANSACTION: row→'done' +
       verdict_reached frame (service.py:284-302)
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
 │    failed, the stubUrl proxy did not become ready within 120 s, or       │
 │    trigger.kind was "lifecycle"/"bin".                                   │
 │      observation.py:204-212, 226-232, 241-247; experiments.py:280-296    │
 │                                                                          │
 │ D2 SensorError — tcpdump did not confirm 'listening on' within 15 s;     │
 │    tcpdump was not running at stop; tshark parse failed; the strace log  │
 │    was unreadable; the L4 __NPMGUARD_TRACE__ markers were absent from    │
 │    stdout; the instrumentation file could not be written.                │
 │      sensors.py:304-306, 399-405, 443-445; observation.py:214-224,       │
 │      275-293                                                            │
 │                                                                          │
 │ D3 TimeoutError — the run exceeded EXPERIMENT_BUDGET.wallMs = 20 000 ms; │
 │    the container was killed and a synthetic "truncated" event added.     │
 │      observation.py:260-269                                             │
 │                                                                          │
 │ D4 judge_failed — ANY exception from the judge model call (provider      │
 │    outage, budget, unrepairable output). Note the JudgeVerdict           │
 │    fabricated in that path has malicious=False, but judge_failed=True    │
 │    routes it to DEFER, so a dead judge can never refute.                 │
 │      orchestrator.py:100-103, 231-247                                   │
 │                                                                          │
 │ D5 unresolved_module — CrashError whose detail contains "Cannot find     │
 │    module" or "MODULE_NOT_FOUND": the program never loaded.             │
 │      observation.py:75-83; orchestrator.py:226-241                      │
 │                                                                          │
 │ D6 per-hypothesis timeout — the whole setup+run+judge exceeded           │
 │    PER_HYPOTHESIS_SECONDS = 360.                orchestrator.py:257-271 │
 │                                                                          │
 │ D7 sandbox unavailable — RunUnderObservationError (docker run failed 3×) │
 │    or DockerUnavailableError (no docker binary).                        │
 │      observation.py:168-193; orchestrator.py:272-283                    │
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
`confirmed == 0` and `deferred == 2` → `pipeline.py:391` → `AuditIncompleteError`
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
`stage` (`errors.py:6-19`).

| Code | Class | HTTP | Retryable | Raised where | Meaning |
|---|---|---|---|---|---|
| `NPMGUARD-0001` | `PackageNotFoundError` | 404 | no | `resolve.py:50` | the registry returned 404 for `{name}/{version}` |
| `NPMGUARD-0002` | `ValidationError` | 400 | no | **nowhere** | declared, no raise site (§24.11) |
| `NPMGUARD-0010` | `LLMUnavailableError` | 503 | yes | **nowhere** | declared, no raise site (§24.11) |
| `NPMGUARD-0020` | `DockerUnavailableError` | 503 | yes | `observation.py:173`, `deps.py:99` | the `docker` binary is not on PATH (`FileNotFoundError`) |
| `NPMGUARD-0030` | `AuditTimeoutError` | 504 | yes | `pipeline.py:69` | a `_timed_phase` exceeded its budget; carries `stage=phase` |
| `NPMGUARD-0031` | `AuditIncompleteError` | 503 | yes | 10 sites — see below | the audit could not complete; carries `stage` |
| `NPMGUARD-0040` | `QueueFullError` | 503 | yes | `service.py:76` | ≥ 50 durable `queued` rows |
| `NPMGUARD-0050` | `SessionLimitError` | 503 | yes | **nowhere** | retired: the running-count cap was replaced by the wait queue + worker pool |
| `NPMGUARD-9999` | `NpmGuardError` (base) | 500 | no | — | the fallback for any non-`NpmGuardError` exception |

`NPMGUARD-0031` is the workhorse. Its ten raise sites, by stage:

```
 stage="flag"
   phases.py:388  file escapes package root: {relative}
   phases.py:428  could not analyze {path}: file-unreadable
   phases.py:508  could not analyze {path}: model call failed: {exc}

 stage="hypothesize"
   phases.py:688            could not arm {file} ({why}) after bounded repair
   phases.py:695            one-shot experiment for {file} did not load: …
   hypothesis_agent.py:194  agentic build failed to arm {file} ({why}): {exc}
   hypothesis_agent.py:232  proposal did not produce a valid hypothesis: {exc}
   hypothesis_agent.py:401  agent finished without a compiled trigger

 stage="orchestrator"
   pipeline.py:396  {n} hypotheses could not be evaluated (and none
                    confirmed): {hypId (reason); …}   ← at most 5 listed

 stage="shutdown"
   service.py:229, 252  engine stopped
```

### 19.2 How a failure becomes an observable

```
 pipeline.run raises
   │  pipeline.py:412-414 — `except Exception: cleanup_package(resolved); raise`
   │  the temp workdir is removed before the exception leaves the pipeline
   ▼
 AuditService._execute except-block            service.py:307-323
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
 │ this is a TERMINAL_EVENT, so the SSE stream returns (events.py:10, 86-87)│
 └──────────────────────────────────────────────────────────────────────────┘
 ┌─ the durable row ────────────────────────────────────────────────────────┐
 │ audit_sessions{status:'error', error:<message>, report:NULL}             │
 │ GET /audit/{id}/report → 500 {"error":"Audit failed",                    │
 │                              "message":session.error}   api.py:423-426   │
 └──────────────────────────────────────────────────────────────────────────┘
 ┌─ the synchronous HTTP caller ────────────────────────────────────────────┐
 │ the future's exception surfaces from `await result.future` and           │
 │ _audit_error(exc) renders {"error":"Audit failed", "message", "code",    │
 │ "retryable"} with exc.http_status              api.py:187-196, 277-279   │
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
audit is genuinely re-runnable on the same payment claim.

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
                  (a malformed package.json is swallowed:
                   `package = {}`, inventory.py:238-240)
 dealbreaker      — cannot fail; returns DANGEROUS                 report
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
 save_report      ValueError ("no concrete version …")             9999
 finalize         AssertionError (rowcount != 1)                   9999
```

Note the two shapes of "swallowed" in that table, and that they are different in
kind. `deps` failures are swallowed *and reported in the event stream*, and the
downstream defer-on-module-crash rule catches the consequence. A malformed
`package.json` is swallowed *silently* into `package = {}`
(`inventory.py:237-241`) — see Observations §24.12.

---

<a name="20-events"></a>
## 20. `events` — the SSE wire

`engine/npmguard/events.py`.

### 20.1 Emission

```
 audit_channel(audit_id) = f"audit_{audit_id.replace('-','')}"    events.py:23-26
   ← Kit notifiers need a Postgres-safe identifier, so UUID hyphens are
     stripped; the same durable channel then works for SQLite polling and
     for LISTEN/NOTIFY

 AuditEmitter(audit_id, stream).emit(event_type, payload)         events.py:29-37
   → stream.append(channel, event_type, _json_value(payload or {}))

 _json_value(value)                                              events.py:13-20
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
 _wire_event(audit_id, envelope)                       events.py:40-49
   payload = dict(envelope["data"]) if it is a dict else {}
   return {"type": envelope["type"], "auditId": audit_id,
           "timestamp": envelope["ts"], "seq": envelope["seq"], **payload}
   ⚠ `**payload` comes LAST, so a payload key named type/auditId/timestamp/seq
     would SHADOW the envelope value. No current payload uses those names.
     (§24.13)

 _format_event(audit_id, envelope)                     events.py:52-55
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
(`service.py:296-301`).

### 20.3 Reading

```
 sse_events(audit_id, stream, *, after=-1, follow, heartbeat=15)  events.py:58-87
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
 route: api.py:365-387
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
| 2 | `audit_started` | `pipeline.py:161-162` | `packageName` |
| 3 | `phase_started` | `pipeline.py:63`, `:363` | `phase` |
| 4 | `phase_completed` | `pipeline.py:72`, `:378-380` | `phase`, `durationMs` |
| 5 | `dependencies_provisioned` | `pipeline.py:192-201` | `installed`, `packageCount`, `skipped`, `error` |
| 6 | `file_list` | `pipeline.py:227` | `files: FileRecord[]` |
| 7 | `inventory_meta` | `pipeline.py:228-236` | `scripts`, `dependencies` (4 keyed groups), `entryPoints`, `metadata` |
| 8 | `intent_extracted` | `pipeline.py:278-284` | `statedPurpose`, `expectedCapabilities` |
| 9 | `file_analyzing` | `phases.py:447` (flag), `phases.py:737` (hypothesize) | `file` |
| 10 | `triage_progress` | `phases.py:515-518` | `current`, `total`, `file` |
| 11 | `hypothesis_emitted` | `phases.py:749-757` | `hypId`, `claim`, `severity`, `file` |
| 12 | `file_verdict` | `pipeline.py:108` | `verdict: FileVerdict` |
| 13 | `triage_complete` | `pipeline.py:340-355` | `hypothesisCount`, `hypotheses: {hypId,claim,severity,description}[]` |
| 14 | `graph_built` | `pipeline.py:358-362` | `nodeCount`, `addedCount`, `mergedCount` |
| 15 | `hypothesis_resolved` | `orchestrator.py:137-149` | `hypId`, `claim`, `severity`, `state`, `by`, `reason` |
| 16 | `verdict_reached` | `service.py:292-302` | `verdict`, `rationale`, `counts`, `confirmedCount` |
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
║  READ   GET /audit/{audit_id}/report              api.py:414-426            ║
║           status queued|running → 202 {"status": …}                          ║
║           report is not None    → 200 the report                            ║
║           else                  → 500 {"error":"Audit failed","message":…}   ║
║  LIFECYCLE tied to the attempt. NULL while running; NULL forever on failure. ║
║  ANSWERS "what did THIS run produce?"                                        ║
╚══════════════════════════════════════════════════════════════════════════════╝

╔═ STORE 2: data/reports/<pkg>/<version>.json ═════════════════════════════════╗
║  WHERE  a file on disk                            report_store.py:9          ║
║           DATA_DIR = (NPMGUARD_DATA_DIR or REPO_ROOT/data)/reports           ║
║  KEY    (package_name, CONCRETE version)  — NOT audit_id                    ║
║  WRITTEN by save_report, BEFORE the row leaves 'running'                     ║
║           service.py:289-291, report_store.py:45-61                          ║
║  READ   GET /packages          → list_reports()   api.py:592-597            ║
║         GET /package/{name}/report[?version=] → load_report()  api.py:600-614║
║         panel/jobs.py:343 (cache hit for a repo scan)                        ║
║         panel/verdict_index rebuild at boot     api.py:122-141, :769         ║
║  LIFECYCLE persists across audits. A NEW audit of the same (name, version)   ║
║           OVERWRITES it — there is no history.                               ║
║  ANSWERS "what do we know about THIS PACKAGE VERSION?"                       ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

### 21.1 Why the second key is hard, and how `save_report` gets it right

The caller does not know the concrete version. `/audit` accepts an optional
`version`; the pipeline passes `session.requested_version or "latest"`
(`service.py:290`). But `"latest"` is a *moving pointer*, and a file called
`latest.json` would silently rot the instant npm publishes a new release.
`engine/CLAUDE.md:7-8` makes it a house rule: "Reports remain at
`data/reports/<pkg>/<real-version>.json`. The real tarball version is
authoritative; never persist a `latest.json` alias."

```
 save_report(package_name, requested_version, report) -> str
                                                      report_store.py:45-61
 ┌───────────────────────────────────────────────────────────────────────┐
 │ real_version = extract_report_version(value) or requested_version     │
 │                                                                       │
 │ extract_report_version (report_store.py:35-42):                       │
 │   for phase in report["trace"]:                                       │
 │       if phase["phase"] != "inventory": continue                      │
 │       return phase["output"]["metadata"]["version"] if a non-empty str │
 │   ⇒ THE VERSION IS RECOVERED FROM THE TRACE. This is why the inventory │
 │     phase's output_summary embeds the whole metadata object            │
 │     (pipeline.py:219) — it is not decoration, it is the key source.    │
 │                                                                       │
 │ if not real_version or real_version == "latest":                      │
 │     raise ValueError(f"Cannot save report for {name}: no concrete      │
 │       version in report or request — a latest.json alias must never    │
 │       be persisted")                                                  │
 │                                                                       │
 │ ATOMIC WRITE: write <version>.json.tmp, then os.replace → <version>.json│
 │   ⇒ a reader never sees a torn file                                   │
 │                                                                       │
 │ if requested_version not in (real_version, "latest"):                 │
 │     unlink <requested_version>.json, missing_ok=True                  │
 │   ⇒ clean up a stale file written under a different requested key      │
 │                                                                       │
 │ every path goes through _under_data_dir (report_store.py:12-16), which │
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
 load_report(package_name, version=None)              report_store.py:64-91
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

`list_reports` (`report_store.py:102-126`) walks `DATA_DIR.rglob("*.json")`,
derives `packageName` from the parent directory relative to `DATA_DIR` (so scoped
packages like `@scope/name` work), skips non-public names via `_public`
(`:94-99` — anything starting `test-pkg-`, `test-package`, or containing
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
 │ "has this dependency been scanned?" │ Store 2 (panel/jobs.py:343 cache)  │
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
| Frontend resume | SSE | `id:` → `Last-Event-ID` header → `after` cursor | `events.py:55`, `api.py:371-375` |
| Frontend verdict banner | report | `verdict`, `rationale`, `counts` | `shared/src/backend.ts:21-31` |
| Frontend hypothesis list | report | `hypotheses[]` → `state`, `severity`, `description`, `resolution.reason` | `shared/src/graph.ts:83-104` |
| Frontend code viewer | report + HTTP | `fileSummaries[]`; source via `GET /audit/{id}/file/{path}` | `pipeline.py:180`, `api.py:390-411` |
| Frontend file badges | SSE | `file_verdict.verdict` → `capabilities`, `suspiciousLines`, `riskContribution` | `pipeline.py:100-107` |
| Frontend phase progress | SSE | `phase_started`/`phase_completed.phase`, `durationMs` | `pipeline.py:63, 72` |
| CLI | SSE + report | same wire, same terminal semantics | — |
| Repo panel scan cache | Store 2 | `load_report(name, version)` → verdict | `panel/jobs.py:343` |
| Panel verdict index (boot) | Store 2 | `list_reports()` + full report for rationale and confirmed evidence | `api.py:122-141`, `:769` |
| Public package page | Store 2 | `{report, version, packageName}` | `api.py:600-614` |
| Public package list | Store 2 | `{packageName, version, verdict, auditedAt}`, `_public`-filtered | `api.py:592-597` |
| Sync HTTP caller | future | the full report dict, or the mapped error | `api.py:277-279`, `:187-196` |
| CRE (API-key) caller | HTTP 202 | `{status, auditId, packageName, version, queuePosition}` | `api.py:267-277` |
| `report_store.save_report` | report | `trace[phase=="inventory"].output.metadata.version` | `report_store.py:35-42` |
| Judge (LLM) | timeline + hypothesis | `timeline.text` and `timeline.ids`; `claim.kind`, `gating`, `severity`, `description`, `focusLines`, `experiment` | `orchestrator.py:65-79` |
| `graph.transition` | hypothesis | `evidenceRefs` (must be non-empty for CONFIRMED/REFUTED) | `graph.py:169-172` |
| `derive_graph_verdict` | graph | node `state` only — nothing else | `graph.py:250-286` |

The last row is worth dwelling on. The verdict function reads **only** the state
field of each node. Not the claim, not the severity, not the description, not the
evidence. All the meaning has already been forced into `state` by the time it
runs, and the guards on `transition` are what make that state trustworthy. This
is what makes the verdict logic 26 lines long.

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
  (`shared/src/evidence.ts:157-165`), `DEFAULT_OBSERVE` has three of five flags
  **off** (`observation.py:47-53`), and `run_under_observation` takes an
  `observe` argument.
- Why the code is right: the flags earned a second, genuinely different consumer.
  `dry_run_load` uses `LOAD_CHECK_OBSERVE` — node sensor only, 10 s budget
  (`observation.py:65-72`) — because a load check must be cheap. The full-oracle
  invariant is instead enforced at the *call site*: the orchestrator always
  passes `FULL_ORACLE` (`orchestrator.py:25`, used at `:120`), and every real
  artifact records `observe` so the claim is auditable after the fact
  (`hyp-0008`: all five `true`).

**2. "A hypothesis that can't be evaluated → the audit is an ERROR, not
`DEFERRED`."**

- Spec: `docs/specs/2026-07-10-triage-hypothesis-redesign.md:104`.
- Code: `DEFERRED` is a real, first-class state
  (`shared/src/graph.ts:55-61`, `graph.py:17`) and the orchestrator uses it
  nine ways (§18.4). The *audit* then errors at `pipeline.py:390-399` — but
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
  (`orchestrator.py:72`) and event payloads (`phases.py:753`,
  `pipeline.py:327, 348`, `orchestrator.py:143`).
- Verdict: the dispatch-elimination goal is met; the schema is stricter than the
  spec proposed. `gating` in particular does real work in the prompt, telling the
  judge which evasion the experiment was designed to defeat.

**4. The timeline format is not the one the spec sketched.**

- Spec sketch (`docs/specs/2026-07-08-evidence-timeline-judge.md:80-93`): one
  merged chronological list with a `t+Ns` stamp on every line, including L4.
- Code: **two sections** — `── [L4] node calls — logical order, no clock ──`
  and `── wall-clock t+ — [L1] syscall · [L2] network · [L3] fs-diff
  (mtime-coarse) ──` (`evidence.py:298-306`).
- Why the code is right: L4 timestamps are array indices, not times
  (`evidence.py:142`). Rendering `t+0.00s` next to an L4 event would assert a
  time the sensor never measured. The spec anticipated the problem
  (`docs/specs/2026-07-08-evidence-timeline-judge.md:71-73`, "L4's timestamp is
  a logical index… We do not try to reconcile the clocks") and the code solved
  it by labelling the sections instead of faking a clock. The code also adds
  run-collapsing with `[xN]` (`evidence.py:310-318`), which the spec did not
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

### 24.0 Status — what has since been fixed, and where this section was wrong

These findings were triaged into the phase plan (design doc **D-9**, goals
G28–G32), not filed. Four are fixed; the rest are tracked. **Read this subsection
before trusting any item below** — acting on the fixes corrected the analysis in
three places, and turned up one defect this section missed entirely.

**Fixed** (`instrumentation-monkey.js`, new `instrumentation-require-hook.js`,
`evidence.py`, `sensors.py`, `graph.py`, `docker.py`):

- **§24.7** — the L4 URL now carries the authority the caller actually
  requested, port included, and a port is emitted only when one was supplied
  (inventing `:80` would be the mirror-image mismatch). The method is also read
  off the second argument, so `request(url, {method:'POST'})` no longer logs as
  GET.
- **§24.8** — request bodies are captured, bounded at 2 KiB per request and
  64 KiB per run, with `bodyBytes` recording the *true* size so truncation is
  visible rather than silent. The renderer names which planted `setupApplied.env`
  canaries the body or URL carries, with an 8-character floor so `CI=1` can't be
  cited as proof. **Planted *file* contents remain uncorrelatable** — see §24.8's
  own note and the tracked follow-up.
- **§24.10** — the require hook moved into its own fragment, concatenated *after*
  the instrument's own requires. Order is the mechanism, not a filter, per the
  spec. `parse_l4_trace` now **raises** if any require's `from` is the
  instrument, so a misattributed capability DEFERs with a located cause instead
  of reaching a verdict.
- **§24.17** — a merge now requires description similarity **and** a
  byte-identical `experiment` **and** an identical `claim`. Once two nodes ask
  the same question, one run resolves both, so unioning `focusLines` is honest
  rather than a coverage claim for something never executed — the invariant holds
  by construction, with no new state. The survivor also takes the **max**
  severity; keep-first let a `low` duplicate demote a `critical` out of its
  dispatch slot.

**Two further defects of the same class, found while fixing the above:**

- **The L1 peer address was never parsed.** `re.search(r'sin_addr="([^"]+)"')`
  matches nothing strace emits — the real form is
  `sin_addr=inet_addr("127.0.0.1")`. Every inet `connect` in the committed corpus
  carries the peer in its `raw` while `addr` is `null`, so the renderer printed a
  bare `connect socket`. It now renders `connect 127.0.0.1:9999`, which answers
  the same three refutations as §24.7 **from an independent sensor**.
- **`http.get` / `https.get` were invisible at L4**, because Node's `get` calls
  the module-internal `request()` rather than the exported one. `hyp-0008`'s
  artifact contains exactly one L4 network event; the IMDS probe reached the
  timeline only via pcap.

**Where this section is wrong:**

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

**The defect this section missed, and it is larger than most of what it found:**

> **`stubUrl` never intercepted the running example at all.** It works by setting
> `HTTP_PROXY`/`HTTPS_PROXY`, and Node core's `http`/`https` ignore proxy
> environment variables. The recorded L1 proves it: `connect(19, 127.0.0.1:9999)
> = -1` — the package dialled its real endpoint and never touched the proxy on
> `127.0.0.1:18080`. So `setupApplied.stubUrls[].responseHash` attests a canned
> response that was never served, and the experiment's central manipulation
> silently did not apply. This is the same defect class as §24.14 (a sealed
> artifact asserting a bound the run never applied) but worse, because a
> hypothesis's logic may *depend* on the stub. Tracked, not fixed.

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

Finally, a note on why all of this survived a green suite: **the C2 test in
`test_sensors.py` asserted a line shape strace never emits**
(`sin_addr="1.2.3.4"`). A whitebox test written against an imagined format is
how a dead regex stays green for its whole life. The replacement class uses lines
copied verbatim from a committed artifact's `raw`.

### 24.1 The committed demo recording is a hybrid of real and curated data

`engine/demo-data/test-pkg-env-exfil.json` mixes faithfully-recorded engine
output with hand-authored presentation values. `DemoService` replays the recorded
`events` array **verbatim** (`demo.py:94`) and finalises the row with the recorded
`report` (`demo.py:111`), so nothing is regenerated and these values are what a
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
| `dependencies_provisioned` | `{installed: true, packageCount: 0, skipped: null}` | `{installed: false, packageCount: 0, skipped: "no runtime dependencies"}` — the package has no `dependencies` key, so `deps.py:61-63` returns exactly that |
| `file_list[].fileType` | `"javascript"` | `"js"` — `EXTENSION_TYPE_MAP[".js"] == "js"` (`inventory.py:19`) and `SOURCE_FILE_TYPES == {"js","ts"}` (`config.py:128`) |
| `report.trace[].input` / `.output` | `{}` on all six phases | populated summaries |
| `report.trace[].durationMs` | round numbers (1400.0, 320.0, 2100.0, 5200.0, 8600.0, 41800.0) | measured values |
| `file_verdict[index.js].riskContribution` | `3` | `8` — see §24.2 |

Two of these have real consequences. A frontend built against the demo's
`fileType: "javascript"` would not match live traffic, where the value is `"js"`.
And the empty `trace[].output` means `report_store.extract_report_version` would
return `None` for this report — but the demo path never calls `save_report`
(`DemoService` finalises the row directly), so nothing breaks today. A future
change that ran a demo report through `save_report` would raise
`ValueError("Cannot save report for test-pkg-env-exfil: no concrete version…")`.

### 24.2 The demo's `riskContribution` for `index.js` contradicts the code

`engine/demo-data/test-pkg-env-exfil.json`, `file_verdict` for `index.js`:
`riskContribution: 3`.

`3` is `SEVERITY_SCORE["low"]` (`pipeline.py:41`). But `_emit_file_verdicts`
computes `max((n.severity or "medium" for n in nodes),
key=SEVERITY_SCORE.__getitem__, default="low")` over that file's hypotheses
(`pipeline.py:87-93`), and `index.js`'s six hypotheses in the same recording are
`hyp-0009 low`, `hyp-0010 high`, `hyp-0011 high`, `hyp-0012 high`,
`hyp-0013 high`, `hyp-0014 low`. The max is `high` → `8`. The frame also carries
six `suspiciousPatterns`, so `nodes` was non-empty and the `if nodes else 0`
branch does not apply. (`setup.js`'s value of `10` is consistent: six `critical`
plus two `high`.) A curated value, per §24.1 — but a UI calibrated on it will
under-report risk for multi-severity files.

### 24.3 A `save_report` `ValueError` becomes a non-retryable `NPMGUARD-9999`

`report_store.py:49-53` raises a bare `ValueError` when no concrete version can
be determined. It is called from `AuditService._execute`
(`service.py:289-291`), outside any `NpmGuardError` mapping, so
`service.py:307-310` classifies it as `NPMGUARD-9999` with `retryable=False` and
HTTP 500. The audit *completed* — a verdict was computed, the graph resolved,
the evidence sealed — and is then discarded as a non-retryable server error. In
practice unreachable, since the inventory `PhaseLog` always carries
`metadata.version` for any package with a version in its manifest; but a package
published without a `version` field would take this path.

### 24.4 `timeout_scale` is computed over a different file set than FLAG analyses

`pipeline.py:238-242` builds `sources` filtering only on `fileType` and
`isBinary`. `run_flag` additionally applies `noise()` — dropping `.d.ts`,
`test/`, `tests/`, `__tests__/`, `__mocks__/`, and `*.test.*`/`*.spec.*`
(`phases.py:400-411`). A package that is 90% test files therefore receives a
`flag`/`hypothesize`/`orchestrator` budget scaled for files that will never be
read. The error direction is safe (too much budget, not too little), but the two
lists are meant to represent the same thing and do not.

### 24.5 `FileFlagResponse.capabilities` is not deduplicated

`normalize_bounded_response` (`phases.py:171-187`) filters to `CAPABILITY_VALUES`
and truncates to 12, but never dedupes. The real recorded response for `setup.js`
(`exchanges/003_flag_24133fb1.json`) contains
`["DATA_EXFILTRATION","ENV_VARS","FILESYSTEM","NETWORK","OBFUSCATION",
"PROCESS_SPAWN","FILESYSTEM","NETWORK"]` — `FILESYSTEM` and `NETWORK` twice. The
duplicates flow through `FileSummary.capabilities` (`phases.py:526`) onto
`AuditReport.fileSummaries` and into the `file_verdict` frame
(`pipeline.py:103`). A UI rendering capability chips would show two identical
chips. Also note the truncation to 12 happens *before* dedup, so duplicates can
crowd out real values.

### 24.6 `file_analyzing` means two different things

`file_analyzing` is emitted once per file during FLAG (`phases.py:447`) and once
per **flag** during HYPOTHESIZE (`phases.py:737`). The running example emits 16:
2 for two files, then 14 for fourteen flags — eight of which name `setup.js`
consecutively. A consumer treating the frame as "starting a new file" will show
`setup.js` opening eight times in a row. `triage_progress` (which carries
`current`/`total`) is only emitted during FLAG (`phases.py:515-518`); the
hypothesise fan-out has no progress frame, only `hypothesis_emitted` per
completion.

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

### 24.8 No sensor captures request or response bodies

L4 records `{method, url}` (`evidence.py:159-163`); L2 records
`{host, method, path}` from tshark's HTTP dissector (`sensors.py:363-373`); L1
records `write`/`sendto` with only an fd (`sensors.py:128-139`). So "was the
canary token actually in the exfiltrated payload?" is not answerable from any
timeline. `hyp-0004` refuted for exactly that reason: "the timeline does not
provide any evidence that the contents of those files were transmitted to the
exfiltration endpoint; the POST request is recorded but its payload is not
specified." Also note that `setupApplied` records planted **file** contents only
as hashes (`shared/src/evidence.ts:119-124`), so even a body capture would need
the plaintext canary from `setupApplied.env` to correlate. The stub proxy does
receive the full body (`assets/stub-proxy.js:47-60`) but only logs
`method + url` to stderr and discards it.

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

### 24.10 Instrumentation `require` noise is attributed to the package

`assets/instrumentation-monkey.js:6-10` installs the `Module._resolveFilename`
hook **before** requiring its own dependencies, so `fs`, `http`, `https`,
`child_process`, `crypto`, `inspector`, and `module` appear as `require` events at
the head of every timeline (`e1`–`e7` in `hyp-0008`), as though the package
required them. This is a known follow-up recorded in the spec
(`docs/specs/2026-07-08-evidence-timeline-judge.md:199-204`), which specifies the
fix belongs in the instrument (install the hook last, or drop events whose `from`
is the instrument), not as a filter in the renderer. Consequence: a judge cannot
distinguish "the package requires `child_process`" from "the instrument does" from
the timeline alone. In practice benign — no matching `process`/`fs` event follows,
so nothing confirms on it — but it is misleading, and `child_process` in
particular is a capability a judge might weight.

### 24.11 Three declared error codes have no raise sites

`grep` over `engine/npmguard/` finds no raise for `ValidationError`
(`NPMGUARD-0002`, `errors.py:30-32`), `LLMUnavailableError` (`NPMGUARD-0010`,
`errors.py:35-38`), or `SessionLimitError` (`NPMGUARD-0050`,
`errors.py:77-84`). `NPMGUARD-0050` is explicitly retired — the tests say so:
"the running-count session cap (`NPMGUARD-0050`) is retired in favor of the
wait-queue bound" (`tests/e2e/test_bounds_inputs.py:4`,
`tests/test_service_queue.py:53`). Request validation is handled by Pydantic and
`kit_spine`'s `RequestValidationError` handler instead
(`api.py:20, 177`). A consumer building an exhaustive code-handling table will
carry three dead branches.

### 24.12 A malformed `package.json` is silently treated as empty

`inventory.py:237-241`:

```python
try:
    package = json.loads((package_path / "package.json").read_text("utf-8"))
except (OSError, json.JSONDecodeError):
    package = {}
```

The audit continues with no name, no version, no scripts, no entry points, and no
dependencies. Downstream: `entryPoints.runtime` becomes `["index.js"]` (the
`main` default at `inventory.py:112`); both dealbreaker checks pass trivially
(`scripts` is empty, `install` is empty); and `extract_report_version` returns
`None`, so `save_report` falls back to `requested_version` and raises
`ValueError` if that was `"latest"` (§24.3). Contrast this with the treatment of
an *unreadable source file*, which is an explicit `AuditIncompleteError`
(`phases.py:427-430`), and with the treatment of an *ambiguous tarball root*,
which is a checked `ValueError` (`resolve.py:92-96`). An unparseable manifest is
a strictly larger coverage gap than an unreadable source file, and it is the only
one of the three that is swallowed.

### 24.13 `_wire_event` lets a payload key shadow the envelope

`events.py:40-49` spreads `**payload` **after** `type`, `auditId`, `timestamp`,
and `seq`, so a payload containing any of those four names would override the
envelope's value — including `type`, which is the SSE union discriminator. No
current emit site uses those names (verified against all 17 event types), so this
is latent rather than live.

### 24.14 `Budget.maxSyscalls` and `maxBytesCapture` are recorded but never enforced

`DEFAULT_BUDGET = {"wallMs": 60_000, "maxSyscalls": None, "maxBytesCapture":
1_000_000}` (`observation.py:54`), and both fields are sealed into every artifact
(`hyp-0008`: `maxSyscalls: null`, `maxBytesCapture: 1000000`). `grep` finds no
reader of either value anywhere in `engine/npmguard/`. The caps that actually
exist are unrelated to them: `docker_exec` truncates stdout and stderr at 10 MiB
each (`docker.py:37`), and `deps._stream_tar` caps the dependency archive at 256
MiB (`deps.py:20`). So an artifact asserts a capture bound the run never applied.

### 24.15 `inspectorLogHash` is always `null`

`observation.py:335` passes `"inspectorLogHash": None` unconditionally, even
though `observe.inspector` is `true` on every full-oracle run and inspector
events *are* collected (three `script_parsed` events in `hyp-0008`). The other
five sensor hashes are computed from their raw sources
(`stdoutHash`, `stderrHash`, `fsDiffHash`, `pcapHash`, `straceLogHash`). The
inspector's raw output has no separate artefact — it is merged into the same
stdout blob as the monkey log by `instrumentation-flush.js`, which `stdoutHash`
already covers — so the field is structurally unfillable in its current form
rather than merely forgotten.

### 24.16 The workdir can leak between `resolve` and the pipeline's `try`

`pipeline.py:163-181` runs the resolve phase, appends to `trace`, calls
`log.write("resolve.json", …)`, and calls
`sessions.set_package_path(audit_id, …)` — all **before** the `try:` at
`pipeline.py:181` whose `except Exception: cleanup_package(resolved); raise`
provides cleanup. `resolve_package` cleans up its own workdir on internal failure
(`resolve.py:134-136`), and `AuditService._execute` cleans up on success
(`service.py:303-305`), but an exception from `log.write` (a disk error) or from
`set_package_path` (a database error) leaves the extracted package in
`/tmp/npmguard-*` with no owner. Bounded and rare, but the tmpdir survives until
the host reaps `/tmp`.

### 24.17 `add_or_merge` discards the incoming node's experiment

`graph.py:117-143` merges only `focusFiles` and `focusLines` into the kept node;
the incoming hypothesis's `experiment`, `claim`, `severity`, and `hypId` are
dropped. So when two hypotheses have descriptions within Jaro-Winkler 0.88, the
*second* experiment is never run, even though it may plant different bait or
defeat a different gate. The kept node's `focusLines` grow to cover the merged
region, which makes the report read as though both regions were tested by the
surviving experiment. `graph_built.mergedCount` is the only signal that this
happened (0 for the running example, so it is not exercised there). Jaro-Winkler
also weights shared *prefixes* heavily, so hypotheses that open with the same
clause merge much more readily than ones that merely end alike.

### 24.18 `triage_max_files` is configured but unused

`config.py:51` declares `triage_max_files: int = Field(default=80, ge=1,
le=1000)`. `grep` finds no reader. `run_flag` analyses every non-noise source
file with no cap (`phases.py:407-411`), bounded only by the concurrency semaphore
and the scaled phase timeout. A package with 500 source files gets 500 model
calls in the FLAG phase. (`triage_model` and `investigation_model` **are** used,
at `llm_runtime.py:153-154`; `max_agent_turns` is likewise unread — the agentic
turn budget is computed locally at `hypothesis_agent.py:360-361`.)

### 24.19 `Trigger.kind` has two unrunnable values

`compile_experiment` accepts `kind ∈ {entrypoint, lifecycle, bin, subpath}`
(`experiments.py:322`) matching the contract (`shared/src/evidence.ts:82`), but
`build_trigger_command` returns `None` for `lifecycle` and `bin`
(`observation.py:118`), which becomes
`SetupError("trigger.kind='lifecycle' has no run command")` and therefore a
DEFER — that is, a *coverage gap that blocks `SAFE`*. Both generators always emit
`kind: "entrypoint"` (`phases.py:665`, `hypothesis_agent.py:326-327`), so this is
unreachable today; a future generator or a replayed/hand-written experiment could
reach it. `LifecycleHook` (`shared/src/evidence.ts:86`) is likewise a declared
enum with no producer.

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
