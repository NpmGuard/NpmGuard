# NpmGuard Benchmark V3 Plan

_Status: proposed implementation plan, 2026-06-30_

V3 turns the existing Datadog replay work into a complete benchmark with
separate recall, precision, timeout, verification, and regression gates.

## Current State

Hetzner is the source of truth for the largest benchmark snapshot observed so
far:

- Host: `root@91.99.207.103`
- Repo: `/root/NpmGuard`
- Datadog fixtures: `sandbox/test-fixtures/test-pkg-bench-*`
- Per-fixture audit reports: `bench/results/audits/*.json`
- SAFE watchlist configs: `engine/config/watchlist-smoke.json` and
  `engine/config/watchlist-packages.json`

Observed on 2026-06-30:

| Layer | Count | Notes |
| --- | ---: | --- |
| Datadog fixtures | 143 | 68 `compromised_lib`, 75 `malicious_intent` |
| Datadog per-fixture reports | 143 | Stored under `bench/results/audits` |
| Datadog detected | 98 | `DANGEROUS` verdict |
| Datadog missed | 26 | `SAFE` verdict on malicious ground truth |
| Datadog timeouts | 19 | `null` verdict with timeout error |
| SAFE smoke watchlist | 35 | Quick false-positive coverage |
| SAFE full watchlist | 165 | Production-like precision suite |
| Latest clean SAFE smoke | 25/25 SAFE | `watchlist-smoke-clean-20260612T194126Z.json` |
| Canonical V3 manifest | 143 | `bench/dataset/manifest.v3.json` |

The legacy `bench/dataset/manifest.json` still tracks a smaller Datadog subset:
50 entries, split 25/25. V3 uses `bench/dataset/manifest.v3.json` as the
canonical 143-entry baseline built from the copied audit reports.

## Benchmark Layers

V3 reports every layer separately. A single blended score is easy to market but
hard to debug, so it is not the primary output.

1. **Datadog replay**
   - Real malicious npm packages from Datadog's curated dataset.
   - Ground truth: `DANGEROUS`.
   - Primary metric: recall.
   - Slices: `datadog-compromised`, `datadog-malicious-intent`, recent samples,
     timeout rate, and `TEST_CONFIRMED` verifiability.

2. **SAFE real packages**
   - Currently published, popular packages from the smoke and full watchlists.
   - Ground truth: `SAFE`.
   - Primary metric: precision / false-positive rate.
   - Regression cases: `zod` must remain SAFE, because it was a previous false
     positive.

3. **Seed baselines**
   - The 28 locked packages in `src/seeds/catalog.ts`.
   - Ground truth: `SAFE`.
   - Purpose: stable package forms with pinned SRI, independent of `latest`.

4. **Mutated / synthetic realistic packages**
   - Deterministic payloads inserted into real seed packages.
   - Ground truth: per-mutator expected verdict, capabilities, and proof kind.
   - Purpose: per-class coverage that Datadog cannot provide.

## Attack Classes

Use the existing classes from `src/types.ts` as the V3 taxonomy:

- `CREDENTIAL_EXFIL`
- `LIFECYCLE_HOOK_ABUSE`
- `CODE_EXECUTION`
- `NETWORK_EXFIL`
- `WALLET_DRAINER`
- `BUILD_PLUGIN_EXFIL`
- `DATA_DESTRUCTION`
- `DNS_TUNNEL`
- `ANTI_ANALYSIS`

Each mutator should have at least one `trivial`, one `obfuscated`, and one
`evasive` variant where the class supports it.

## Ground Truth Rules

Every benchmark entry must include:

- stable fixture name
- original package name and version
- source provenance (`datadog`, `safe-watchlist`, `seed`, `mutator`)
- expected verdict
- expected capabilities when known
- package tarball or zip source identifier
- dataset commit or SRI/integrity when available
- execution policy

Execution policy is deliberately strict:

- local developer machines: no benchmark package install or execution
- Hetzner only: audit runner and sandbox execution
- no real secrets in the sandbox
- fake env vars and fake home directory for exfil tests
- network egress controlled by the sandbox/engine
- timeout and cleanup after every run

## Metrics

V3 output should include:

- Datadog recall, including and excluding infra failures
- recall by Datadog class
- SAFE precision and false-positive list
- timeout rate
- median and p95 latency
- emitted capabilities
- verified capabilities
- proof kind distribution
- model id, engine SHA, sandbox image digest, dataset version

The headline should name its denominator. For example:

- "Datadog recall: 98/143 including timeouts"
- "Datadog recall: 98/124 excluding infra failures"
- "SAFE smoke precision: 25/25"

## Implementation Order

1. **Freeze the current 143 snapshot** — done for the 2026-06-30 baseline.
   - Pull or regenerate `bench/results/audits` from Hetzner.
   - Generate a canonical manifest for all 143 fixtures.
   - Store the Datadog dataset commit and selection rules next to it.

2. **Add V3 summarization** — done for the 2026-06-30 baseline.
   - Summarize `bench/results/audits/*.json`.
   - Summarize SAFE watchlist result files.
   - Emit machine-readable JSON and concise Markdown.

3. **Run the SAFE full watchlist**
   - Start with smoke, then run the 165-package list in capped batches.
   - Fail the gate on any unexpected `DANGEROUS`, timeout, or failed row.

4. **Build mutators**
   - Start with three high-value classes:
     `CREDENTIAL_EXFIL`, `LIFECYCLE_HOOK_ABUSE`, `NETWORK_EXFIL`.
   - Add baseline and innocuous-control entries before malicious mutations.
   - Expand to the remaining attack classes after the first gates are stable.

5. **Publish one V3 report**
   - Include Datadog replay, SAFE precision, seed baselines, and mutator scores.
   - Keep raw result files linkable for auditability.

## Done Criteria

V3 is complete when a fresh Hetzner run produces:

- one canonical manifest for all executed benchmark entries
- one JSON summary and one Markdown summary
- Datadog recall by category
- SAFE precision over the full watchlist
- timeout and failure counts separated from security misses
- at least three implemented attack classes with mutated packages
- documented engine SHA, model id, dataset version, and sandbox image digest
