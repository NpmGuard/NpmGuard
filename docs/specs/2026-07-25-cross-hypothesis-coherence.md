# Spec — Cross-hypothesis coherence, or: what a refutation is allowed to mean

_Status: design pass, no code · 2026-07-25 · engine v3 · paper deliverable_

**What this is.** A design pass on the deepest open problem the audit-core
explainer surfaced: `derive_graph_verdict` is a bare OR over confirmations
(`graph.py:295-331`), so thirteen refutations that all looked at the same
observed behaviour are indistinguishable from thirteen independent exonerations.
The question posed was *"when N judges independently refute while all citing the
same observed events, is that N refutations or one?"*

**The answer this pass arrives at is that the question is aimed one notch off
target.** Cross-hypothesis overlap is not computable in the form proposed, and
where it *is* computable it is not actionable without becoming the malice
predicate the engine forbids. The real defect is one notch upstream and much
cheaper to fix: `JudgeVerdict.malicious` is a `bool`
(`phases.py:204-209`), so a judge that means *"the timeline does not contain the
fact I needed"* has no way to say so, and the orchestrator launders that answer
into `REFUTED` — which contributes to `SAFE`
(`orchestrator.py:247-256`). Two of the seven refutations on the payload file of
the running example say exactly that, in plain English, in their recorded
`resolution.reason`.

Everything below is measured against the four committed replay bundles under
`engine/tests/fixtures/llm/`. No model calls were made. Every number is
reproducible from the sealed artifacts and the recorded exchanges.

**One standing caveat, stated once.** The recorded corpus predates the §24.0
fidelity fixes. Where a number describes the recorded engine and not today's
source, it says so. The *structural* finding — that the judge's output vocabulary
has no third value — is independent of every one of those fixes and is verifiable
in today's tree at `phases.py:204-209` and `orchestrator.py:81-89`.

---

## 1. The observation, with real numbers

### 1.1 What the explainer reported

`docs/architecture/AUDIT_CORE_EXPLAINED.md` §24.9, on `test-pkg-env-exfil@2.0.1`:

> Of eight hypotheses on `setup.js`, seven were refuted and one confirmed. The
> seven refutations were largely artefacts (§24.7, §24.8), not genuine absence of
> malice… Nothing in the code notices that thirteen refutations cited the same
> observed behaviour.

The verdict was `DANGEROUS`, and correct. The concern is that it was carried by
one hypothesis whose description happened to name a request the pcap sensor
rendered with a literal host.

### 1.2 What the corpus actually shows

Measured over all 14 hypotheses, their 14 sealed run artifacts, and the 16
recorded judge exchanges (keeping the last accepted verdict per hypothesis,
because three hypotheses took retries):

| Fact | Value |
|---|---|
| Hypotheses | 14 (8 on `setup.js`, 6 on `index.js`) |
| Runs that triggered `setup.js` | **9** — `hyp-0009` focuses `index.js` but triggers `setup.js` |
| Verdict | `DANGEROUS`, `confirmed=1`, `refuted=13`, `deferred=0` |
| Judge calls | 16 for 14 hypotheses — 2 retries (one recorded `provider_error`, one re-ask) |
| Judge prompt spend | 49,313 prompt + 1,965 completion tokens; mean 3,082 prompt tokens/call |

**Correction 1 — the id space is not comparable across hypotheses, so "the same
cited event" is not a thing that can exist.** Every hypothesis gets its own
container run, its own artifact, and its own `render_timeline` pass, which numbers
ids `e1..eN` with a counter local to that artifact (`evidence.py:311-318`). The
exfiltration POST is:

```
hyp-0001 e61   hyp-0002 e61   hyp-0003 e59   hyp-0004 e62   hyp-0005 e61
hyp-0006 e63   hyp-0007 e62   hyp-0008 e60   hyp-0009 e52
```

Nine ids for one act. Cited-event overlap on ids is not noisy — it is identically
zero by construction. It is a type error, not a measurement.

**Correction 2 — no refutation cites anything, because the schema forbids it.**
`validate_verdict` rejects a non-malicious verdict that carries citations
(`orchestrator.py:89`: `"malicious=false must not cite events"`). So
`citedEvents` is empty on all 13 refutations *by contract*. §24.9's word "cited"
can only mean "mentioned in the `reason` prose" — which is precisely why nothing
can notice it. The sentence names the mechanism and the mechanism's opposite in
the same breath.

**Correction 3 — the number is 8, not 13.** Resolving prose-mentioned ids against
each hypothesis's own timeline and normalising to a rendered behaviour key
(`verb + target`), the multiplicity is:

| Behaviour key | Hypotheses whose accepted reason references it | R | C |
|---|---|---|---|
| `net POST http://localhost/exfil` | **9** | 8 | 1 |
| `fs ~/.npmrc` | 3 | 2 | 1 |
| `fs ~/.kube/config` | 3 | 2 | 1 |
| `http GET 169.254.169.254/latest/meta-data/` | 2 | 1 | 1 |

Eight of the thirteen refutations reference the POST. The other five
(`hyp-0010`…`hyp-0014`) ran against `index.js` on timelines of 59–73 rows
containing **zero** egress and **zero** credential reads. Those are honest
refutations of honestly-absent behaviour, and folding them into the indictment
overstates it.

**Correction 4 — and this is the one that changes the design.** Of the seven
refutations on `setup.js`, **six were decided against facts the sealed artifact
contained and the renderer did not show, and the seventh was decided against a
fact no sensor captured. Zero of seven were genuine absence of malice.**

The dropped facts, from the artifacts:

```
sandbox/hyp-0001.runartifact.json — present in ALL NINE setup.js runs:
  connect(18, {sa_family=AF_INET, sin_port=htons(80),
               sin_addr=inet_addr("169.254.169.254")}, 16) = -1   ← EINPROGRESS
  write(18, "GET /latest/meta-data/ HTTP/1.1\r\n
             Host: 169.254.169.254\r\n…", 82) = 82                ← 82 bytes SENT
  connect(19, {sa_family=AF_INET, sin_port=htons(9999),
               sin_addr=inet_addr("127.0.0.1")}, 16) = -1

sandbox/hyp-0001.timeline.txt:126-129 — what the judge was shown:
  e120  t+0.42s  [L1]  connect  socket
  e122  t+0.43s  [L1]  write    socket
  e123  t+0.43s  [L1]  read     socket
```

The judge for `hyp-0005` wrote *"there is no evidence of a request to the IMDS
(169.254.169.254/latest/meta-data/) — the stub was provided but never observed
being accessed"* while looking at those three lines. The endpoint was in the
artifact. The renderer printed `socket` because `sensors.py`'s peer regex matched
a line shape strace never emits (§24.0's own newly-found defect; **since fixed**
at `sensors.py:139-146`).

Only **3 of the 9** `setup.js` runs produced any L2 `http_request` event at all,
and `hyp-0008` was one of the three. So the verdict required a conjunction: a
hypothesis phrased around the IMDS probe **and** paired with one of the three
runs whose pcap dissected it. Both had to land.

**Correction 5 — the redundancy story is mostly a rendering story.** §24.9 credits
the 8-flags-per-file fan-out with saving the audit. The stronger reading of the
same data: the decisive fact was present in **9 of 9** runs at L1 and visible in
**3 of 9** renders. After the `sensors.py` fix, `connect 169.254.169.254:80` and
`write 169.254.169.254:80` render in all nine. The lottery §24.9 describes was
substantially a *rendering* lottery, and the *framing* lottery that remains is
smaller than the section implies. That matters, because a design that treats the
framing lottery as intrinsic will over-build.

### 1.3 The seventh refutation, and the actual defect

One refutation was not a rendering artefact. `hyp-0004`, verbatim:

> The timeline shows that setup.js did read the planted files (e.g., e53–e61) and
> made a single POST request to http://localhost/exfil (e62). However, **the
> timeline does not provide any evidence that the contents of those files were
> transmitted** to the exfiltration endpoint; the POST request is recorded but
> **its payload is not specified**. … Without evidence of the data being sent,
> the claim of exfiltration cannot be confirmed. Therefore, the suspected
> behavior did not happen.

Read the last sentence against the two before it. The judge states an
*epistemic* limitation — the oracle did not capture the fact the claim turns on —
and then, because the schema offers `malicious: bool` and nothing else, converts
it into an *ontological* one: "the suspected behavior did not happen." Those are
different claims. The engine has a state for the first (`DEFERRED`, and
§18.1 guarantees it cannot yield `SAFE`) and the judge has no way to select it.

`hyp-0005` does the same: *"the timeline does not record the exact URL or body."*

That is the defect. It is a **coverage** fact, not a malice judgement — exactly
the category the brief says is on the table.

### 1.4 A second, independent finding: setup-as-exoneration

Two refutations used the *declared experiment setup* as grounds to acquit:

- `hyp-0002`: *"The only network activity was a POST to `http://localhost/exfil`
  (e61), **which matches the experiment's stubbed endpoint designed for test
  purposes**."*
- `hyp-0003`: *"the POST goes to localhost, **which was stubbed by the experiment
  setup** (stubUrl for http://localhost:9999/exfil)."*

The judge prompt's one-line guard — *"Setup is test context, not proof. Use it to
associate planted canary values with observed events; decide only from the
timeline"* (`orchestrator.py:77`) — is **one-directional**. It was written to stop
a judge confirming its own experiment design, and it says nothing about using the
setup to dismiss an observed act. Compounding it: per §24.0 the `stubUrl`
manipulation never applied at all (`HTTP_PROXY` is ignored by Node core), so both
judges acquitted on the basis of a manipulation that did not happen. Not the
subject of this spec, but it belongs in §24 and is a one-line prompt fix.

---

## 2. The invariant currently missing

Stated precisely, in the vocabulary of N-4:

> **A hypothesis resolves to `REFUTED` only if its judge affirmed that the
> timeline carried the facts the claim turns on. "I could not tell" is
> `DEFERRED`, not `REFUTED`.**

Today the reachable-state set at `orchestrator.py:247-256` includes a state the
code cannot act on correctly: *the run completed, the machinery worked, the judge
answered — and the answer means "unknown".* There is no branch for it because
there is no way to represent it, so it silently takes the `REFUTED` arm. That is
N-4's *haziness* in its purest form: a field whose declared type (`bool`) promises
a distinction the caller needs and the producer cannot supply. It is the same
defect class as `UNKNOWN` meaning both "not audited yet" and "audited, can't
tell" (§4.4 of the platform design) — two incompatible facts wearing one name.

The consequence chain, all existing mechanism:

```
judge means "undecidable"
   │  no representation ⇒ malicious=false
   ▼
REFUTED  (orchestrator.py:247-256, evidence_refs attached, Guard 2 satisfied)
   │
   ▼
counts.refuted += 1 ; counts.deferred unchanged
   │
   ▼
derive_graph_verdict: confirmed==0, deferred==0 → SAFE
   │  rationale: "All 14 suspicions ran and showed no malice."   ← FALSE
   ▼
AuditReport{verdict:"SAFE"}
```

The rationale string is the tell. `graph.py:329` asserts something the graph
cannot know.

And note what is *already right*: the pipeline gate at `pipeline.py:416-424` and
the assertion at `graph.py:322-325` mean that the moment such a resolution is
correctly labelled `DEFERRED`, the audit stops producing a verdict and raises
`AuditIncompleteError` with a located cause. **The enforcement machinery for the
honest outcome exists and is untouched by this design.** The only thing missing is
the ability of a judge to select it.

The brief asked whether the honest move for "we observed something no experiment
framed" is a DEFER with a located cause. Tested: **yes**, and more cheaply than
expected — because the located-cause DEFER is not a new mechanism, it is the
mechanism §18.1 already describes, reached by a different door.

---

## 3. The four directions, assessed

### 3.1 Cited-event overlap — build the instrument, never the rule

**What it detects, as specified: nothing.** Per §1.2 correction 1, event ids are
per-render. Overlap on ids is identically zero across hypotheses.

**What it detects, rescued with a content key:** real signal. Normalising to
`verb + target` yields the table in §1.2 — the exfil POST referenced by 9 of 14
accepted verdicts, and (on `test-pkg-dns-exfil@0.2.1`) `net POST
http://localhost/exfil` by 8 of 14 and `dns api.github.com` / `tls api.github.com`
by 5 each. So the measurement is available, and it is available **today, without
any model change**, by regexing `resolution.reason` for `e\d+` and resolving
against the persisted `timeline-{hypId}.md`.

**What it costs.** If you want it *structured* rather than scraped, the judge must
emit event ids on refutation, which `orchestrator.py:89` currently forbids. Two
options, and only one is safe:

- *Relax the guard* so `citedEvents` may accompany `malicious=false`. **Reject.**
  `citedEvents` is load-bearing as proof-of-malice — it is the `∃` in
  `confirmed = malicious AND bool(cited)` (`orchestrator.py:105`) and the whole
  content of the "cited dynamic proof" property. Overloading it with "events I
  considered" makes the field mean two things, which is the defect this document
  is about.
- *Add a separate field* (`addressedEvents`). Survivable. Per
  `[[llm-structured-output-not-hard-constrained]]` a new field is a new repair
  surface, and the measured evidence is reassuring. Across all four bundles: 36
  judge exchanges, 34 with parseable content (2 recorded `provider_error` with
  empty `choices`), and of those 34 —

  - **0 phantom event ids.** Every well-formed `e\d+` reference, in
    `citedEvents` *and* in `reason` prose, resolved to a real row of that run's
    own timeline. The model does not invent ids.
  - **2 schema violations, both caught by the existing validator and both
    repaired on the retry:** one `malicious=true` with `citedEvents=[]`
    (`dns-exfil` exchange 089 → repaired at 090), and one that emitted id
    *ranges* — `"e19-e41"`, `"e62-e84"`, `"e201-e277"` — instead of members
    (093 → repaired at 094, which returned 106 enumerated ids).

  The range case is the instructive one: the failure mode of a list-of-ids field
  is *interval notation*, and it was caught only because `validate_verdict`
  rejects unknown ids. A new event-list field inherits that protection for free;
  a new *enum* field would not, which is why R1's third value is validated
  against a closed set.

**What it can get wrong, and why it must not become a rule.** Nine judges pointing
at one POST is *equally consistent with* (a) nine artefactual refutations and (b)
one observed act that nine differently-phrased claims correctly failed to match.
Overlap cannot distinguish them. Any threshold on it — "≥K refutations share a
behaviour ⇒ not SAFE" — is exactly the "lots of refutations smells bad" predicate
the constraint forbids, wearing a coverage costume. On this corpus such a rule
would fire on both malware bundles and on neither benign one, which looks like
success and is coincidence: both benign fixtures make zero network calls, so the
rule had no opportunity to be wrong.

**Verdict: build it as an instrument for the bench and the report. Do not branch
on it.** It measures how independent the tests were, which is a fact about the
engine, not about the package.

### 3.2 A coherence pass over resolutions — reject

**What it would detect:** "many refutations, one cited behaviour" as its own
state, computed after the orchestrator loop.

**Why it is rejected, three reasons, in increasing order of force:**

1. **It has nothing to compute that a per-run accounting does not already give,
   and it must compute it over a strictly weaker identity relation.** Within one
   run, "the judge addressed this event" is decidable on real ids. Across runs it
   is decidable only on normalised content keys — a lossy join. Choosing the
   weaker relation to answer a question the stronger one already answers is
   backwards.
2. **The state it produces is not actionable under the founding rule.** It cannot
   produce `DANGEROUS` (no cited proof). If it produces "not `SAFE`", it is
   §3.1's forbidden predicate. If it produces neither, it is a log line — and a
   log line does not need a pipeline stage.
3. **It is the archetype N-4 forbids.** It adds a branch to *handle* an incoherent
   state instead of making the state unrepresentable. Rule 1: *"If a boundary can
   reach a state it cannot act on — nothing meaningful to do, nothing to check —
   that is not a branch to write, it's a hole to close at the boundary."* The hole
   is in the judge's output vocabulary, one stage upstream. Rule 2: *"the root
   cause is usually non-local."*

There is exactly one grouping over resolutions that earns its keep, and it is
narrower than a coherence pass: **K hypotheses deferring with the same
`missingObservation` is one oracle gap, not K** (see §4, failure mode F1c). Note
it groups *deferrals*, never refutations, so it can never influence a malice
decision.

### 3.3 Unframed-behaviour detection — two things wear this name; one is a trap

**The computable version — "unaddressed salient rows".** Classify rendered rows
into a salient set (egress: `net`/`http`/`dns`/`tls`; `spawn`; fs-mutation; reads
of credential paths), then per run subtract the rows its judge referenced.
Measured across all four bundles:

| Bundle | Distinct salient keys | Never referenced by **any** judge | Runs firing |
|---|---|---|---|
| `chalk@5.6.2` | 0 | 0 | 0 of 1 |
| `is-number@7.0.0` | 0 | 0 | 0 of 2 |
| `test-pkg-dns-exfil@0.2.1` | 160 | **74** | 11 of 14 |
| `test-pkg-env-exfil@2.0.1` | 25 | **21** | 9 of 14 |

In `env-exfil`, seven credential files (`~/.aws/credentials`, `~/.ssh/id_rsa`,
`~/.gitconfig`, `~/.docker/config.json`, `~/.kube/config`, `~/.yarnrc`,
`~/.aws/config`) were read in **9 of 9** runs and **not one judge in the entire
audit pointed at any of them.** That is the §24.9 intuition, quantified.

**Why it is nonetheless a trap.** The `0 of 3` on the benign side is worthless as
a false-positive estimate: both benign fixtures make zero network calls and zero
credential reads, so the check had no opportunity to fire. A real benign package
*will* fire it — `dotenv` reads `.env`, an npm auth helper reads `~/.npmrc`, any
analytics SDK egresses. And look at what the salient-row classifier *is*: a
capability heuristic. "Egress went unaddressed ⇒ no `SAFE`" is a static-suspicion
predicate with an extra step, and it would make ordinary packages permanently
unauditable. The constraint explicitly rules this out, correctly.

**The rescue is to invert who decides salience.** Do not ask "did anyone address
the egress?" — that requires the engine to decide which rows matter, which is a
malice judgement. Ask *"did the judge that read this run have what it needed?"*
Only the judge can answer that, it answers it about its own claim rather than in
general, and its answer is a coverage statement. **Direction 3, done honestly,
collapses into the recommendation.**

One genuinely model-free coverage check does survive from this direction, and it
is the cheapest thing in this document — see R2 in §4.

### 3.4 Redundancy accounting and a stated floor — reject the floor

**8 is already a ceiling the model saturated, not a designed property.** The FLAG
task text says *"at most 8 highest-signal thin flags"* (`phases.py:484`), and
`normalize_bounded_response` truncates at `flags[:8]` (`phases.py:200`). Both
malware bundles hit exactly 8 on their payload file. A *floor* would have to
force flags on a file the model found boring, which is fabricating suspicion —
the one thing `prompts/flag/v1.md` is careful not to do (*"Return zero flags only
for genuinely boring code"*, and the zero-flag early return at §12 depends on that
being truthful).

**And the eight were not eight independent tests.** All eight `setup.js`
hypotheses triggered the same file with near-identical setups, produced 147–157
row timelines, and eight of the resulting verdicts pointed at the same POST. Cost:
nine container runs at 5.07–5.58 s wall each (~47 s of sandbox time) plus nine
judge calls at ~3.1 k prompt tokens, to add one confirmation.

**What the redundancy actually bought was eight extra samples of a flaky sensor** —
3 of 9 runs produced an L2 `http_request`, and the audit survived because
`hyp-0008` was one of the three. Sensor resampling is a legitimate way to buy
detection, but it should be deliberate (fix or assert the sensor) rather than
accidental (run the same experiment eight times at $0.01 and 5 s each). And after
the `sensors.py` peer fix the same fact renders in 9 of 9, so the redundancy's
value falls sharply — which is itself the argument against enshrining it.

**Verdict: no floor. Record the fan-out and the confirmation concentration as bench
statistics (§6) so the reader can see how wide the engine's recall actually is.**

---

## 4. Recommendation

### R1 — Give the judge a third answer, and route it to the state that exists

**Contract change** (`phases.py:204-209`):

```
JudgeVerdict (extra="forbid")
  decision            : "CONFIRMED" | "REFUTED" | "UNDECIDABLE"   ← was malicious: bool
  reason              : str
  citedEvents         : list[str]
  missingObservation  : MissingObservation | None                 ← new, required iff UNDECIDABLE
```

`MissingObservation` is a **closed vocabulary of sensor-shaped facts** the oracle
could in principle carry, not free prose. Drawn from what the corpus's judges
actually asked for:

```
request_body        the bytes of an outbound request        (hyp-0004, hyp-0005)
response_body       the bytes of an inbound response
planted_file_content  correlation of a planted file's content with egress
                      (§24.0: "planted file contents remain uncorrelatable")
network_endpoint    the host:port a connection actually used  (hyp-0001/6/7)
spawned_process_env  the environment a child process received
decrypted_payload   the plaintext of an in-process decryption
```

**Validation** (`orchestrator.py:81-89`, three checks become four):

```
CONFIRMED   requires ≥1 cited id;  unknown ids reject          (unchanged)
REFUTED     forbids citedEvents;   forbids missingObservation  (unchanged + 1)
UNDECIDABLE forbids citedEvents;   requires missingObservation ∈ the enum
```

**Resolution mapping** — one added arm beside the two that already exist
(`orchestrator.py:231-247`):

```
UNDECIDABLE → graph.add_evidence(hypId, [evidence_ref])
              graph.transition(hypId, "DEFERRED", by="worker:experimenter",
                reason=f"Oracle did not capture the decisive fact "
                       f"({missingObservation}): {reason}")
```

Structurally identical to the `judge_failed` and `unresolved_module` arms, whose
comment already states the principle: *"That is a coverage gap, not a refutation
— deferring keeps a broken run from laundering an unproven suspicion into SAFE."*

**What changes downstream: nothing.** `graph.py`, `derive_graph_verdict`,
`pipeline.py:416-424`, both assertions, the report shape, the SSE vocabulary — all
untouched. `DEFERRED` + 0 confirmed already raises `AuditIncompleteError` with the
cause quoted. `DANGEROUS` gains no new path. `UNDECIDABLE` is strictly weaker than
both `CONFIRMED` and `REFUTED`: it can never create a finding, only withhold a
clearance. **The frozen pipeline shape is not touched.**

**What `SAFE` becomes.** From *"every suspicion ran"* to *"every suspicion ran and
every judge affirmed it had what it needed."* That is the property `shared/src/models.ts:7-11`
already claims in prose and the code did not deliver.

### R2 — Assert render fidelity (model-free, do this first)

`render_timeline` must not emit an anonymous target (`socket`, `fd:N`) for an
event whose `normalized`/`raw` carries a resolvable one. Corpus baseline: **244
anonymous-target rows out of 4,140 rendered rows**, against **306 artifact events
whose raw holds a parseable `sin_addr`/`sin_port` peer**.

The peer-parse *fix* has landed (`sensors.py:139-146`). The *invariant* has not,
and §24.0 closes with precisely the reason it must: the dead regex stayed green
for its whole life because `test_sensors.py` C2 asserted a line shape strace never
emits. Per N-4 rule 3 and rule 6, a fix without an assert is a fix waiting to
regress. Two live residuals this assertion would catch:

- The AF_UNIX/netlink recycled-fd fallback, still unfixed and pinned by
  `test_evidence.py` C14b (`evidence.py:415-431` documents it), which renders
  **false** targets: `connect /etc/localtime`, `send /etc/nsswitch.conf`. A vague
  target starves the judge; a false one misleads it.
- `read`/`write` resolve through the fd table without consulting its
  `is_socket` flag (`evidence.py:414`), which is how
  `write(18, "GET /latest/meta-data/…")` became `write socket`.

**Sequence R2 before R1, and this ordering is load-bearing.** Ship R1 first and
every judge that cannot see the IMDS endpoint returns `UNDECIDABLE`, so every
`env-exfil`-shaped audit becomes a retryable error instead of `DANGEROUS` —
honest, and useless. R2 removes the artefactual undecidables (6 of the 7 payload
refutations, per §1.2 correction 4) so R1 fires only on genuine oracle gaps
(1 of 7). This is D-9's ordering argument applied one level down.

### R3 — Make the setup-as-proof guard bidirectional

Amend `orchestrator.py:77` so the prompt forbids using the declared setup to
*acquit* as well as to *confirm*. Two of seven refutations did the former (§1.4),
against a manipulation §24.0 proves never applied. One line, one re-record.

### Failure modes of the recommendation

**F1 · `UNDECIDABLE` becomes the model's escape hatch.** *The strongest objection.*
A cheap judge facing a hard question learns a third option that is always
available and never wrong. Packages that used to be `SAFE` become permanently
unauditable: error → retry → error, burning a full orchestrator loop each time.
Three mitigations, in order:

- **(a) The closed vocabulary is the primary defence.** "Insufficient evidence" is
  not a member of the enum. A judge must name a *sensor-shaped* fact, which makes
  the field checkable without checking semantics — and makes each undecidable an
  actionable sensor ticket rather than a shrug.
- **(b) Treat the `UNDECIDABLE` rate as a model-tier disqualifier**, exactly as
  `[[prod-triage-model-deepseek-blind]]` treats false-SAFE. This is a bench
  statistic (§6) and it directly informs O-7. The recorded corpus runs
  `deepseek/deepseek-v4-flash` as the investigation model — the tier that memory
  says returned false-SAFE on textbook exfil — so a baseline measurement on it is
  cheap and immediately interpretable.
- **(c) Group by cause, not by node.** K hypotheses deferring with the same
  `missingObservation` is **one** oracle gap. Report it once. This is the only
  cross-hypothesis grouping in this document, and it groups deferrals only.

**F2 · The retry is not a fix.** `AuditIncompleteError` is retryable
(`NPMGUARD-0031`), which is correct for today's deferral causes — sandbox,
provider, timeout — because they are transient. An oracle gap is *deterministic*:
the retry reproduces it exactly. Either this cause must be non-retryable, or
§4.4's first-class `ERROR` outcome must be a terminal, showable state that says
*what is missing* instead of inviting a retry. §4.4 already argues for the latter
(*"We tried and failed — and that is a fact worth showing"*), and an oracle gap is
its best instance. **This is a product decision with a user-visible consequence and
it belongs to the owner, not to this document.**

**F3 · Some correct refutations will become no-verdicts, and specificity will
move.** On the corpus, `hyp-0010`/`0011`/`0013` refuted against genuinely empty
timelines and would not plausibly go undecidable. But `hyp-0012` and `hyp-0014`
already discuss what their runs *failed to exercise* — `hyp-0014`: *"the patched
version was not actually invoked because the patched `require('module')._load`
never triggered"*, which is an experiment that did not test its own hypothesis and
is arguably a `DEFERRED` today. R1 will reclassify an unknown fraction of current
refutations. **Measure that delta on the corpus before publishing any rate.**

**F4 · Prose-to-schema risk.** Per `[[llm-structured-output-not-hard-constrained]]`
the enum is not hard-constrained. Measured evidence is favourable (0 phantom ids
in 34 parsed outputs; 2 schema violations, both caught and repaired on retry —
§3.1), and the degradation path is already safe: an unrepairable verdict raises, which sets `judge_failed`,
which DEFERs (`orchestrator.py:101-103, 234`). The new field's worst case is the
existing worst case.

**F5 · `missingObservation` is model-adjacent text on an error surface.** Keep it
an enum member for logic and put the free prose in `reason`, treated as untrusted
display text (length-bounded, no markup) wherever the panel or CLI renders it.

**F6 · The judge still sees one hypothesis and one timeline.** This design does not
change that, and does not claim to. A behaviour that *no* hypothesis in the graph
addressed, in a run where every judge honestly affirmed sufficiency for its own
claim, remains invisible. That residual is real. It is also the residual the
constraint protects: closing it requires deciding malice from an unframed
observation, which is the property the engine trades nothing for.

---

## 5. What it would take to build

Paper estimate. Touch points, all verified against today's source.

| Site | Change |
|---|---|
| `phases.py:204-209` | `JudgeVerdict`: `malicious: bool` → `decision: Literal[...]`; add `missingObservation` |
| `engine/prompts/judge/v1.md` | Third option + its rule + the closed vocabulary |
| `orchestrator.py:77` | R3: bidirectional setup guard |
| `orchestrator.py:81-89` | `validate_verdict`: three checks → four |
| `orchestrator.py:100-105` | `JudgeResult` carries `decision`; judge-failure path unchanged (a dead judge still cannot refute) |
| `orchestrator.py:231-247` | One added defer arm |
| `orchestrator.py:197-214` | `experiment-{hypId}.json` gains `decision`, `missingObservation` (it records `confirmed: bool` today) |
| `evidence.py:405-437` | R2 render-fidelity assertion; the C14b fallback lands with it |
| `shared/src/` | Judge/experiment-log shape (Phase 0 / N-12 owns this) |
| `test_evidence.py`, judge tests | R2 assertion; three judge cases; C14b flips green |

**Untouched, deliberately:** `graph.py` (no new state, no new guard),
`derive_graph_verdict`, `pipeline.py`'s defer gate, both assertions, the SSE event
vocabulary, `AuditReport`.

**The real cost is not code — it is a re-record, and it is an owner decision with
a dollar attached.** Per N-5, editing a prompt fails every recorded exchange loud.
R1 and R3 both edit the judge prompt; R2 changes the rendered timeline, which
changes the judge prompt's *content* and shifts event ids. So all three land as
one re-record of all four bundles (≈26 judge exchanges, plus the flag/hypothesis
exchanges that stay valid). D-9 already states this constraint in exactly these
terms; this spec adds nothing new to it, and notes that R2's re-record is one the
C14b fix needs regardless.

**Sequence:** R2 → measure the undecidable rate on the re-recorded corpus → R1 +
R3 in the same re-record → measure the reclassification delta (F3) → only then let
the bench publish a rate.

---

## 6. How this changes what the benchmark measures

`bench/METHODOLOGY-V2-DRAFT.md` is about to publish detection rates. If detection
depends on a framing lottery, the rates measure the lottery. D-9 already ordered
§24 fidelity ahead of Phase 7b for exactly this reason. This pass adds one
correction and four recordables.

### 6.1 The correction: §3.2's invariant 2 is overstated

The draft states (§3.2, item 2):

> **`SAFE` implies full coverage.** … So a `SAFE` verdict on known malware is a
> *fully evaluated* false negative — every suspicion the engine raised was run and
> came back clean. That is a much stronger statement than "the scanner didn't flag
> it", and §4.2 relies on it.

`graph.py:322-325` asserts that no node is `DEFERRED` when `SAFE` is returned —
i.e. **dispatch** coverage: every hypothesis reached a terminal state. It does
**not** assert **evidentiary** coverage: that the judge saw what the sensors
captured. The corpus falsifies the stronger reading directly: eight of nine
`setup.js` runs "came back clean" while the sealed artifact of every one of the
nine held `connect(→169.254.169.254:80)` and
`write(18, "GET /latest/meta-data/ HTTP/1.1…", 82) = 82`, rendered as
`connect socket` / `write socket`.

So a published miss on today's engine means *"the engine ran every suspicion and
its renderer hid the proof from its judge"* — materially weaker and different from
what the draft's sentence claims. §4.2's `MISSED` bucket inherits the weakness,
and §10's own threats list already flags the dependency (*"The engine's
SAFE-implies-full-coverage invariant is doing real work in §4.2, and the strength
of the `MISSED` claim depends on it holding"*) without noticing that the invariant
is narrower than the sentence using it. **With R1 + R2 the invariant becomes true
as written.** Until then, qualify the sentence and add a threat: *the
SAFE-implies-coverage invariant is about dispatch, not evidence.*

Same class of imprecision in **D-9** itself: *"13 of 14 hypotheses were refuted
citing rendering artefacts rather than absent malice."* Thirteen were refuted;
three cited the port artefact; five ran against `index.js` on empty timelines and
are honest. The accurate version: **"7 of the 8 hypotheses about the payload file
were refuted, and every one of the 7 was decided on a rendering of the evidence
rather than on its absence — 6 on facts the sealed artifact held and the renderer
dropped, 1 on a fact no sensor captured."** Stronger *and* narrower.

### 6.2 What the bench must record

All four are **observations, derived at read time** — F-G2 compliant, nothing
stored as a judgment. Items 1–3 read the report (§3.1's tier 2); item 4 reads the
sealed artifact.

1. **Confirmation concentration** — for each `DANGEROUS` catch, `confirmedCount /
   counts.total`. Corpus: `env-exfil` **1/14**, `dns-exfil` **5/14**. A corpus
   whose catches are mostly 1-of-N has recall one hypothesis wide, and the
   headline rate should not be reported without this distribution beside it.

2. **Behaviour multiplicity** — the maximum number of distinct hypotheses whose
   `resolution.reason` references the same normalised behaviour key. Corpus:
   **9** (`env-exfil`), **8** (`dns-exfil`). Computable today by scraping
   `e\d+` from `resolution.reason` against the persisted `timeline-{hypId}.md`;
   structured once `addressedEvents` exists (§3.1). Publish it with §4.6's
   discipline for `claim.kind`: *a description of the tool's reasoning, not
   recall*. It is the number that makes the lottery visible.

3. **Undecidable rate, by `missingObservation` and by model tier** — the direct
   measure of oracle coverage, and per F1b a model-tier discriminator that feeds
   **O-7**. This is the recordable that most changes the bench: it converts
   "detection rate" from one number into *detection rate at a stated evidentiary
   coverage*, which is the only version of the number that survives a sensor
   improvement without re-invalidating history.

4. **Render-fidelity defect count** — anonymous-target rows per run, model-free
   from the artifact. Corpus baseline **244 / 4,140 rows (5.9%)**, and 306
   artifact events carry a parseable peer. A rate published against a run whose
   fidelity count is non-zero is a rate with a known, quantified leak.

### 6.3 Two knock-ons for the taxonomy

- **D-6's `ABSTAINED` bucket gets a real population.** Today the design doc notes
  that "a report with deferred-but-nothing-confirmed does not exist" — true, and
  R1 does not change it. What R1 changes is *how often* the `verdict == null` /
  `status = error` observable occurs, and it gives that observable a
  machine-classifiable sub-cause (`missingObservation`) alongside the
  `NpmGuardError` code D-6 already keys on. D-6's split survives intact; its
  `ABSTAINED` side becomes informative instead of nearly empty.
- **The N=5 stability probe (D-7 / §6.5) is measuring more than D-7 thinks.**
  Corpus evidence: nine near-identical runs of one file produced an L2
  `http_request` in three. That is not model stochasticity — it is *sensor*
  stochasticity, and the two are confounded in any replication count. The probe
  should record the per-run fidelity count (item 4) so the two sources can be
  separated. Without that, unanimity or its absence cannot be attributed.

---

## 7. Deliberately ruled out

- **Any rule that reads a count of refutations, or overlap between them, as
  evidence about malice.** Stated as an invariant for future readers: *the number
  of refutations is not evidence.* It is a property of FLAG's fan-out, which on
  this corpus ranges 1..14 with no relation to ground truth (`chalk` 1 → SAFE
  correct; `is-number` 2 → SAFE correct; both malware bundles 14).
- **An audit-level coherence stage** (§3.2). Weaker identity relation, no
  actionable output, and N-4 rule 1 forbids the shape.
- **A FLAG floor** (§3.4). A floor forces fabricated suspicion and buys
  correlated tests.
- **A second-opinion judge on refutations.** A second model reading the same
  timeline under the same schema has the same blind spot — on this corpus it would
  read `connect socket` too — and the disagreement it produces has no honest
  mapping to a verdict.
- **Reviving `UNKNOWN` as a third verdict inside the audit core.** §23 records
  that `withCoverageGap` was superseded; §4.4 gives the outcome axis a
  first-class `ERROR`. `VerdictEnum` stays two-valued
  (`shared/src/models.ts:12`); the third state lives on the graph node
  (`DEFERRED`) and on the outcome axis (`ERROR`), both of which already exist.
- **Cross-run event identity as a load-bearing mechanism.** Content keys are fine
  for a bench statistic and unfit for a verdict input; ids are per-render and will
  stay that way, because making them stable across runs would mean rendering
  events the run did not produce.

---

## Appendix — corpus facts used, and where to re-derive them

Everything below is reproducible with no model calls and no docker.

| Fact | Source |
|---|---|
| 14 hypotheses, focus files, trigger targets | `fixtures/llm/test-pkg-env-exfil@2.0.1/hypotheses.json` |
| 16 judge calls, 2 retries, verdicts + prose | `…/exchanges/043..058_judge_*.json` |
| 36 judge exchanges / 34 parsed / 0 phantom ids / 2 schema violations | all four bundles' `exchanges/*_judge_*.json` + `meta.recordedStatus` |
| Judge model = `deepseek/deepseek-v4-flash` | `…/manifest.json` → `models.investigation` |
| Exfil POST at 9 different ids across 9 runs | `…/sandbox/hyp-000{1..9}.timeline.txt` |
| `connect(→169.254.169.254:80)` + `write(…82) = 82` in 9 of 9 | `…/sandbox/hyp-000{1..9}.runartifact.json`, `events[].raw` |
| L2 `http_request` in 3 of 9 | same artifacts, `events[].stream == "L2:pcap"` |
| `connect socket` / `write socket` / `read socket` | `…/sandbox/hyp-0001.timeline.txt:126-129` |
| 21 of 25 salient keys unreferenced | join `resolution.reason` ids × timeline rows |
| 244 anonymous rows / 4,140 rendered | all 31 timelines across the four bundles |
| Wall times 5.07–5.58 s, exit 0, no timeouts | artifacts' `wallMs`, `exitCode`, `timedOut` |
| 49,313 + 1,965 judge tokens | judge exchanges' `response.body.usage` |

All `file:line` citations were verified against the working tree during this pass.
Three agents were editing `engine/` and `frontend/` concurrently, so re-grep the
symbol rather than trusting a line number if it does not land.

**Corpus caveat, repeated because it matters:** these are the *recorded* engine.
`sensors.py`'s peer parse, the L4 port, request-body capture, and the require-hook
order have since been fixed (§24.0). The measurements above therefore describe the
engine that produced the fixtures, and are the correct baseline against which to
measure the fixes — not a description of today's behaviour. The one finding that
is fix-independent, and the one this spec acts on, is that
`JudgeVerdict.malicious` is a `bool`.
