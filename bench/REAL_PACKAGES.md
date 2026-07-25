# Watchlist runs against currently published packages

Audits of live npm packages, driven by `npmguard-ops`. Distinct from the
benchmark in two ways that matter: it audits whatever the registry currently
serves rather than a pinned corpus, and it stores result *files* rather than
database observations. So it cannot produce a reproducible rate — what it
produces is a false-positive canary and a latency signal against real traffic.

The pinned-corpus measurement is `METHODOLOGY-V2-DRAFT.md`; its negative-control
half draws its selection pool from the same watchlist
(`CORPUS-PLAN.md` §4, item 2).

## The watchlist

`engine/config/watchlist-packages.json` — 165 popular packages, presumed clean.
Use `--limit` for a smoke-sized slice rather than maintaining a second file.

## Run

Against the engine directly, to avoid public nginx rate limits:

```bash
cd engine
NPMGUARD_CRE_API_KEY="$NPMGUARD_CRE_API_KEY" \
uv run npmguard-ops audit-latest \
  --api http://127.0.0.1:8000 \
  --limit 5 \
  --out ../data/watchlist/smoke.json
```

`--dry-run` first counts already-audited, missing, and failing packages without
spending LLM budget. Raise `--limit` in batches so cost, latency, and failures
stay visible; `--result-limit` stops after an exact number of result rows,
counting already-audited packages and timeouts.

## Gate

```bash
cd engine
uv run npmguard-ops watchlist-check \
  --results-dir ../data/watchlist \
  --min-rows 25 \
  --max-timeouts 0 \
  --max-failed 0 \
  --max-dangerous 0 \
  --max-p95-ms 600000
```

`--max-dangerous 0` is the substance: a DANGEROUS verdict on a popular,
presumed-clean package is a false alarm and should fail the run. The command
prints a compact summary and exits non-zero on any breach, so it drops into CI
or a systemd timer unchanged.

## Model comparison

Hold the watchlist, engine commit, and sandbox config constant; vary only the
LLM environment. Restart the engine per provider, verify the configured
provider, then run the same `audit-latest` command and name the provider in the
output file (`smoke-minimax-m3.json`).

A cheap tier has returned false-SAFE on textbook exfiltration, so a comparison
that reports only cost is misleading — report the verdict distribution beside
it.
