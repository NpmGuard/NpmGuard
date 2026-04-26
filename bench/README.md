# NpmGuard benchmark

Security mutation-testing benchmark for the NpmGuard npm-supply-chain auditor.
The full methodology is in [METHODOLOGY.md](./METHODOLOGY.md). This README is
a quick operator's guide.

## Layout

```
bench/
├── METHODOLOGY.md          # Citable description of how the bench works
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

## Workflow

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

The above three commands form Phase 1 of the bench pipeline. Phases 2–6
(mutator framework, runner, analyzer, frontend, comparative wrappers) are
tracked in the project task list.

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
