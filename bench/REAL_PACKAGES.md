# Real package audit runs

This runbook tracks production-like audits against currently published npm
packages. It complements the mutation benchmark in `METHODOLOGY.md`.

## Watchlists

- `engine/config/watchlist-smoke.json`: 35 packages for quick coverage across
  popular frameworks, security-sensitive tooling, crypto dependencies, and
  historically interesting packages.
- `engine/config/watchlist-packages.json`: larger watchlist for 100+ package
  runs.

## Smoke run

Run against the engine directly to avoid public nginx rate limits:

```bash
cd engine
NPMGUARD_CRE_API_KEY="$NPMGUARD_CRE_API_KEY" \
uv run npmguard-ops audit-latest \
  --api http://127.0.0.1:8000 \
  --watchlist config/watchlist-smoke.json \
  --limit 5 \
  --out ../bench/results/watchlist-smoke.json
```

Use `--dry-run` first to count already-audited, missing, and failing packages
without spending LLM budget.

## Monitoring check

After a run, fail fast if the latest result contains timeouts, failed rows,
unexpected dangerous verdicts, or a p95 latency regression:

```bash
cd engine
uv run npmguard-ops bench-check \
  --results-dir ../bench/results \
  --min-rows 25 \
  --max-timeouts 0 \
  --max-failed 0 \
  --max-dangerous 0 \
  --max-p95-ms 600000
```

This command is intentionally CI/systemd friendly: it prints a compact summary
and exits non-zero when a threshold is breached.

## Larger run

```bash
cd engine
NPMGUARD_CRE_API_KEY="$NPMGUARD_CRE_API_KEY" \
uv run npmguard-ops audit-latest \
  --api http://127.0.0.1:8000 \
  --watchlist config/watchlist-packages.json \
  --limit 25 \
  --result-limit 25 \
  --out ../bench/results/watchlist-full-part-1.json
```

Increase `--limit` in batches so cost, latency, and failures stay visible.
Use `--result-limit` when a benchmark should stop after an exact number of
result rows, including already-audited packages and timeouts.

## Model comparison

Compare models by keeping the watchlist, engine commit, and sandbox config
constant. For each provider, restart the engine with the provider-specific LLM
environment, verify the configured provider, then run the same `audit-latest` command.

Recommended first matrix:

| Provider | Backend | Base URL | Model |
| --- | --- | --- | --- |
| Gemini | `google` or `openai_compatible` | provider default or OpenRouter | `gemini-2.5-flash` |
| MiniMax | `openai_compatible` | `https://api.minimax.io/v1` | `MiniMax-M3` |
| MiMo | `openai_compatible` | provider URL | provider model id |

Each result file should include the provider in its filename, for example
`watchlist-smoke-minimax-m3.json`.
