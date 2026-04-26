# NpmGuard Benchmark — Methodology

_Version 1.1 · 2026-04-26_

This document describes the methodology used to measure the detection accuracy
of NpmGuard, the npm supply-chain auditor. It is written so that an
independent researcher can reproduce, criticize, and extend the results.

The benchmark is layered. **The primary method is Temporal Retroactive
Testing** against the
[Datadog Malicious Software Packages Dataset](https://github.com/DataDog/malicious-software-packages-dataset):
~26 000 real, human-vetted malicious npm packages discovered in the wild
since 2023. NpmGuard is run against a stratified sample of this corpus,
producing the headline number — *"of N real-world npm malware events,
NpmGuard would have flagged K of them"*.

A secondary method, **Security Mutation Testing**, ships in a later
revision: synthetic mutations of benign packages let us probe specific
attack classes and adversarial sophistication tiers in a way Datadog's
unstructured corpus cannot. Mutation testing is described in §13 and
deferred to v2 of the methodology — Datadog replay is sufficient for v1
because it answers the question a CISO actually asks: *"would this tool
have caught the attacks of the past two years?"*.


## 1. Problem statement

The space of "supply-chain auditors for npm" includes `npm audit`, Snyk,
Socket, Phylum, OSSF Scorecard and others. Vendor-published numbers are
typically:

- not reproducible (closed datasets, no script to re-run),
- not statistically rigorous (single point estimates, no confidence intervals),
- silent on robustness (no anti-evasion testing),
- silent on cost (LLM, sandbox compute).

A serious benchmark must (a) be re-runnable by any reader, (b) cover a
canonical taxonomy of supply-chain attacks, (c) produce numbers with stated
uncertainty, (d) report what the tool *fails* to catch as prominently as
what it catches.


## 2. Why Datadog replay first, mutation later

The conventional benchmark options are:

1. **Hand-crafted minimal samples.** A `test-pkg-env-exfil` containing 30
   lines of hostile code. Useful as unit tests; useless as a benchmark
   because the signal-to-noise ratio is artificially favourable to the
   auditor.
2. **Mutated real packages.** Inject canonical malicious snippets into
   benign packages. Gives full coverage control, fully reproducible, but
   subject to the *"your mutations are not realistic"* critique that no
   adversarial reviewer ever finds answerable.
3. **Real published malware** — Datadog's dataset of ~26 000 npm packages
   that were *actually deployed in attacks against real developers and
   pulled from the registry by Datadog's GuardDog tooling*. Each sample
   has been manually triaged. This is what we use.

Real malware solves four problems at once that the alternatives do not:

- **Credibility.** A CISO does not want to know whether NpmGuard flags
  *"a pretend env-exfil snippet we wrote ourselves"*. They want to know
  whether it would have flagged `ua-parser-js@0.7.29`, `event-stream@3.3.6`,
  the 2024 Lottiefiles incident. Datadog has those packages.
- **No mutator-design bias.** Mutations encode the benchmark author's
  imagination of what attackers do. Real malware encodes what attackers
  actually did. The first is bounded by us; the second by the world.
- **Free competitive comparison.** Snyk, Socket, Phylum and `npm audit`
  can each be wrapped to ingest exactly the same Datadog corpus, giving
  an apples-to-apples comparison without us writing wrappers that "happen
  to favour" our own malicious patterns.
- **Continually-updated dataset.** Datadog adds new samples as new
  attacks happen. A bench that re-runs against the dataset stays current
  for free, while a hand-crafted one needs continuous editorial work to
  keep up.

The trade-offs are real and we name them:

- **Selection bias.** The Datadog corpus is what GuardDog (Datadog's own
  auditor) flagged. Attacks GuardDog missed are absent. If a competitor
  has trained on this same public dataset, they have a head-start. v1
  measures *"can NpmGuard match what's already known"*; v2 (mutation
  testing, §13) measures *"can NpmGuard find what no one trained on yet"*.
- **Limited per-class control.** The dataset is not tagged by attack
  class — Datadog has an internal clustering algorithm but does not
  publish it. We can stratify by `compromised_lib` (existing benign
  package, malicious release pushed by attacker) versus `malicious_intent`
  (package whose entire purpose is to deliver malware), but finer-grained
  taxonomy must be inferred from sample inspection. Recent samples
  dominate the dataset; older incidents may not be present.
- **Ethics of execution.** The dataset contains live malware. The bench
  never runs the package — only reads the source from inside a sandbox.
  The Datadog `infected` zip password is not a security control, it is a
  speed-bump that prevents accidental execution by file-management
  utilities.

Mutation testing (§13) earns its keep in v2 once the v1 Datadog replay is
in place: it adds the per-class breakdown and the adversarial-sophistication
tiers that the unstructured corpus does not provide.


## 3. Stratification of the Datadog corpus

The dataset's only built-in stratification is the
`compromised_lib` / `malicious_intent` split:

- **`malicious_intent`** — packages whose entire purpose is to deliver
  malware. Typically published under typosquat names (e.g. `react-native-aria`
  vs the legitimate `react-aria`), short-lived, and with minimal cover. These
  are the **easier** detection target: there is no benign behaviour to hide
  the payload.
- **`compromised_lib`** — historically benign packages that received a
  release containing attacker-introduced code. The malicious code lives
  inside a working library with thousands of legitimate lines. These are
  the **harder** target: noise-to-signal ratio is high, and a static
  scanner that flags every `process.env` access as suspicious will produce
  false positives the user dismisses.

A v1 benchmark run reports:

- **Overall recall** — fraction of all sampled packages flagged DANGEROUS.
- **Recall on `malicious_intent`** — the easy mode.
- **Recall on `compromised_lib`** — the realistic mode (what most CISOs
  actually fear).
- **Recall on a temporal slice** — packages whose discovery date is
  within the last six months at run time. This isolates the auditor's
  performance on attacks too recent for any tool to have memorised.

A v2 benchmark adds per-attack-class recall by feeding each sample
through a classifier (either a heuristic over the source code, or an
LLM-as-judge step). The classifier output is treated as an additional
metadata column; runs do not change shape.

Note on selection bias: the corpus over-represents the attack patterns
that the Datadog GuardDog ruleset was designed to catch. A tool that
shares heuristics with GuardDog will appear strong; a tool that diverges
will appear weak even when correct. We address this two ways: (a) by
publishing the manifest hash of the exact dataset commit used for each
run so re-checks against future dataset versions are possible, (b) by
adding the v2 mutation methodology specifically because it does not
share Datadog's biases.


## 4. Seed corpus

The benchmark uses a curated catalogue of **30 real npm packages** (target;
v1.0 ships with a tier-1 subset, see release notes for the actual count).
Selection criteria, in priority order:

1. **Currently published, non-deprecated.**
2. **High weekly downloads** (≥1M for tier-1, ≥10k for tier-2). Real
   packages, not exotica.
3. **Diverse profiles**: pure-utility (no network or fs), network-using,
   filesystem-using, build-tool, crypto, native-binding, ESM-only,
   CJS-only, dual-mode.
4. **Loadable in isolation**: `node -e "require('package-name')"` succeeds
   without a config file.
5. **Source available** in the published tarball (not a thin
   compiled-only artefact).

Each catalogue entry is pinned to an exact version and an `integrity`
field — the SHA-256 of the tarball as reported by the npm registry.
The seed fetcher refuses to proceed on a hash mismatch. This ensures that
re-runs in 2027 see the same source code as runs today even if a
dependency upstream is republished or unpublished.


## 5. Mutator design

A **mutator** is a deterministic function from a seed package to a patched
copy plus expected-result metadata:

```
mutator: (seedDir, outDir) -> {
  expectedVerdict: "DANGEROUS",
  expectedCapabilities: ["NETWORK", "ENV_VARS"],
  expectedKind: "TEST_CONFIRMED" | "AI_DYNAMIC",
  difficulty: "trivial" | "obfuscated" | "evasive",
  rationale: "free-text description of why this is malicious",
}
```

Mutators emit canonical, well-known malicious patterns, not novel research.
The benchmark measures detection of *known* attacks. Novel-attack research
belongs elsewhere (red-team exercises, adversarial fuzzing).

Each mutator carries a `difficulty` tier:

- **trivial**: payload is structural and obvious (synchronous POST, plain
  `eval`). A competent static analyser should catch it.
- **obfuscated**: payload is functionally equivalent but uses indirection
  (base64, dynamic property access, `Function` constructor).
- **evasive**: payload includes guards that suppress execution under
  analysis (sandbox detection, time bombs, geo-gating). The auditor must
  either neutralise the guard (mock time, mock locale) or detect the
  guard itself as suspicious.


## 6. Negative controls

A benchmark that only measures recall is gameable: a tool can flag every
package and score 100% recall while being useless. To measure precision,
we run **negative controls**:

1. **Unmutated baseline**: each seed in the catalogue is audited with no
   mutation. Expected verdict: `SAFE`.
2. **Innocuous mutations**: applies a code change that is *structurally
   detectable* but semantically harmless. Examples: insert a top-of-file
   comment block, add a `console.log("loaded")`, append `// fix typo`.
   Expected verdict: `SAFE`.
3. **Version bump**: identical source, only `package.json#version` is
   incremented. Expected verdict: `SAFE` (and ideally identical findings
   to the unmutated baseline).

A serious auditor must achieve **precision ≥ 95%** on negative controls,
i.e. false-positive rate ≤ 5%. Anything worse is a research prototype, not
production tooling.


## 7. Post-mutation load verification

Every generated mutation is subjected to:

```
NODE_ENV=test node -e 'require("/path/to/mutated-package")'
```

before inclusion in the benchmark run. A mutation that prevents the host
package from loading produces noise (the auditor reports an inventory
error rather than a security finding) and is excluded. Excluded mutations
are reported in the per-run summary so the dataset's effective coverage is
visible.


## 8. Statistical methodology

LLM outputs are stochastic. A single audit run produces a single sample of
the underlying detection distribution. Single-run benchmarks therefore
report point estimates with no characterisation of variance, which is
unscientific.

For each `(seed × mutator × variant)` triple, the runner executes **N=3
audit runs** (configurable). Each run produces a binary detection event:

- `detected = (verdict === "DANGEROUS") AND (expectedCapabilities ⊆ report.capabilities)`
- `verified = detected AND (any proof matches expectedCapability with kind === "TEST_CONFIRMED")`

Aggregates per attack class are computed as:

- **Recall** = `Σ detected_i / Σ runs_i`
- **Verifiability** = `Σ verified_i / Σ detected_i` (conditional on detection)
- **Precision** = `1 − (Σ false_positives on negative controls / Σ negative-control runs)`

For each rate, we report a **Wilson score 95% confidence interval**
(Wilson, 1927) computed as

```
CI_lower, CI_upper = (
  (p̂ + z²/(2n) − z·√((p̂·(1−p̂) + z²/(4n))/n)) / (1 + z²/n),
  (p̂ + z²/(2n) + z·√((p̂·(1−p̂) + z²/(4n))/n)) / (1 + z²/n),
)
where z = 1.959964 (97.5%-quantile of N(0,1)).
```

Wilson is preferred over the more familiar Wald (`p̂ ± z√(p̂(1−p̂)/n)`)
because Wald produces malformed intervals near 0 and 1, exactly the regime
where a strong auditor lives.

A weighted aggregate recall across classes is reported using the
Datadog-derived class frequencies in §3 as weights. Unweighted recall is
also reported for transparency.


## 9. Cost & latency reporting

Each run records, per audit:

- wall-clock time from request to verdict
- LLM token usage (prompt + completion) tagged by phase (triage,
  investigation, test-gen, verify-retry)
- sandbox compute time (`docker exec` wall clock)

The benchmark summary reports median, p95, and p99 latencies; total
LLM token cost converted to USD using the OpenRouter price list at run
time (snapshot stored alongside the result for historical accuracy);
total sandbox compute time.

A reproducer will know in advance what one full benchmark run will cost.
A reader can verify whether the auditor's precision is achievable at the
auditor's claimed cost.


## 10. Reproducibility

A run is fully described by:

- the bench dataset version (semver-tagged in the repo)
- the engine version (git commit SHA)
- the LLM model identifier and version (e.g. `gemini-2.5-flash@2026-04-15`)
- the docker image used by the sandbox phase, by digest

All four are written into the result file. Two runs that share the same
four identifiers and a common N=3 sample size should produce statistically
indistinguishable aggregates.

Datasets are **immutable** once tagged. New attack classes, new variants,
or new seeds produce a new dataset version. This lets researchers compare
auditor versions on a fixed dataset, or compare datasets with a fixed
auditor.


## 11. Out of scope (for v1)

- **Comparative testing of every auditor in the market.** v1 ships
  comparison wrappers for `npm audit` and Snyk only. Adding Socket,
  Phylum, OSSF Scorecard, and others is mechanical work queued for
  subsequent dataset versions.
- **Mutation-based testing.** The v2 framework (§13) probes the
  auditor's response to controlled, synthetic attacks at chosen
  sophistication tiers — useful as a complement to the real-world
  Datadog replay but not the headline number for v1.
- **Adversarial AI red-teaming.** Generating *novel* attacks
  adversarially against the auditor (e.g. via LLM-driven mutator search)
  is research out of scope for an evaluation benchmark and depends on
  v2 being in place first.


## 12. Limitations

- **Mutation realism.** A real npm-malware author chooses where in the
  package to inject the payload, often in ways that minimise behavioural
  change. Our mutators inject at canonical points (top-of-main, postinstall,
  etc.). Findings on mutated packages may therefore *over*-estimate
  detection rate compared with the most evasive real-world malware.
- **LLM stochasticity bound.** With N=3 runs, the Wilson 95% CI for a
  point estimate of 80% is roughly [40%, 96%]. Higher precision requires
  more runs and therefore more LLM cost. v1 trades precision for
  affordability; a budgeted re-run with N=10 is supported by the runner.
- **Native bindings.** Packages that ship `.node` files (e.g. `sharp`,
  `bcrypt`, `sqlite3`) cannot be instrumented at the JavaScript level.
  These seeds are flagged in the catalogue as `requires-native-handling`
  and excluded from runtime-evidence verifiability metrics; static-only
  detection is still measured.
- **No package-publish testing.** All audits run against local file
  paths. Publishing-time signals (typosquat similarity, account age,
  signature) are not exercised because the benchmark cannot ethically
  publish malicious packages to the public registry.


## 13. References

- D.S. Wilson, "Probable Inference, the Law of Succession, and Statistical
  Inference," _Journal of the American Statistical Association_, 1927.
- Y. Jia & M. Harman, "An Analysis and Survey of the Development of
  Mutation Testing," _IEEE Transactions on Software Engineering_, 2011.
- Datadog Security Labs, _Malicious Software Packages Dataset_,
  https://github.com/DataDog/malicious-software-packages-dataset.
- SAP Security Research, _Risk Explorer for Software Supply Chains_,
  https://github.com/SAP/risk-explorer-for-software-supply-chains.
- MITRE, _Software Supply Chain Compromise (T1195)_,
  https://attack.mitre.org/techniques/T1195/.


## 13. v2 mutation methodology — preview

Once v1 Datadog replay is in production, mutation testing is added on
top to address what Datadog cannot: per-attack-class recall, controlled
sophistication tiers, and adversarial novelty.

The mutation framework will use a stratified design:

1. **Five attack classes** (`CREDENTIAL_EXFIL`, `LIFECYCLE_HOOK_ABUSE`,
   `CODE_EXECUTION`, `NETWORK_EXFIL`, `ANTI_ANALYSIS`).
2. **Four sophistication tiers per class**:
   - **T1 — blatant**: top-of-file injection, plain JavaScript.
   - **T2 — function-wrapper**: replace an exported function with a
     transparent interceptor (mimics the `event-stream` archetype).
   - **T3 — obfuscated**: payload encoded (base64, charcode, dynamic
     property access) and `eval`'d at runtime.
   - **T4 — evasive**: payload guarded by sandbox detection, time bomb
     or geo-gate; runs only under specific conditions.
3. **Three negative controls** (innocuous comment, console.log, version
   bump) to measure false-positive rate.

Aggregate recall in v2 is computed both unweighted and weighted by
real-world tier frequencies derived from sample inspection of the
Datadog corpus (approximately 0.45 / 0.30 / 0.15 / 0.10 from T1 to T4
in the absence of an authoritative source). Per-tier recall is published
alongside the aggregate so a reader can see exactly where the auditor
strengths and blind spots sit.

The seed corpus already shipped with v1 (Phase 1 of the bench code,
under `bench/src/seeds/`) is the substrate v2 mutates over. Switching
to v2 requires no changes to the v1 runner or analyzer; it only adds a
new manifest-source category and a directory of generated mutations.


## 14. Changelog

- **v1.0** (2026-04-26): initial methodology centred on Security Mutation
  Testing.
- **v1.1** (2026-04-26): pivoted to **Datadog replay as the primary v1
  method**. Mutation testing moved to v2 (§13). Negative controls and
  post-mutation load verification (§§6–7) preserved verbatim because
  they describe the v2 framework that the v1 runner will reuse.
- _(planned)_ **v1.2**: comparative wrappers for `npm audit` and Snyk
  CLI; same Datadog corpus, side-by-side detection table.
- _(planned)_ **v2.0**: stratified mutation testing per §13.
- _(planned)_ **v2.1**: adversarial / LLM-driven mutator search.
