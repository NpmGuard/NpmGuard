"""``/bench/*`` — read-only surfaces over stored runs (§5.3, F-G6).

**There is no HTTP write surface, and that is a security property rather than a
simplification.** Runs are produced only by ``npmguard-ops bench run``, which
drives the corpus through the ordinary admission path
(`BenchRunSchema`'s "There is NO HTTP write surface" note in `shared/src/bench.ts`
— cited by SYMBOL, because a line number into a hand-edited file goes stale the
first time that file is touched, and a stale pointer is worse than none).
No bench route may enqueue work, so a bench run can
never bypass the capacity owner and there is no auth story to get wrong.

Every payload here is a projection over stored observations. Nothing is read from
a stored judgement, because none exists.
"""

from __future__ import annotations

from typing import Any

import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..contract import models as contract
from .corpus import load_corpora
from .fidelity import PREDICATE_VERSION
from .read import BenchCorpusDrift, BenchRunNotFound, LoadedRun, load_run, load_runs
from .store import BenchRunStore

log = structlog.get_logger("npmguard.bench.routes")

router = APIRouter()


def _store(request: Request) -> BenchRunStore:
    runtime = request.app.state.runtime
    return BenchRunStore(sessions=runtime.sessionmaker, stream=runtime.stream)


@router.get("/bench/corpora")
async def bench_corpora() -> contract.BenchCorporaResponse:
    """The pinned corpora + entry counts, read from the committed manifests."""
    return contract.BenchCorporaResponse(corpora=[c.as_wire() for c in load_corpora()])


@router.get("/bench/runs")
async def bench_runs(request: Request) -> contract.BenchRunsResponse:
    """Run summaries, newest first. Replaces ``GET /bench/results``.

    Carries descriptors + the set rollup and no rates — exactly what the authored
    contract declares. ``/bench/runs/{id}/metrics`` is where the derived numbers
    live until the contract gains a metrics shape (see that route).
    """
    runs = await load_runs(_store(request))
    return contract.BenchRunsResponse(runs=[run.as_run_wire() for run in runs])


@router.get("/bench/runs/{run_id}")
async def bench_run_detail(run_id: int, request: Request) -> Any:
    try:
        run = await load_run(_store(request), run_id)
    except BenchRunNotFound:
        return JSONResponse({"error": f"No bench run {run_id}"}, status_code=404)
    except BenchCorpusDrift as exc:
        # 409, not 200-with-a-caveat: the run cannot be scored against a corpus
        # that changed under it, and a page that renders anyway would publish a
        # comparison between two corpora as one number.
        return JSONResponse({"error": str(exc), "corpusDrift": True}, status_code=409)
    return contract.BenchRunDetailResponse(
        corpus=run.corpus.as_wire(), run=run.as_run_wire(), rows=run.as_row_wires()
    )


@router.get("/bench/runs/{run_id}/rows")
async def bench_run_rows(run_id: int, request: Request) -> Any:
    """The drill-down. The ``?outcome=`` filter §5.3 sketches is deliberately absent:
    the wire carries observations and the reader filters, so adding it later adds a
    query param rather than a stored field."""
    try:
        run = await load_run(_store(request), run_id)
    except BenchRunNotFound:
        return JSONResponse({"error": f"No bench run {run_id}"}, status_code=404)
    except BenchCorpusDrift as exc:
        return JSONResponse({"error": str(exc), "corpusDrift": True}, status_code=409)
    return contract.BenchRunRowsResponse(runId=run_id, rows=run.as_row_wires())


def metrics_payload(run: LoadedRun) -> contract.BenchRunMetrics:
    """G23's payload: rates with CIs, latency percentiles, and a dollar cost.

    A GENERATED MODEL, no longer hand-shaped. Phase 0 authored
    ``BenchRunDetailResponse`` as ``{corpus, run, rows}`` and omitted every outcome
    value and rate "because the scoring rule itself is UNRESOLVED (O-2)"; O-2 is
    answered (D-6) and ``BenchRunMetricsSchema`` now declares this shape. The
    contract is left as a SEPARATE payload rather than folded into the detail
    response, and `shared/src/bench.ts` argues why.

    Constructing the contract model here rather than returning a dict is what makes
    the rate invariant the PRODUCER's problem: ``BenchRate`` is
    ``BenchMeasuredRate | BenchEmptyRate``, so a rate with ``n == 0`` and a non-null
    ``point`` fails to validate in this process, before it can reach a page that
    would render an empty corpus as 0%.

    Every field is derived at read time. Rates render as ``{k, n, point, lower,
    upper}`` and never as a bare ``p``: §5.4 requires the denominator to travel with
    the rate, and the headline is the Wilson LOWER BOUND.
    """
    m = run.metrics
    return contract.BenchRunMetrics.model_validate(
        {
            "runId": run.run_id,
            # B-13: these three are part of the MEASUREMENT, not metadata about it.
            # Two runs may not be pooled across an engineSha boundary (the projector
            # refuses to) nor across a corpus boundary, and this payload is meant to
            # travel alone — so it names all three itself.
            "engineSha": m.engine_sha,
            "datasetVersion": run.corpus.dataset_version,
            "manifestSha": run.corpus.manifest_sha,
            "observedModels": [{"role": role, "model": model} for role, model in run.models],
            "runsPerEntry": m.runs_per_entry,
            "stabilityMeasured": m.stability_measured,
            "publishable": m.publishable,
            "detection": {
                "reliable": m.detection_reliable.as_dict(),
                "optimistic": m.detection_optimistic.as_dict(),
            },
            "missRate": m.miss_rate.as_dict(),
            "abstentionRate": m.abstention_rate.as_dict(),
            "neverCaughtMixed": m.never_caught_mixed,
            "specificity": m.specificity.as_dict(),
            "falseAlarmRate": m.false_alarm_rate.as_dict(),
            # §4.4: detection without the dealbreaker share is uninterpretable — a
            # corpus rich in shell-pipe install scripts scores well at almost no cost.
            "proofShare": m.proof_share.as_dict(),
            "dealbreakerShare": m.dealbreaker_share.as_dict(),
            # §4.5: a run whose VOID share exceeds 5% is not a result. Reported with
            # causes so a reader can re-bucket a boundary call themselves.
            "attempted": m.attempted,
            "voidCount": m.void_count,
            "voidShare": m.void_share,
            "voidCauses": m.void_causes,
            "unobservedEntries": m.unobserved,
            "unanimity": m.unanimity.as_dict(),
            "flips": list(m.flips),
            "latencyMs": {"p50": m.latency_p50, "p95": m.latency_p95, "p99": m.latency_p99},
            "tokensPrompt": m.tokens_prompt,
            "tokensCompletion": m.tokens_completion,
            "tokenCostUsd": m.token_cost_usd,
            # §3.4/B-12: a detection rate published without its evidentiary-coverage
            # counts is a rate with an unquantified leak. Null — never a zeroed
            # record — while the artifact tier is unreachable for a run (see
            # fidelity.find_artifacts).
            "coverage": None,
            "coveragePredicate": PREDICATE_VERSION,
            "ledger": [
                {
                    "fixtureName": result.entry.fixture_name,
                    "packageName": result.entry.package_name,
                    "version": result.entry.version,
                    "category": result.entry.category,
                    "discoveryDate": result.entry.discovery_date,
                    "expectedVerdict": result.entry.expected_verdict,
                    "outcomes": [str(outcome) for outcome in result.outcomes],
                    "bucket": str(result.bucket),
                    "auditIds": list(result.audit_ids),
                }
                # F-G3 / §9: the per-entry ledger IS the primary object, sorted so the
                # failures are above the fold by construction rather than by editorial
                # choice.
                for result in sorted(run.metrics.results, key=_ledger_rank)
            ],
        }
    )


_LEDGER_ORDER = (
    "MISSED_ALWAYS",
    "NEVER_CAUGHT_MIXED",
    "FALSE_ALARM_ALWAYS",
    "MIXED",
    "CAUGHT_SOMETIMES",
    "CLEARED_SOMETIMES",
    "ABSTAINED_ALWAYS",
    "UNOBSERVED",
    "CAUGHT_ALWAYS",
    "CLEARED_ALWAYS",
)


def _ledger_rank(result: Any) -> tuple[int, str]:
    bucket = str(result.bucket)
    rank = _LEDGER_ORDER.index(bucket) if bucket in _LEDGER_ORDER else len(_LEDGER_ORDER)
    return (rank, result.entry.fixture_name)


@router.get("/bench/runs/{run_id}/metrics")
async def bench_run_metrics(run_id: int, request: Request) -> Any:
    try:
        run = await load_run(_store(request), run_id)
    except BenchRunNotFound:
        return JSONResponse({"error": f"No bench run {run_id}"}, status_code=404)
    except BenchCorpusDrift as exc:
        return JSONResponse({"error": str(exc), "corpusDrift": True}, status_code=409)
    return metrics_payload(run)


__all__ = ["metrics_payload", "router"]
