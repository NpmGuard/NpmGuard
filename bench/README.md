# NpmGuard benchmark

Methodology: [METHODOLOGY-V2-DRAFT.md](./METHODOLOGY-V2-DRAFT.md). Read it before
reading a number produced here — in particular §3.2.1 (what a `SAFE` verdict
actually guarantees), §4.2 (the outcome taxonomy) and §5.2 (why `n` is *entries*,
never entries × runs).

## Where the two halves live

**Measurement is Python, in the engine.** `engine/npmguard/bench/` holds the
corpus loader, the derived projector, the render-fidelity recordables, the ops
runner and the read-only `/bench/*` routes. It is there because a bench audit is
an ordinary audit: same admission path, same queue, same worker pool (F-G1), and
the observations it reads are `audit_sessions.report` rows keyed by `audit_id`.

**This directory is corpus material.** Selection and fixture materialisation only
— nothing here scores anything.

```
bench/
├── METHODOLOGY-V2-DRAFT.md  # the citable methodology
├── REAL_PACKAGES.md         # negative-control / watchlist operator notes
├── dataset/
│   ├── manifest.full.json   # the pinned corpus: 20 Datadog entries, v2 shape
│   └── datadog/corpus.json  # the 50-sample selection this manifest is cut from
└── src/
    ├── datadog/             # select + fetch the Datadog samples into fixtures
    └── seeds/               # SRI-locked seed catalogue (mutation testing, deferred)
```

Deleted with v1, and why: `src/types.ts` (declared `ProofKind` and the
`expected.capabilities` / `expected.kind` corpus fields that methodology §11
retires), `src/runner/` (the runner + analyzer that scored on them),
`src/datadog/manifest.ts` (wrote those fields into the manifest),
`scripts/remote-bench.sh` (drove the deleted runner), and `METHODOLOGY.md` (v1.1,
superseded). Nothing that read a v1 field survives — §2.2 explains why both v1
scoring conjuncts were already vacuous on this exact corpus before the report
schema moved.

## The corpus manifest

One file per corpus, in `dataset/`, and its **bytes are its identity**: a run pins
`manifestSha = sha256(file)`, and a run whose corpus no longer hashes to that is
refused rather than rendered (`/bench/runs/{id}` answers 409). Corpora are
immutable once a run references one; a re-cut is a new `datasetVersion`.

```json
{
  "name": "datadog", "version": "0.2.0", "source": "datadog",
  "datasetVersion": "0.2.0-datadog", "generatedAt": "…",
  "entries": [{
    "fixtureName": "test-pkg-bench-dd-c-…-v5.0.3", "packageName": "…",
    "version": "5.0.3", "category": "datadog-compromised",
    "expectedVerdict": "DANGEROUS", "discoveryDate": "2025-09-16",
    "rationale": "…", "sourceId": "….zip"
  }]
}
```

Every key is a field of `BenchEntry` in the generated contract. An entry carrying
anything else fails to load — a manifest with a field no reader means is exactly
how v1 died. Corpus and entry ids are **derived** from `datasetVersion` /
`fixtureName`, so two processes reading the same committed file agree on every id
with no table between them.

`fixtureName` is the package name the engine is asked to audit: `resolve.py`
short-circuits any `test-pkg-*` name to `sandbox/test-fixtures/<name>`.

## Corpus workflow

```bash
npm run -w @npmguard/bench datadog:select   # sample the dataset -> dataset/datadog/corpus.json
npm run -w @npmguard/bench datadog:fetch    # materialise fixtures into sandbox/test-fixtures/
```

`datadog:fetch` writes **live malware** into `sandbox/test-fixtures/test-pkg-bench-dd-*`.
Never `npm install` it, never execute it outside the Docker sandbox, never commit
it (F-G7). `sandbox/` is deliberately not an npm workspace so a fixture install
cannot reach the repo root.

There is no longer a TypeScript step that turns `corpus.json` into a manifest; the
committed `manifest.full.json` is already the v2 shape, and a regenerator belongs
with the corpus expansion B-8 asks for (50 malware + 75 negative controls at N=2).

## Running a benchmark

```bash
cd engine && uv run python -m npmguard.bench.runner --corpus 0.2.0-datadog --runs 2
```

It refuses to start on a dirty working tree (`engineSha` would not describe the
engine), under `NPMGUARD_MOCK_LLM` (no model, no tokens, no cost), or without a
resolvable sandbox image digest. It keeps one audit in flight by default and waits
out a full queue rather than displacing real work.

Then:

| Route | What it gives you |
|---|---|
| `GET /bench/corpora` | the pinned corpora + entry counts |
| `GET /bench/runs` | run summaries, newest first |
| `GET /bench/runs/{id}` | corpus + run + every per-entry observation |
| `GET /bench/runs/{id}/rows` | the same rows, on their own |
| `GET /bench/runs/{id}/metrics` | rates with Wilson CIs, latency p50/p95/p99, dollar cost, and the per-entry ledger sorted failures-first |

Ingestion is never an HTTP write. No `/bench/*` route can enqueue an audit, so a
bench run cannot bypass the capacity owner.

## Reproducibility

A run is described by `(datasetVersion + manifestSha, engineSha, observed models,
sandboxImageDigest)`. The model identifier is **observed**, not declared: roles
split across two configured models and each carries a fallback tail, so what
matters is the `(role, actual_model)` pairs the run's own LLM ledger recorded.

Observations from two different `engineSha`s are **not pooled** — the projector
raises instead. Three landed commits changed what the engine can *see*, so a
pre-fix miss is evidence about a renderer, not about detection (B-13, §3.4.3).
