# NpmGuard benchmark

Benchmark suite for the NpmGuard npm supply-chain auditor. The current work is
V3: combine Datadog real-malware replay, SAFE real-package precision runs,
locked seed baselines, and synthetic/mutated attack classes into one
reproducible report.

The full methodology is in [METHODOLOGY.md](./METHODOLOGY.md). The V3 delivery
plan is in [V3_PLAN.md](./V3_PLAN.md). This README is the operator's guide.

## Layout

```
bench/
├── METHODOLOGY.md          # Citable description of how the bench works
├── V3_PLAN.md              # Concrete next objectives and done criteria
├── src/
│   ├── types.ts            # Cross-cutting types (Seed, Mutator, Manifest, …)
│   └── seeds/
│       ├── catalog.ts      # Curated list of 28 npm packages with locked SRI
│       ├── registry.ts     # Minimal npm registry client (metadata + tarball)
│       ├── lock.ts         # `npm run lock` — fills empty integrity fields
│       ├── fetch.ts        # `npm run fetch` — downloads + verifies + unpacks
│       └── verify-loads.ts # `npm run verify-loads` — `require()` each seed
└── dataset/                # gitignored — regenerable from catalog.ts
    ├── tarballs/           # cached *.tgz files
    └── seeds/              # unpacked package sources
```

## V3 layers

V3 reports each layer separately:

- **Datadog replay**: malicious npm samples from Datadog. Expected verdict is
  `DANGEROUS`; this measures recall.
- **SAFE real packages**: smoke and full watchlists under `engine/config/`.
  Expected verdict is `SAFE`; this measures precision and false positives.
- **Seed baselines**: the locked catalogue in `src/seeds/catalog.ts`. Expected
  verdict is `SAFE`; this gives stable pinned package forms.
- **Mutated packages**: deterministic malicious variants of seed packages.
  Expected verdict/capabilities/proof kind come from the mutator metadata.

Do not execute benchmark packages on a developer machine. Datadog replay and
mutated package runs are Hetzner-only.

## Seed workflow

1. **Adding a seed**: append an entry to `src/seeds/catalog.ts` with
   `integrity: ""`. Run `npm run -w @npmguard/bench lock` — the registry's
   published SHA-512 is fetched and written back into the file. Commit
   the diff.

2. **Fetching**: `npm run -w @npmguard/bench fetch` downloads each tarball,
   verifies its SRI against the lock, and unpacks into `dataset/seeds/`.
   Idempotent — re-running re-uses cached tarballs whose hashes still match.

3. **Verifying**: `npm run -w @npmguard/bench verify-loads` runs each
   seed through `node -e "require('./<seed>')"` to confirm it loads cleanly.
   Native-binding seeds are exempted (they're flagged as static-only in
   the catalogue and their runtime-evidence verifiability is reported as
   N/A, per METHODOLOGY.md §12).

The above three commands build the pinned SAFE seed baseline. Datadog replay
uses the separate `datadog:*` commands below.

## Datadog replay

Refresh the selected Datadog corpus and run it against the local engine on the
Hetzner host:

```bash
npm run -w @npmguard/bench datadog:select
npm run -w @npmguard/bench datadog:fetch
npm run -w @npmguard/bench datadog:manifest
npm run -w @npmguard/bench run -- \
  --api http://127.0.0.1:8000 \
  --runs 1
```

When this runs through the CRE fire-and-forget `/audit` path, the runner stops
after 3 consecutive polling timeouts by default. This prevents one upstream
engine/LLM failure from turning the remaining dataset into artificial
30-minute timeout rows. Override with `--max-consecutive-timeouts N`, or use
`0` to disable the guard for manual debugging.

From a developer machine, use the remote helper:

```bash
./bench/scripts/remote-bench.sh status
./bench/scripts/remote-bench.sh start --runs 1
./bench/scripts/remote-bench.sh watch
./bench/scripts/remote-bench.sh results
```

The helper defaults to `root@91.99.207.103`. Override with `BENCH_HOST` when
testing another machine.

## V3 summary

After pulling or generating results, first reconcile the per-fixture Datadog
reports into a canonical manifest:

```bash
npm run -w @npmguard/bench manifest:v3 -- \
  --audits-dir bench/results/audits \
  --out bench/dataset/manifest.v3.json
```

This reads existing JSON reports only; it does not run audits or execute
packages.

Then build the API-facing aggregate run used by the Benchmark page:

```bash
npm run -w @npmguard/bench aggregate:v3 -- \
  --audits-dir bench/results/audits \
  --out bench/results/v3-datadog-143.json
```

Copying `v3-datadog-143.json` into Hetzner's `/root/NpmGuard/bench/results/`
is enough for the existing `/api/bench/results` route and frontend Benchmark
page to pick it up. This does not require an engine restart.

Finally summarize the per-fixture Datadog reports and optional SAFE watchlist
result files:

```bash
npm run -w @npmguard/bench summarize:v3 -- \
  --audits-dir bench/results/audits \
  --watchlist bench/results/watchlist-smoke-clean-20260612T194126Z.json \
  --out-json bench/results/v3-summary.json \
  --out-md bench/results/v3-summary.md
```

The summary intentionally separates:

- Datadog recall including infra failures
- Datadog recall excluding infra failures
- recall by Datadog category
- SAFE precision / false positives
- timeouts and errors
- capabilities, verified capabilities, and proof kinds

## SAFE real packages

SAFE runs are tracked in [REAL_PACKAGES.md](./REAL_PACKAGES.md). The smoke list
has 35 packages; the full watchlist has 165 packages. `zod` is a named
regression case because it previously produced a false positive and must remain
SAFE.

## Reproducibility

A bench run is fully described by:
- the dataset version (semver-tagged in `catalog.ts`)
- the engine git SHA at audit time
- the LLM model identifier (e.g. `google/gemini-2.5-flash`)
- the sandbox docker image digest

All four are written into the result file by the runner so a re-run with
the same identifiers should produce statistically equivalent aggregates.
The Wilson 95% CI bounds in the analyzer's output are the appropriate
yardstick for "equivalent".
