# CLASS MAP — bench.store + bench.read: the two facts a run stores, and G24
# (seam: a REAL throwaway sqlite carrying the REAL tables — audit_sets,
#  audit_sessions, stream_events, llm_runs/llm_attempts. Nothing is mocked, because
#  the claim under test is about which store an observation comes out of, and a mock
#  would answer that question by construction.)
#
# G24 — "bench metrics re-derivable from stored audit_ids alone, reading
# audit_sessions.report not report_store". The trap this goal exists to name:
#   C1  an N-repeat entry yields N DISTINCT reports, read by audit_id. The
#       filesystem store keeps ONE slot per (name, version), so a projector reading
#       data/reports/ would collapse the N into whichever ran last and would look
#       like it worked
#   C2  a corpus-wide re-projection is byte-identical on a second read (a
#       projection, not a stateful accumulation)
#   C3  deleting data/reports/** entirely changes NOTHING — the discriminating
#       acceptance test §8.2 asks for. If it passes only with reports present, the
#       claim is false
#   C4  the store never reads report_store — checked statically over the package,
#       because "we read the right store" is a property of the code, not of a run
# The two stored facts:
#   C5  a run is an audit_sets row with origin='bench_run', origin_ref = the
#       DERIVED corpus id, billed_to NULL (nobody is billed)
#   C6  the descriptors round-trip through the durable log
#   C7  observations are append-only: (entry, runIndex) recorded twice raises,
#       because the log cannot express a unique constraint
#   C8  no audit_set_items rows are written — the pair-keyed item table cannot hold
#       N observations of one entry, and writing items would expose a live bench
#       set to the panel's progress machinery
#   C9  finish() sets finished_at, which is the ONE liveness fact; the wire's
#       status is derived from it
# Derived from audit_id, never stored:
#   C10 verdict / confirmedCount / dealbreaker / durationMs come off the report
#   C11 the error CODE comes from the durable audit_error frame, because
#       audit_sessions.error holds str(exc) — the message, not the code
#   C12 tokens and cost come from the LLM ledger by (context_kind, context_id)
#   C13 cost is None when any attempt's cost_usd is NULL — never a partial sum
#   C14 the observed (role, actual_model) pairs are the reproducibility identifier
#   C15 an attempt that never reached an audit carries auditId None + its error
# Corpus pinning:
#   C16 a corpus edited under a fixed datasetVersion is REFUSED, not compared
#   C17 a run whose manifest is gone is refused the same way

import json
from pathlib import Path

import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard.bench import corpus as corpus_module
from npmguard.bench.projector import EntryBucket, project
from npmguard.bench.read import BenchCorpusDrift, load_run, load_runs
from npmguard.bench.store import Attempt, BenchRunStore, RunDescriptor, run_channel
from npmguard.events import audit_channel
from npmguard.panel import tables
from npmguard.persistence import audit_sessions

_ = tables

CORPUS = {
    "name": "test",
    "version": "1.0",
    "source": "datadog",
    "datasetVersion": "1.0-test",
    "generatedAt": "2026-07-25T00:00:00Z",
    "entries": [
        {
            "fixtureName": "test-pkg-bench-mal",
            "packageName": "malicious",
            "version": "1.0.0",
            "category": "datadog-compromised",
            "expectedVerdict": "DANGEROUS",
            "discoveryDate": "2025-09-16",
            "rationale": None,
            "sourceId": None,
        },
        {
            "fixtureName": "test-pkg-bench-neg",
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


def _report(verdict: str, *, confirmed: int = 0, dealbreaker: str | None = None) -> dict:
    """A schemaVersion-2 report, only the fields the projector observes."""
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
        "confirmedHypIds": [f"hyp-{i:04d}" for i in range(confirmed)],
        "hypotheses": [],
        "fileSummaries": [],
        "dealbreaker": {"check": dealbreaker, "detail": "x"} if dealbreaker else None,
        "trace": [{"phase": "resolve", "durationMs": 40, "input": {}, "output": {}}],
    }


@pytest.fixture
def dataset_dir(tmp_path: Path) -> Path:
    root = tmp_path / "dataset"
    root.mkdir()
    (root / "test-1.0.json").write_text(json.dumps(CORPUS), encoding="utf-8")
    return root


@pytest.fixture
async def store(tmp_path: Path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'bench.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    yield BenchRunStore(sessions=factory, stream=StreamService(factory, PollingNotifier()))
    await engine.dispose()


async def _seed_audit(
    store: BenchRunStore,
    audit_id: str,
    package_name: str,
    *,
    report: dict | None = None,
    error: str | None = None,
    code: str | None = None,
    status: str = "done",
) -> None:
    """One finalized audit_sessions row + its terminal event, as the engine writes
    them: `finalize` sets the row and `stream.append` the frame, in ONE
    transaction."""
    now = now_iso()
    async with store.sessions() as session, session.begin():
        await session.execute(
            audit_sessions.insert().values(
                audit_id=audit_id,
                package_name=package_name,
                requested_version=None,
                status=status,
                report=report,
                error=error,
                created_at=now,
                updated_at=now,
            )
        )
        if code:
            await store.stream.append(
                audit_channel(audit_id),
                "audit_error",
                {"error": error, "code": code, "retryable": True},
                session=session,
            )


async def _run_with_two_repeats(store: BenchRunStore, dataset_dir: Path) -> int:
    """The N=2 shape: one malware entry audited twice with DIFFERENT outcomes, one
    control cleared twice. The malware entry is the G24 trap in miniature — both
    audits are of the SAME (name, version)."""
    corpus = corpus_module.load_manifest(dataset_dir / "test-1.0.json")
    run_id = await store.create(
        RunDescriptor(
            dataset_version=corpus.dataset_version,
            manifest_sha=corpus.manifest_sha,
            engine_sha="deadbeef",
            sandbox_image_digest="sha256:image",
            runs_per_entry=2,
        ),
        corpus.id,
    )
    await _seed_audit(store, "mal-0", "test-pkg-bench-mal", report=_report("DANGEROUS", confirmed=2))
    await _seed_audit(store, "mal-1", "test-pkg-bench-mal", report=_report("SAFE"))
    await _seed_audit(store, "neg-0", "test-pkg-bench-neg", report=_report("SAFE"))
    await _seed_audit(store, "neg-1", "test-pkg-bench-neg", report=_report("SAFE"))
    for index, audit_id in enumerate(("mal-0", "mal-1")):
        await store.record(run_id, Attempt("test-pkg-bench-mal", index, audit_id, None, None))
    for index, audit_id in enumerate(("neg-0", "neg-1")):
        await store.record(run_id, Attempt("test-pkg-bench-neg", index, audit_id, None, None))
    await store.finish(run_id)
    return run_id


# --------------------------------------------------------------------------
# G24
# --------------------------------------------------------------------------


async def test_an_n_repeat_entry_yields_n_distinct_reports(store, dataset_dir) -> None:
    """C1: THE G24 assert. Two audits of `test-pkg-bench-mal@1.0.0` — one
    DANGEROUS-with-confirmations, one SAFE. `data/reports/<pkg>/<version>.json` has
    exactly one slot for that pair, so a projector reading the filesystem would see
    ONE report and score the entry as unanimous. Reading `audit_sessions.report` by
    `audit_id` sees both, and the entry is correctly CAUGHT_SOMETIMES — the bucket
    that measures what a user experiences."""
    run_id = await _run_with_two_repeats(store, dataset_dir)
    run = await load_run(store, run_id, dataset_dir=dataset_dir)

    malware = next(items for entry, items in run.rows if entry.expected_verdict == "DANGEROUS")
    assert len({item.auditId for item in malware}) == 2, "an N-repeat entry must have N audit ids"
    assert [item.verdict for item in malware] == ["DANGEROUS", "SAFE"]
    assert [item.confirmedCount for item in malware] == [2, 0]
    caught = next(r for r in run.metrics.results if r.entry.expected_verdict == "DANGEROUS")
    assert caught.bucket is EntryBucket.CAUGHT_SOMETIMES
    assert run.metrics.flips == ("test-pkg-bench-mal",)


async def test_reprojection_is_identical(store, dataset_dir) -> None:
    """C2: a projection, not an accumulation. Loading the same run twice yields the
    same aggregates, so a scoring-rule change re-scores history rather than
    invalidating it."""
    run_id = await _run_with_two_repeats(store, dataset_dir)
    first = await load_run(store, run_id, dataset_dir=dataset_dir)
    second = await load_run(store, run_id, dataset_dir=dataset_dir)
    assert first.as_row_wires() == second.as_row_wires()
    assert first.metrics.detection_reliable.as_dict() == second.metrics.detection_reliable.as_dict()
    # And re-deriving straight from the stored audit_ids, outside the loader, lands
    # on the same numbers.
    again = project(first.descriptor.engine_sha, list(first.rows))
    assert again.detection_optimistic.as_dict() == first.metrics.detection_optimistic.as_dict()
    assert again.specificity.as_dict() == first.metrics.specificity.as_dict()


async def test_deleting_the_filesystem_report_store_changes_nothing(
    store, dataset_dir, tmp_path, monkeypatch
) -> None:
    """C3/C4: §8.2's discriminating acceptance test. Point the report store at an
    empty directory, delete it, and re-project: identical. If the aggregates only
    survive with `data/reports/**` present, G24 is false while appearing true."""
    run_id = await _run_with_two_repeats(store, dataset_dir)
    before = (await load_run(store, run_id, dataset_dir=dataset_dir)).metrics

    reports = tmp_path / "reports"
    reports.mkdir()
    (reports / "sentinel.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("NPMGUARD_DATA_DIR", str(tmp_path))
    for path in reports.iterdir():
        path.unlink()
    reports.rmdir()
    assert not reports.exists()

    after = (await load_run(store, run_id, dataset_dir=dataset_dir)).metrics
    assert after.detection_reliable.as_dict() == before.detection_reliable.as_dict()
    assert after.detection_optimistic.as_dict() == before.detection_optimistic.as_dict()
    assert after.specificity.as_dict() == before.specificity.as_dict()



# --------------------------------------------------------------------------
# The two stored facts
# --------------------------------------------------------------------------


def test_the_bench_domain_never_reaches_for_report_store() -> None:
    """C4: the other half of G24, checked statically. `report_store` appears in this
    package only inside prose explaining why it is NOT read — an executable line
    mentioning it would mean the projector can see the (name, version)-keyed store,
    which collapses an N-repeat entry to one report while looking correct."""
    source = Path(__file__).resolve().parents[1] / "npmguard" / "bench"
    for module in sorted(source.glob("*.py")):
        offending = [
            line
            for line in module.read_text(encoding="utf-8").splitlines()
            if "report_store" in line and not line.lstrip().startswith(("#", "*", '"'))
        ]
        assert not offending, f"{module.name} reaches for report_store: {offending}"


async def test_a_run_is_an_audit_set_with_the_bench_origin(store, dataset_dir) -> None:
    """C5: R-1's whole point — a bench run is not a fourth copy of "a set of
    (name, version) plus a rollup". `origin_ref` is the DERIVED corpus id, which is
    what lets a NOT NULL integer subject id exist with no corpus table."""
    run_id = await _run_with_two_repeats(store, dataset_dir)
    corpus = corpus_module.load_manifest(dataset_dir / "test-1.0.json")
    async with store.sessions() as session:
        row = (
            (
                await session.execute(
                    sa.select(tables.audit_sets).where(tables.audit_sets.c.id == run_id)
                )
            )
            .mappings()
            .one()
        )
    assert row["origin"] == "bench_run"
    assert row["origin_ref"] == corpus.id == corpus_module.corpus_id("1.0-test")
    assert row["billed_to"] is None
    assert row["trigger_kind"] == "manual"


async def test_descriptors_round_trip_through_the_durable_log(store, dataset_dir) -> None:
    """C6: the four identifiers F-G5 requires, stored once per run."""
    run_id = await _run_with_two_repeats(store, dataset_dir)
    descriptor, attempts = await store.load(run_id)
    assert descriptor.engine_sha == "deadbeef"
    assert descriptor.sandbox_image_digest == "sha256:image"
    assert descriptor.runs_per_entry == 2
    assert descriptor.dataset_version == "1.0-test"
    assert len(attempts) == 4
    assert run_channel(run_id) == f"bench_run_{run_id}"


async def test_recording_the_same_observation_twice_raises(store, dataset_dir) -> None:
    """C7: the log has no UPDATE and cannot express a unique constraint, so this is
    the check a primary key would have been. A duplicated observation
    double-counts one audit into a rate."""
    run_id = await _run_with_two_repeats(store, dataset_dir)
    await store.record(run_id, Attempt("test-pkg-bench-mal", 0, "mal-0", None, None))
    with pytest.raises(AssertionError, match="duplicate"):
        await store.load(run_id)


async def test_no_audit_set_items_are_written(store, dataset_dir) -> None:
    """C8: deliberate. `audit_set_items` is keyed (set_id, name, version) — one row
    per pair, no run index, no audit_id — so it cannot hold N observations of one
    entry. It is also how the panel's `refresh_touching` reaches a live set and
    recomputes its progress from `panel_jobs`, which a bench audit (admitted
    through the audit core, not the panel lane) never has: items would let a
    concurrent panel settle finalize a running bench set."""
    run_id = await _run_with_two_repeats(store, dataset_dir)
    async with store.sessions() as session:
        count = (
            await session.execute(
                sa.select(sa.func.count())
                .select_from(tables.audit_set_items)
                .where(tables.audit_set_items.c.set_id == run_id)
            )
        ).scalar_one()
    assert count == 0


async def test_finish_is_the_only_liveness_fact(store, dataset_dir) -> None:
    """C9: there is no stored status; the wire's `status` is "done" iff
    finished_at is set, so the two cannot disagree."""
    corpus = corpus_module.load_manifest(dataset_dir / "test-1.0.json")
    run_id = await store.create(
        RunDescriptor(corpus.dataset_version, corpus.manifest_sha, "sha", "img", 1), corpus.id
    )
    live = await load_run(store, run_id, dataset_dir=dataset_dir)
    assert live.as_run_wire().set.status == "running"
    await store.finish(run_id)
    done = await load_run(store, run_id, dataset_dir=dataset_dir)
    assert done.as_run_wire().set.status == "done"
    assert done.as_run_wire().set.finishedAt is not None
    # Nothing observed yet: every entry is pending, and no rate has a denominator.
    assert done.rollup.pending == done.rollup.total == 2
    assert done.metrics.detection_reliable.n == 0


# --------------------------------------------------------------------------
# Derived, never stored
# --------------------------------------------------------------------------


async def test_observations_are_read_off_the_report(store, dataset_dir) -> None:
    """C10: verdict, confirmations, the dealbreaker CHECK (not a boolean), and the
    duration summed over the report's own phase trace."""
    corpus = corpus_module.load_manifest(dataset_dir / "test-1.0.json")
    run_id = await store.create(
        RunDescriptor(corpus.dataset_version, corpus.manifest_sha, "sha", "img", 1), corpus.id
    )
    await _seed_audit(
        store,
        "a1",
        "test-pkg-bench-mal",
        report=_report("DANGEROUS", dealbreaker="shell-pipe"),
    )
    await store.record(run_id, Attempt("test-pkg-bench-mal", 0, "a1", None, None))
    run = await load_run(store, run_id, dataset_dir=dataset_dir)
    item = next(items[0] for entry, items in run.rows if entry.fixture_name == "test-pkg-bench-mal")
    assert (item.verdict, item.confirmedCount, item.dealbreaker) == ("DANGEROUS", 0, "shell-pipe")
    assert item.durationMs == 40


async def test_the_error_code_comes_from_the_durable_frame(store, dataset_dir) -> None:
    """C11: `audit_sessions.error` stores `str(exc)`, so the CODE is only in the
    audit's own terminal event — committed in the same transaction as the row's
    terminal transition, hence exactly as durable and reachable from `audit_id`
    alone. This is what lets ABSTAINED vs VOID key on a stable code instead of
    pattern-matching prose, which is what v1 did."""
    corpus = corpus_module.load_manifest(dataset_dir / "test-1.0.json")
    run_id = await store.create(
        RunDescriptor(corpus.dataset_version, corpus.manifest_sha, "sha", "img", 1), corpus.id
    )
    await _seed_audit(
        store,
        "a1",
        "test-pkg-bench-mal",
        error="Phase 'flag' timed out after 600000ms",
        code="NPMGUARD-0030",
        status="error",
    )
    await _seed_audit(
        store, "a2", "test-pkg-bench-neg", error="Docker daemon not reachable",
        code="NPMGUARD-0020", status="error",
    )
    await store.record(run_id, Attempt("test-pkg-bench-mal", 0, "a1", None, None))
    await store.record(run_id, Attempt("test-pkg-bench-neg", 0, "a2", None, None))
    observed = await store.observe(["a1", "a2"])
    assert observed["a1"].code == "NPMGUARD-0030"
    assert observed["a2"].code == "NPMGUARD-0020"
    run = await load_run(store, run_id, dataset_dir=dataset_dir)
    # 0030 abstains (the engine's own budget); 0020 voids (infrastructure).
    assert run.metrics.abstention_rate.k == 1
    assert run.metrics.void_causes == {"NPMGUARD-0020": 1}


async def test_tokens_and_cost_come_from_the_llm_ledger(store, dataset_dir) -> None:
    """C12/C13: `llm_runs` is keyed (context_kind, context_id) and every engine
    call site passes ("audit", audit_id), so this is a join. Cost stays None unless
    EVERY attempt reports one — the default backend never writes `cost_usd`, and a
    partial sum is an undercount wearing a total's clothing."""
    from kit_llm.capture import llm_attempts, llm_runs

    corpus = corpus_module.load_manifest(dataset_dir / "test-1.0.json")
    run_id = await store.create(
        RunDescriptor(corpus.dataset_version, corpus.manifest_sha, "sha", "img", 1), corpus.id
    )
    await _seed_audit(store, "a1", "test-pkg-bench-mal", report=_report("DANGEROUS", confirmed=1))
    await store.record(run_id, Attempt("test-pkg-bench-mal", 0, "a1", None, None))
    async with store.sessions() as session, session.begin():
        await session.execute(
            llm_runs.insert().values(
                id="r1", context_kind="audit", context_id="a1", role="judge",
                status="ok", steps=1, total_cost_usd=None, created_at=now_iso(),
            )
        )
        for index, (cost, model) in enumerate(((0.25, "deepseek/deepseek-v4-flash"), (None, None))):
            await session.execute(
                llm_attempts.insert().values(
                    id=f"a{index}", run_id="r1", step=index, attempt=0, model="configured",
                    messages=[], status="ok", in_tokens=100, out_tokens=10, cost_usd=cost,
                    actual_model=model, latency_ms=5, ts=now_iso(),
                )
            )
    observed = await store.observe(["a1"])
    assert (observed["a1"].tokens_prompt, observed["a1"].tokens_completion) == (200, 20)
    assert observed["a1"].cost_usd is None
    run = await load_run(store, run_id, dataset_dir=dataset_dir)
    assert run.metrics.tokens_prompt == 200
    assert run.as_run_wire().tokenCostUsd is None
    # C14: the identifier is the OBSERVED (role, actual_model) pair, not a declared
    # model id — a role's fallback tail means the two can differ, and that
    # difference is the comparability failure the field must expose.
    assert run.models == (("judge", "deepseek/deepseek-v4-flash"),)
    assert run.model_id == "judge=deepseek/deepseek-v4-flash"


async def test_an_attempt_that_never_reached_an_audit(store, dataset_dir) -> None:
    """C15: auditId None with an error is the contract's own invariant, and it is
    how a missing fixture or a refused admission is recorded."""
    corpus = corpus_module.load_manifest(dataset_dir / "test-1.0.json")
    run_id = await store.create(
        RunDescriptor(corpus.dataset_version, corpus.manifest_sha, "sha", "img", 1), corpus.id
    )
    await store.record(
        run_id,
        Attempt("test-pkg-bench-mal", 0, None, "fixture is not on disk", "NPMGUARD-0001"),
    )
    run = await load_run(store, run_id, dataset_dir=dataset_dir)
    item = next(items[0] for entry, items in run.rows if entry.fixture_name == "test-pkg-bench-mal")
    assert item.auditId is None and item.error == "fixture is not on disk"
    assert run.metrics.void_causes == {"NPMGUARD-0001": 1}
    # Both entries are UNOBSERVED, for two different honest reasons: the malware
    # entry's only attempt VOIDed, and the control was never attempted at all (a
    # run stopped early). Neither is a miss, and neither enters a denominator.
    assert run.metrics.unobserved == 2
    assert run.metrics.detection_reliable.n == 0
    assert not run.metrics.publishable


# --------------------------------------------------------------------------
# Corpus pinning
# --------------------------------------------------------------------------


async def test_a_corpus_edited_under_a_fixed_version_is_refused(store, dataset_dir) -> None:
    """C16: `manifestSha` exists to catch exactly this. Rendering the run against
    the edited entries would report two corpora as one number."""
    run_id = await _run_with_two_repeats(store, dataset_dir)
    edited = dict(CORPUS)
    edited["entries"] = CORPUS["entries"][:1]
    (dataset_dir / "test-1.0.json").write_text(json.dumps(edited), encoding="utf-8")
    with pytest.raises(BenchCorpusDrift, match="now hashes to"):
        await load_run(store, run_id, dataset_dir=dataset_dir)
    # The list route SKIPS a drifted run rather than rendering it wrong; the detail
    # route still raises, so the failure is discoverable instead of silent.
    assert await load_runs(store, dataset_dir=dataset_dir) == []


async def test_a_run_whose_manifest_is_gone_is_refused(store, dataset_dir) -> None:
    """C17."""
    run_id = await _run_with_two_repeats(store, dataset_dir)
    (dataset_dir / "test-1.0.json").unlink()
    with pytest.raises(BenchCorpusDrift, match="no longer on disk"):
        await load_run(store, run_id, dataset_dir=dataset_dir)
