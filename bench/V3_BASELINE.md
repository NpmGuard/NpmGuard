# NpmGuard Benchmark V3 Baseline

_Generated from Hetzner result files copied on 2026-06-30._

This file is the tracked, human-readable baseline. The full generated JSON and
Markdown reports live under `bench/results/` and are intentionally ignored by
Git.

## Inputs

- Datadog audit reports: `bench/results/audits/*.json`
- API aggregate: `bench/results/v3-datadog-143.json`
- SAFE smoke result:
  `bench/results/watchlist-smoke-clean-20260612T194126Z.json`
- Canonical manifest: `bench/dataset/manifest.v3.json`
- Source host: `root@91.99.207.103:/root/NpmGuard`

## Datadog Replay

| Metric | Value |
| --- | ---: |
| Total reports | 143 |
| DANGEROUS | 98 |
| SAFE misses | 26 |
| Null verdicts | 19 |
| Errors | 19 |
| Timeouts | 19 |
| Recall including failures | 68.5% |
| Recall excluding infra failures | 79.0% |

| Category | Total | DANGEROUS | SAFE | Null | Errors | Recall | Recall excl. infra |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `datadog-compromised` | 68 | 48 | 8 | 12 | 12 | 70.6% | 85.7% |
| `datadog-malicious-intent` | 75 | 50 | 18 | 7 | 7 | 66.7% | 73.5% |

## SAFE Smoke

| File | Rows | SAFE | DANGEROUS | Timeouts | Errors | Precision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `watchlist-smoke-clean-20260612T194126Z.json` | 25 | 25 | 0 | 0 | 0 | 100.0% |

## Interpretation

The benchmark now has a concrete V3 baseline:

- Datadog recall is promising but not yet publication-ready because 19 cases
  are infrastructure timeouts and 26 are true SAFE misses.
- The `datadog-compromised` slice is stronger than `datadog-malicious-intent`
  once timeouts are excluded.
- The current SAFE smoke gate is clean at 25/25, including the `zod`
  regression case.
- Hetzner now serves `v3-datadog-143.json` as the newest Benchmark page run via
  `/api/bench/results`.

## Next Actions

1. Investigate the 19 timeout rows separately from security misses.
2. Review the 26 SAFE misses to identify prompt/model gaps.
3. Run the full 165-package SAFE watchlist in capped Hetzner batches.
4. Start V3 mutators with `CREDENTIAL_EXFIL`, `LIFECYCLE_HOOK_ABUSE`, and
   `NETWORK_EXFIL`.
