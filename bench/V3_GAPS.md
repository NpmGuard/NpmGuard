# NpmGuard Benchmark Gaps

_Updated from the Hetzner `v1.json` run completed on 2026-07-02._

The current public app result is a Datadog replay only: 143 known malicious
packages, 109 detected, 34 missed, 0 timeout/error. The timeout harness problem
from the earlier V3 run is fixed; the remaining issue is recall.

## v1 Result

| Group | Rows |
| --- | ---: |
| Expected DANGEROUS | 143 |
| Detected | 109 |
| Missed | 34 |
| Timeout/error | 0 |

## Missed-Row Diagnosis

The 34 missed rows split into two actionable buckets:

| Bucket | Rows | Meaning |
| --- | ---: | --- |
| Investigation produced useful findings | 18 | The agent saw malicious behavior, but graph correlation did not promote it into the final verdict. |
| No useful findings | 16 | The miss is upstream of correlation: triage/investigation prompt, package unpacking, or attack-class coverage. |
| CONFIRMED findings hidden by SAFE verdict | 5 | The strongest bug class: verified malicious evidence existed but did not affect final verdict. |

The correlation fix in `engine/src/orchestrator/correlate.ts` addresses the
first bucket by:

- preserving high-signal labels in composite capabilities such as
  `NETWORK, CREDENTIAL_THEFT`;
- refining broad `NETWORK` / `FILESYSTEM` labels from finding context when the
  text clearly describes malicious behavior;
- promoting broad findings only with dangerous context, not benchmark marker
  files or normal HTTP/filesystem usage.

Local simulation on the 34 v1 misses indicates this recovers 17 of 34 missed
rows, including all 5 rows with `CONFIRMED` findings. The remaining misses
should become the next prompt and mutator backlog.

## v1.1 Benchmark Shape

The next benchmark should be one mixed run:

| Group | Source | Expected |
| --- | --- | --- |
| 143 Datadog replay samples | `bench/dataset/manifest.v3.json` | `DANGEROUS` |
| 57 locked seed packages | `bench/src/seeds/catalog.ts` | `SAFE` |

`npm run -w @npmguard/bench manifest:v1.1` generates
`bench/dataset/manifest.v1.1.json` with dataset version
`0.4.0-v1.1-datadog-143-safe-57`, for 200 total rows.

## Next Run

Recommended Hetzner flow:

1. Deploy the correlation + benchmark UI/API changes.
2. Generate `manifest.v1.1.json` on the server.
3. Run a 1-entry canary with a SAFE package and a recovered missed package.
4. Launch the full v1.1 run with `--concurrency 1` first.
5. Try `--concurrency 2` only after the canary confirms the server queue and
   CRE polling stay healthy.
