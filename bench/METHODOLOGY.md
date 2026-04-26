# NpmGuard Benchmark — Methodology

_Version 1.0 · 2026-04-26_

This document describes the methodology used to measure the detection accuracy
of NpmGuard, the npm supply-chain auditor. It is written so that an
independent researcher can reproduce, criticize, and extend the results.

The approach is what we call **Security Mutation Testing** — a mutation-based
evaluation pattern adapted from the established mutation-testing methodology
in software-quality research (Stryker, PIT, Mutmut, Major). Where classical
mutation testing measures the quality of a *test suite* by injecting bugs,
Security Mutation Testing measures the quality of a *security tool* by
injecting canonical malicious behaviours into real, working npm packages and
measuring what fraction the tool detects.


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


## 2. Why mutation, not curated malware

Three corpora are commonly used:

1. **Hand-crafted minimal samples.** A `test-pkg-env-exfil` containing 30
   lines of hostile code. Useful as unit tests; useless as a benchmark
   because the signal-to-noise ratio is artificially favourable to the
   auditor and any pattern-matcher can find the malicious code.
2. **Real published malware.** The
   [Datadog Malicious Software Packages dataset](https://github.com/DataDog/malicious-software-packages-dataset)
   and the [SAP Risk Explorer](https://github.com/SAP/risk-explorer-for-software-supply-chains)
   collect thousands of real-world npm malware events. This corpus is the
   gold standard for *temporal retroactive testing* (cf. §11), but it is
   biased toward what other auditors have already learned to detect, and
   provides limited control over which attack classes are represented.
3. **Mutated real packages** — this benchmark.

   Take a real, popular npm package (e.g. `axios@1.7.2`). Inject a single,
   canonical malicious snippet representative of a known attack class (e.g.
   `process.env` exfiltration over HTTPS). The result is a package that is
   structurally identical to its real ancestor but contains a known,
   localised malicious behaviour. The auditor receives the noise of a real
   package and a ground-truth label.

Mutation gives us four properties no other corpus provides simultaneously:

- **Realism.** The host package contains genuine code structure, real
  dependencies, real conditional exports.
- **Ground truth.** We know exactly what should be flagged because we
  injected it.
- **Coverage control.** We choose which attack classes are represented and
  in what proportion.
- **Anti-gaming.** No two mutations produce byte-identical files; hash-match
  detection is impossible.

The trade-off is that a mutation may fail to "fit" its host (e.g. the
injected `require()` breaks a CommonJS-only loader). This is addressed in
§7 (post-mutation load verification).


## 3. Attack taxonomy

The taxonomy is derived from the Datadog dataset's category labels,
cross-referenced with the
[OWASP Top 10 for npm](https://github.com/OWASP/threat-model-cookbook) and
the MITRE ATT&CK Software Supply Chain Compromise (T1195) sub-techniques.

| Class | Datadog label | Real-world frequency¹ | Severity |
|---|---|---|---|
| `CREDENTIAL_EXFIL`        | `secrets-exfiltration`         | ~31% | critical |
| `LIFECYCLE_HOOK_ABUSE`    | `lifecycle-hook-abuse`         | ~17% | high     |
| `CODE_EXECUTION`          | `code-execution`               | ~14% | critical |
| `NETWORK_EXFIL`           | `c2-and-exfil`                 | ~11% | high     |
| `WALLET_DRAINER`          | `cryptocurrency-theft`         |  ~8% | critical |
| `BUILD_PLUGIN_EXFIL`      | `build-time-exfil`             |  ~5% | high     |
| `DATA_DESTRUCTION`        | `wiper`                        |  ~3% | critical |
| `DNS_TUNNEL`              | `covert-channel-dns`           |  ~2% | high     |
| `ANTI_ANALYSIS`           | `evasion-techniques`           |  ~6% | varies   |
| `OTHER`                   | (uncategorized)                |  ~3% | varies   |

¹ Approximate proportions inferred from a count of category tags in the
public Datadog dataset (Q1 2026 snapshot). They are reported here only to
weight aggregate recall figures (§9) — they are not used to gate
inclusion of attack classes.

For each class, a benchmark run includes ≥3 mutator variants — different
implementation styles of the same class. For example, `CREDENTIAL_EXFIL`
includes:

- `env-direct`: synchronous HTTPS POST of `process.env` at module load
- `env-deferred`: same payload behind `setTimeout`
- `env-dns-channel`: env vars base64-encoded into DNS lookups
- `ssh-key-read`: `fs.readFileSync('~/.ssh/id_rsa')` then exfil
- `aws-creds-read`: read `~/.aws/credentials` then exfil
- `npmrc-token-read`: read `~/.npmrc` for `_authToken`

Variants exist because a tool that detects only the trivial direct-POST
pattern but misses the DNS-channel variant has not "solved" credential
exfiltration; it has memorised one signature.


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

- **Temporal retroactive testing.** Replaying past npm malware events
  through the auditor and checking detection latency vs. public disclosure
  date is informative but requires historical access to malicious package
  versions which are typically unpublished from the registry. Planned
  for v2 using the Datadog corpus.
- **Comparative testing of every auditor in the market.** v1 ships
  comparison wrappers for `npm audit` and Snyk only. Adding Socket,
  Phylum, OSSF Scorecard, and others is mechanical work that is queued
  for subsequent dataset versions.
- **Adversarial AI red-teaming.** The mutators in §3 are *known* attack
  patterns. Generating *novel* attacks adversarially against the auditor
  (e.g. via genetic algorithms over a mutator search space) is research
  out of scope for an evaluation benchmark.


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


## 14. Changelog

- **v1.0** (2026-04-26): initial methodology; tier-1 seed catalogue, 5
  base mutators across 3 classes, negative controls, NpmGuard runner,
  Wilson-CI aggregation, frontend dashboard.
- _(planned)_ **v1.1**: 5 additional mutators (NETWORK_EXFIL,
  WALLET_DRAINER, BUILD_PLUGIN_EXFIL, DATA_DESTRUCTION, DNS_TUNNEL).
- _(planned)_ **v1.2**: adversarial mutators (sandbox-detect, time-bomb,
  geo-gate, anti-AI prompt injection).
- _(planned)_ **v2.0**: temporal retroactive testing on Datadog corpus,
  comparative wrappers for Socket/Phylum/Scorecard.
