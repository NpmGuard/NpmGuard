# CLASS MAP — bench.routes: read-only surfaces over stored runs (§5.3, G23)
# (seam: the router mounted on a bare FastAPI app with a stub runtime carrying the
#  real sessionmaker + StreamService over a throwaway sqlite. Mounted directly
#  rather than through `create_app` so a bench payload assertion cannot fail for a
#  reason that lives in the panel's lifespan; the real registration — on both ""
#  and "/api" — landed in api.py and is covered by test_api.py.)
#
#   C1  GET /bench/corpora is the contract's BenchCorporaResponse over the
#       committed manifests
#   C2  GET /bench/runs is the contract's BenchRunsResponse, newest first, and
#       carries NO rates — exactly what the authored contract declares
#   C3  GET /bench/runs/{id} is the contract's BenchRunDetailResponse
#   C4  GET /bench/runs/{id}/rows is the contract's BenchRunRowsResponse
#   C5  an unknown run is 404
#   C6  a drifted corpus is 409 with corpusDrift — never a rendered number
#   C7  GET /bench/runs/{id}/metrics — G23: every rate carries (k, n, point,
#       lower, upper), latency p50/p95/p99, and a dollar cost that is null rather
#       than 0 when unknown
#   C8  the ledger is sorted FAILURES FIRST (F-G3: misses as prominent as hits,
#       by construction rather than by editorial choice)
#   C9  a tile can never be rendered from a bare p: no rate in the payload omits
#       its denominator
#   C10 NO route can enqueue work — the router declares only GETs, which is what
#       makes "a bench run cannot bypass the capacity owner" structural
#   C11 the coverage counts are present and NULL (never 0) while the artifact tier
#       is unreachable, with the predicate version named
#   C12 /metrics is the contract's BenchRunMetrics — key-set EQUALITY both ways, and
#       the three pooling identifiers (engineSha, datasetVersion, manifestSha) travel
#       inside the payload because it is meant to be read alone
#   C13 an ALL-VOID run: every denominator is 0, so not one rate carries a point —
#       "no corpus", never "0%" (N-14) — and the run is not publishable

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard.bench import corpus as corpus_module
from npmguard.bench import routes as bench_routes
from npmguard.bench.store import Attempt, BenchRunStore, RunDescriptor
from npmguard.contract import models as contract
from npmguard.panel import tables
from npmguard.persistence import audit_sessions

_ = tables

CORPUS = {
    "name": "routes",
    "version": "1.0",
    "source": "datadog",
    "datasetVersion": "1.0-routes",
    "generatedAt": "2026-07-25T00:00:00Z",
    "entries": [
        {
            "fixtureName": "test-pkg-bench-caught",
            "packageName": "caught",
            "version": "1.0.0",
            "category": "datadog-compromised",
            "expectedVerdict": "DANGEROUS",
            "discoveryDate": "2025-09-16",
            "rationale": None,
            "sourceId": None,
        },
        {
            "fixtureName": "test-pkg-bench-missed",
            "packageName": "missed",
            "version": "2.0.0",
            "category": "datadog-malicious-intent",
            "expectedVerdict": "DANGEROUS",
            "discoveryDate": "2024-12-23",
            "rationale": None,
            "sourceId": None,
        },
        {
            "fixtureName": "test-pkg-bench-clean",
            "packageName": "chalk",
            "version": "5.6.2",
            "category": "negative-control",
            "expectedVerdict": "SAFE",
            "discoveryDate": None,
            "rationale": None,
            "sourceId": None,
        },
    ],
}


def _report(verdict: str, confirmed: int = 0, duration: int = 100) -> dict:
    return {
        "schemaVersion": 2,
        "verdict": verdict,
        "rationale": "",
        "counts": {
            "total": max(confirmed, 1),
            "open": 0,
            "inProgress": 0,
            "confirmed": confirmed,
            "refuted": 0,
            "deferred": 0,
        },
        "confirmedHypIds": [],
        "hypotheses": [],
        "fileSummaries": [],
        "dealbreaker": None,
        "trace": [{"phase": "resolve", "durationMs": duration, "input": {}, "output": {}}],
    }


@dataclass
class _Runtime:
    sessionmaker: Any
    stream: Any


@pytest.fixture
async def client(tmp_path: Path, monkeypatch):
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    (dataset / "routes-1.0.json").write_text(json.dumps(CORPUS), encoding="utf-8")
    monkeypatch.setattr(corpus_module, "DATASET_DIR", dataset)

    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'routes.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    stream = StreamService(factory, PollingNotifier())
    store = BenchRunStore(sessions=factory, stream=stream)

    corpus = corpus_module.load_manifest(dataset / "routes-1.0.json")
    run_id = await store.create(
        RunDescriptor(corpus.dataset_version, corpus.manifest_sha, "cafe1234", "sha256:img", 2),
        corpus.id,
    )
    plan = (
        ("test-pkg-bench-caught", 0, _report("DANGEROUS", 1, 100)),
        ("test-pkg-bench-caught", 1, _report("DANGEROUS", 2, 300)),
        ("test-pkg-bench-missed", 0, _report("SAFE", 0, 200)),
        ("test-pkg-bench-missed", 1, _report("SAFE", 0, 400)),
        ("test-pkg-bench-clean", 0, _report("SAFE", 0, 50)),
        ("test-pkg-bench-clean", 1, _report("SAFE", 0, 60)),
    )
    for fixture, index, report in plan:
        audit_id = f"{fixture}-{index}"
        now = now_iso()
        async with factory() as session, session.begin():
            await session.execute(
                audit_sessions.insert().values(
                    audit_id=audit_id, package_name=fixture, requested_version=None,
                    status="done", report=report, error=None, created_at=now, updated_at=now,
                )
            )
        await store.record(run_id, Attempt(fixture, index, audit_id, None, None))
    await store.finish(run_id)

    app = FastAPI()
    app.include_router(bench_routes.router)
    app.state.runtime = _Runtime(sessionmaker=factory, stream=stream)
    with TestClient(app) as test_client:
        yield test_client, run_id, corpus
    await engine.dispose()


def test_corpora_is_the_contract_shape(client) -> None:
    """C1."""
    test_client, _, corpus = client
    payload = test_client.get("/bench/corpora").json()
    parsed = contract.BenchCorporaResponse.model_validate(payload)
    assert [c.datasetVersion for c in parsed.corpora] == ["1.0-routes"]
    assert parsed.corpora[0].manifestSha == corpus.manifest_sha
    assert parsed.corpora[0].entryCount == 3


def test_runs_carries_descriptors_and_no_rates(client) -> None:
    """C2: a run summary is its descriptors plus its set rollup. The rates live in
    /metrics and are NOT inlined here — a list route that carried them would publish
    scores for runs the reader never opened, including unpublishable ones."""
    test_client, run_id, corpus = client
    payload = test_client.get("/bench/runs").json()
    parsed = contract.BenchRunsResponse.model_validate(payload)
    assert len(parsed.runs) == 1
    run = parsed.runs[0]
    assert (run.id, run.corpusId, run.engineSha) == (run_id, corpus.id, "cafe1234")
    assert run.sandboxImageDigest == "sha256:img" and run.runsPerEntry == 2
    assert run.set.origin == "bench_run" and run.set.status == "done"
    # The set's rollup counts (name, version) PAIRS, so it does not sum to the six
    # observations — the contract warns about exactly this, and no rate is read off it.
    assert run.set.rollup.total == 3
    assert run.set.rollup.dangerous == 1 and run.set.rollup.safe == 2
    # No derived field leaked into the summary: the payload's keys are exactly the
    # contract's, so a reader cannot mistake a descriptor bundle for a scorecard.
    assert set(payload["runs"][0]) == set(contract.BenchRun.model_fields)
    # No LLM attempt was recorded, so there is no OBSERVED model. NULL, not "" and
    # never a configured model filled in to look complete: an empty string is the
    # same zero-value stand-in that tokenCostUsd refuses two lines up.
    assert run.observedModels == []
    assert run.modelId is None


def test_run_detail_is_the_contract_shape(client) -> None:
    """C3."""
    test_client, run_id, _ = client
    payload = test_client.get(f"/bench/runs/{run_id}").json()
    parsed = contract.BenchRunDetailResponse.model_validate(payload)
    assert len(parsed.rows) == 3
    assert [len(row.items) for row in parsed.rows] == [2, 2, 2]
    caught = next(r for r in parsed.rows if r.entry.fixtureName == "test-pkg-bench-caught")
    assert [item.verdict for item in caught.items] == ["DANGEROUS", "DANGEROUS"]
    assert [item.confirmedCount for item in caught.items] == [1, 2]
    assert len({item.auditId for item in caught.items}) == 2


def test_rows_is_the_contract_shape(client) -> None:
    """C4."""
    test_client, run_id, _ = client
    payload = test_client.get(f"/bench/runs/{run_id}/rows").json()
    parsed = contract.BenchRunRowsResponse.model_validate(payload)
    assert parsed.runId == run_id and len(parsed.rows) == 3


def test_unknown_run_is_404(client) -> None:
    """C5."""
    test_client, _, _ = client
    for path in ("/bench/runs/9999", "/bench/runs/9999/rows", "/bench/runs/9999/metrics"):
        assert test_client.get(path).status_code == 404


def test_a_drifted_corpus_is_409(client, tmp_path) -> None:
    """C6: never a rendered number. Comparing a run against an edited corpus would
    report two corpora as one."""
    test_client, run_id, _ = client
    edited = {**CORPUS, "entries": CORPUS["entries"][:1]}
    (tmp_path / "dataset" / "routes-1.0.json").write_text(json.dumps(edited), encoding="utf-8")
    response = test_client.get(f"/bench/runs/{run_id}")
    assert response.status_code == 409
    assert response.json()["corpusDrift"] is True
    # The list route omits it rather than rendering it wrong.
    assert test_client.get("/bench/runs").json()["runs"] == []


def test_metrics_carries_rates_with_intervals_latency_and_cost(client) -> None:
    """C7: G23's payload. 1 of 2 malware entries caught on every observation, the
    other missed on every one; 1 of 1 control cleared."""
    test_client, run_id, _ = client
    metrics = test_client.get(f"/bench/runs/{run_id}/metrics").json()
    assert metrics["engineSha"] == "cafe1234"
    reliable = metrics["detection"]["reliable"]
    assert (reliable["k"], reliable["n"]) == (1, 2)
    assert round(reliable["point"], 3) == 0.5
    assert 0 < reliable["lower"] < reliable["point"] < reliable["upper"] <= 1
    assert (metrics["missRate"]["k"], metrics["missRate"]["n"]) == (1, 2)
    assert (metrics["specificity"]["k"], metrics["specificity"]["n"]) == (1, 1)
    # Both catches were PROVED (a confirmed hypothesis), so the dealbreaker share
    # is 0 of 2 — and the two shares sum to 1 over caught observations.
    assert (metrics["proofShare"]["k"], metrics["proofShare"]["n"]) == (2, 2)
    assert (metrics["dealbreakerShare"]["k"], metrics["dealbreakerShare"]["n"]) == (0, 2)
    assert metrics["proofShare"]["point"] + metrics["dealbreakerShare"]["point"] == 1.0
    assert metrics["latencyMs"] == {"p50": 100, "p95": 400, "p99": 400}
    # Null, not 0: no ledger row exists, so the run cannot account for its spend.
    assert metrics["tokenCostUsd"] is None
    assert metrics["voidCount"] == 0 and metrics["publishable"] is True
    assert metrics["stabilityMeasured"] is True and metrics["runsPerEntry"] == 2
    assert metrics["flips"] == []


def test_the_ledger_puts_failures_above_the_fold(client) -> None:
    """C8: F-G3 as a sort order rather than a sentiment. MISSED_ALWAYS first,
    CAUGHT_ALWAYS last, every entry always present including the ones that worked."""
    test_client, run_id, _ = client
    ledger = test_client.get(f"/bench/runs/{run_id}/metrics").json()["ledger"]
    assert [row["bucket"] for row in ledger] == [
        "MISSED_ALWAYS",
        "CAUGHT_ALWAYS",
        "CLEARED_ALWAYS",
    ]
    assert ledger[0]["fixtureName"] == "test-pkg-bench-missed"
    assert ledger[0]["outcomes"] == ["MISSED", "MISSED"]
    # Each row links back to the audits it was derived from, so a reader can check
    # the timelines for themselves — which, per §3.2.1, the verdict alone cannot
    # tell them.
    assert ledger[0]["auditIds"] == ["test-pkg-bench-missed-0", "test-pkg-bench-missed-1"]


def test_no_rate_travels_without_its_denominator(client) -> None:
    """C9: §5.4. A tile component takes (k, n) and never a pre-computed p, so a
    payload that omitted n could not be rendered honestly."""
    test_client, run_id, _ = client
    metrics = test_client.get(f"/bench/runs/{run_id}/metrics").json()
    rates = [
        metrics["detection"]["reliable"],
        metrics["detection"]["optimistic"],
        metrics["missRate"],
        metrics["abstentionRate"],
        metrics["specificity"],
        metrics["falseAlarmRate"],
        metrics["proofShare"],
        metrics["dealbreakerShare"],
        metrics["unanimity"],
    ]
    for rate in rates:
        assert set(rate) == {"k", "n", "point", "lower", "upper"}


def test_no_bench_route_can_enqueue_work(client) -> None:
    """C10: ingestion is not an HTTP write. Structural, not a policy — the router
    declares GETs only, so there is no auth story to get wrong and no way for a
    bench run to bypass the capacity owner."""
    # `routes` is typed as BaseRoute; every bench route is an APIRoute, which is
    # what carries `methods` — and what this asserts about.
    methods = {
        method
        for route in bench_routes.router.routes
        if isinstance(route, APIRoute)
        for method in route.methods or ()
    }
    assert methods == {"GET"}
    test_client, run_id, _ = client
    assert test_client.post("/bench/runs").status_code == 405


def test_coverage_counts_are_null_and_named(client) -> None:
    """C11: B-12 says a detection rate published without its evidentiary-coverage
    counts is a rate with an unquantified leak. The artifact tier is not joinable to
    an audit_id today (ArtifactStore is rooted at AuditLog.run_dir, keyed by
    timestamp + package), so the field is NULL rather than 0 — and the predicate
    version is published beside it, because an unpinned fidelity metric is not
    reproducible even between two careful readings of one static corpus."""
    test_client, run_id, _ = client
    metrics = test_client.get(f"/bench/runs/{run_id}/metrics").json()
    assert metrics["coverage"] is None
    assert metrics["coveragePredicate"] == "bench-fidelity-1"


def test_metrics_is_the_contract_shape(client) -> None:
    """C12: G23's payload is a DECLARED shape now, not a hand-shaped dict.

    Asserted as key-set EQUALITY against the generated model in both directions: a
    metrics payload with an extra key would be a wire field the contract cannot
    describe (the `details` defect, in a new place), and a missing one would be a tile
    the page cannot draw. The route builds `contract.BenchRunMetrics` itself, so the
    rate invariant fires in the ENGINE — this asserts the wire agrees.
    """
    test_client, run_id, corpus = client
    payload = test_client.get(f"/bench/runs/{run_id}/metrics").json()
    assert set(payload) == set(contract.BenchRunMetrics.model_fields)
    parsed = contract.BenchRunMetrics.model_validate(payload)
    assert parsed.runId == run_id
    # The pooling identifiers travel INSIDE the payload, because it is meant to be
    # read alone: an engineSha this payload does not name is an engineSha a reader can
    # average across (B-13), and the corpus pair is here for the same reason.
    assert parsed.engineSha == "cafe1234"
    assert (parsed.datasetVersion, parsed.manifestSha) == (
        corpus.dataset_version,
        corpus.manifest_sha,
    )
    # No LLM attempt was recorded: an EMPTY observed list, never the configured model
    # filled in to look complete.
    assert parsed.observedModels == []
    assert set(payload["ledger"][0]) == set(contract.BenchLedgerRow.model_fields)


@pytest.fixture
async def all_void(client, tmp_path):
    """A second run over a second corpus in which every observation VOIDed —
    `NPMGUARD-0020`, sandbox infrastructure, which says nothing about the tool.

    Every entry is therefore UNOBSERVED, so every denominator in the projection is 0.
    This is the empty-corpus case reached through the REAL route rather than by
    hand-building a payload."""
    test_client, _, _ = client
    manifest = {
        **CORPUS,
        "name": "all-void",
        "version": "2.0",
        "datasetVersion": "2.0-all-void",
    }
    path = tmp_path / "dataset" / "all-void-2.0.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    corpus = corpus_module.load_manifest(path)
    runtime = test_client.app.state.runtime
    store = BenchRunStore(sessions=runtime.sessionmaker, stream=runtime.stream)
    run_id = await store.create(
        RunDescriptor(corpus.dataset_version, corpus.manifest_sha, "cafe1234", "sha256:img", 1),
        corpus.id,
    )
    for entry in corpus.entries:
        await store.record(
            run_id,
            Attempt(entry.fixture_name, 0, None, "Docker daemon not reachable", "NPMGUARD-0020"),
        )
    await store.finish(run_id)
    return test_client, run_id


def test_an_empty_denominator_renders_no_corpus_and_never_zero(all_void) -> None:
    """C13: N-14, end to end. Not one rate in this payload carries a point estimate,
    because not one of them has a denominator — and `0%` would be a claim about
    detection where the truth is "nothing was observed". The contract makes the wrong
    version unrepresentable: `n == 0` admits only the all-null member of `BenchRate`,
    so the engine could not emit a 0% here even if the projector regressed.

    The run is also NOT publishable: §4.5's gate refuses a run whose VOID share
    exceeds 5% of attempted observations, and this one is 100%. A page must render the
    exclusions INSTEAD of the rates (§9 rule 5), which is only possible because the
    payload carries the causes by their stable error code.
    """
    test_client, run_id = all_void
    metrics = contract.BenchRunMetrics.model_validate(
        test_client.get(f"/bench/runs/{run_id}/metrics").json()
    )
    rates = [
        metrics.detection.reliable,
        metrics.detection.optimistic,
        metrics.missRate,
        metrics.abstentionRate,
        metrics.specificity,
        metrics.falseAlarmRate,
        metrics.proofShare,
        metrics.dealbreakerShare,
        metrics.unanimity,
    ]
    for rate in rates:
        assert (rate.k, rate.n) == (0, 0)
        assert rate.point is None and rate.lower is None and rate.upper is None
    assert metrics.attempted == 3 and metrics.voidCount == 3
    assert metrics.voidShare == 1.0 and metrics.publishable is False
    assert metrics.voidCauses == {"NPMGUARD-0020": 3}
    assert metrics.unobservedEntries == 3
    # The ledger still names every entry: F-G3 does not stop applying because the run
    # failed, and a reader has to be able to see WHICH entries went unobserved.
    assert [row.bucket for row in metrics.ledger] == ["UNOBSERVED"] * 3
    assert all(row.outcomes == ["VOID"] for row in metrics.ledger)
    assert all(row.auditIds == [None] for row in metrics.ledger)
