# CLASS MAP — AuditService single execution owner: wait-queue + worker pool +
# restart recovery + bounded shutdown
# (seams: constructor-injected queue_size / max_concurrent; throwaway sqlite DB;
#  stub pipeline; StreamService for the durable event probe)
# Admission: C1 admit below bound → 1-based queue_position reported per SubmitResult
#            C2 queue full (queue_size=2) → QueueFullError NPMGUARD-0040, 503, retryable,
#               refused by reserve() BEFORE create → the refused audit gets NO row
#            C9 queued rows count toward the QUEUE bound (queue_size), not a session cap
# Pool:      C3 max_concurrent=1: two queued audits never overlap (observed max == 1)
#            C4 (single-owner flip) ALL paths share the one owner queue — submit() (the
#               stream/paid entry) is NOT privileged: it queues behind a busy worker just
#               like admit(). The old launch()-bypass is deleted.
#            C7 max_concurrent bounds CONCURRENCY (N workers → observed max_active == N);
#               over-cap audits QUEUE, they are not refused (the running-count cap is gone)
#            C5 a poisoned item errors its own session (durable audit_error, future raises)
#               and the pool still processes the next item
#            C8 queued_count() counts only 'queued' rows (running/terminal excluded) — the
#               admission bound's denominator
# Idempotency/retry:
#            IDEM submit() is audit_id-keyed: a second submit of the same session returns
#               the SAME future, created=False, and enqueues exactly once (one execution)
#            RETRY submit() on an 'error' row resets it to 'queued' and re-runs it —
#               a claimed-but-errored (paid) audit is genuinely retryable
#            RETRY-RACE two concurrent submits of the SAME errored claim (double paid
#               replay) dedup on _pending → one reset+enqueue+execution, no losing-
#               reset AssertionError (register-before-reset closes the race)
#            NOTIFY audit_enqueued is emitted at submit and precedes audit_started (the
#               "your scan is starting" notification) in the durable log
# Sync wire: C6 sync /audit failure → wire shape {error, message, code, retryable}
# Recovery:  C10 start() 0031s interrupted 'running' rows (audit_error retryable + errored)
#            C11 no running/queued rows → recovery is a no-op, zero spurious events
#            C12 (flip) start() RE-ENQUEUES durable 'queued' rows and runs them to
#                verdict_reached; only interrupted 'running' rows become 0031 (never drop
#                a claimed paid audit)
#            DEMO demo-tagged rows (file_contents IS NOT NULL) are excluded from 0031
#                recovery — recovery never runs the real pipeline on a demo replay
# Shutdown:  C13 (flip) close(deadline) is BOUNDED — a stalled audit no longer stalls
#                shutdown; it returns within ~deadline and finalizes the stalled row 0031
#            C13b (crash/graceful parity) close() 0031s only the RUNNING row; a never-
#                started QUEUED row is LEFT 'queued' and a fresh service re-enqueues +
#                completes it — graceful shutdown drops a claimed paid audit no more
#                than a crash does (both futures still resolve, no hang)
#            C14 (flip) two concurrent admits at one free slot never WEDGE — no check-then-
#                act loser blocking forever in put(); each either returns or raises QueueFull
#            C15 (flip) close() while a worker is mid-item RESOLVES the future (exception)
#                and finalizes the row 0031 — no orphaned future, no reliance on next start()
# Lifecycle: C16 terminal coherence (success) — at the FIRST verdict_reached the report file
#                is on disk and the row is 'done' (report → row+event, one transaction)
#            C17 terminal coherence (failure) — a save_report failure lands running->error +
#                audit_error (never done->error) and workspace cleanup still runs
# Single-owner rework: 2026 — launch()/enqueue()/_work_queue() deleted; every path funnels
#   through submit()/admit(); status is {queued,running,done,error}; the running-count
#   session cap (SessionLimitError) is retired in favor of the wait-queue bound + worker pool.
#   C4/C13/C14/C15 FLIP from documenting the old divergences to asserting the new invariants.
import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard.errors import AuditIncompleteError, QueueFullError
from npmguard.events import audit_channel
from npmguard.persistence import AuditSessionStore
from npmguard.service import AuditService, SubmitResult

WAIT_SECONDS = 15  # generous bound for any awaited queue outcome
CLOSE_STALL_OBSERVATION_SECONDS = 0.5  # long enough to prove close() has not returned
BOUNDED_CLOSE_DEADLINE = 0.3  # short shutdown grace for the stalled-audit close probes


class _Counts(BaseModel):
    total: int = 0
    open: int = 0
    inProgress: int = 0
    confirmed: int = 0
    refuted: int = 0
    deferred: int = 0


class _Report(BaseModel):
    verdict: str = "SAFE"
    rationale: str = "stub rationale"
    counts: _Counts = _Counts()
    trace: list = []


class _Result:
    def __init__(self) -> None:
        self.report = _Report()
        self.cleaned = False

    def cleanup(self) -> None:
        self.cleaned = True


class StubPipeline:
    """Deterministic pipeline: per-package behavior — block on an event, raise,
    or return a SAFE report. Records active-concurrency for the overlap probe."""

    def __init__(self) -> None:
        self.blockers: dict[str, asyncio.Event] = {}
        self.failures: set[str] = set()
        self.active = 0
        self.max_active = 0
        self.started: list[str] = []
        self.results: dict[str, _Result] = {}
        self.first_started = asyncio.Event()

    async def run(self, package_name: str, *, audit_id: str, version: str | None, emitter: Any):
        self.started.append(package_name)
        self.first_started.set()
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            blocker = self.blockers.get(package_name)
            if blocker is not None:
                await blocker.wait()
            else:
                await asyncio.sleep(0.01)  # force an overlap window for C3
            if package_name in self.failures:
                raise RuntimeError(f"pipeline exploded for {package_name}")
            result = _Result()
            self.results[package_name] = result
            return result
        finally:
            self.active -= 1


class StartEmittingPipeline:
    """Emits audit_started like the real pipeline.run does at its first line —
    used to pin the audit_enqueued → audit_started ordering."""

    async def run(self, package_name: str, *, audit_id: str, version: str | None, emitter: Any):
        await emitter.emit("audit_started", {"packageName": package_name})
        return _Result()


@pytest.fixture
async def rig(tmp_path, monkeypatch):
    monkeypatch.setattr("npmguard.report_store.DATA_DIR", tmp_path / "reports")
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'queue.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    rig = SimpleNamespace(
        factory=factory,
        sessions=AuditSessionStore(factory),
        stream=StreamService(factory, PollingNotifier()),
        pipeline=StubPipeline(),
    )
    rig.service = AuditService(rig.pipeline, rig.sessions, rig.stream, queue_size=2)
    yield rig
    for blocker in rig.pipeline.blockers.values():
        blocker.set()
    async with asyncio.timeout(WAIT_SECONDS):
        await rig.service.close()
    await engine.dispose()


async def _wait_status(sessions, audit_id: str, status: str) -> None:
    async with asyncio.timeout(WAIT_SECONDS):
        while (await sessions.get(audit_id)).status != status:  # noqa: ASYNC110
            await asyncio.sleep(0.02)


async def test_admit_reports_one_based_positions(rig) -> None:
    """C1: with no worker draining, successive admits report their 1-based
    position in the queue via SubmitResult.queue_position."""
    service = rig.service
    result_a = await service.admit("pkg-a", "1.0.0")
    result_b = await service.admit("pkg-b", "1.0.0")
    assert (result_a.queue_position, result_b.queue_position) == (1, 2)
    assert result_a.created and result_b.created
    result_a.future.cancel()
    result_b.future.cancel()


async def test_queue_full_is_typed_retryable_503(rig) -> None:
    """C2: the third admit against queue_size=2 refuses with QueueFullError —
    NPMGUARD-0040, http 503, retryable — refused by reserve() BEFORE create, so
    the refused audit gets NO session row (queued_count stays 2)."""
    service, sessions = rig.service, rig.sessions
    result_a = await service.admit("pkg-a", "1.0.0")
    result_b = await service.admit("pkg-b", "1.0.0")
    with pytest.raises(QueueFullError) as excinfo:
        await service.admit("pkg-c", "1.0.0")
    assert excinfo.value.code == "NPMGUARD-0040"
    assert excinfo.value.http_status == 503
    assert excinfo.value.retryable is True
    assert await sessions.queued_count() == 2  # the refused audit never got a row
    result_a.future.cancel()
    result_b.future.cancel()


async def test_single_worker_never_overlaps_queued_audits(rig) -> None:
    """C3: with a pool of one, two queued audits execute sequentially — observed
    max concurrency is 1 and both futures resolve to reports."""
    service, pipeline = rig.service, rig.pipeline
    await service.start()
    result_a = await service.admit("pkg-a", "1.0.0")
    result_b = await service.admit("pkg-b", "1.0.0")
    async with asyncio.timeout(WAIT_SECONDS):
        report_a, report_b = await asyncio.gather(result_a.future, result_b.future)
    assert report_a["verdict"] == "SAFE"
    assert report_b["verdict"] == "SAFE"
    assert pipeline.max_active == 1


async def test_all_paths_share_the_single_owner_queue(rig) -> None:
    """C4 (flip): submit() — the /audit/stream + paid entry — has NO privileged
    bypass. With a single-worker pool busy on a submitted audit, a second admit
    QUEUES behind it (status stays 'queued', future unresolved) instead of
    running immediately. Releasing the first lets both complete through the pool."""
    service, pipeline, sessions = rig.service, rig.pipeline, rig.sessions
    pipeline.blockers["stream-blocked"] = asyncio.Event()
    await service.start()

    streamed = await sessions.create("stream-blocked", "1.0.0")  # a paid/stream row
    stream_result = await service.submit(streamed)  # SAME queue, no bypass
    async with asyncio.timeout(WAIT_SECONDS):
        await pipeline.first_started.wait()  # the worker is now busy on it

    queued = await service.admit("queued-pkg", "1.0.0")
    await asyncio.sleep(0.05)
    assert not queued.future.done()  # no bypass: it waits behind the busy worker
    assert (await sessions.get(queued.audit_id)).status == "queued"

    pipeline.blockers["stream-blocked"].set()
    async with asyncio.timeout(WAIT_SECONDS):
        report_stream, report_queued = await asyncio.gather(
            stream_result.future, queued.future
        )
    assert report_stream["verdict"] == "SAFE" and report_queued["verdict"] == "SAFE"


async def test_pool_bounds_concurrency_and_queues_the_rest(rig) -> None:
    """C7 (flip): max_concurrent bounds concurrent EXECUTION — three blocked
    audits against a pool of two run at most two at a time (the running-count cap
    that used to REFUSE the third is gone; it QUEUES). Releasing them lets all
    three complete with observed max_active == 2."""
    pipeline, sessions, stream = rig.pipeline, rig.sessions, rig.stream
    for name in ("p1", "p2", "p3"):
        pipeline.blockers[name] = asyncio.Event()
    pool = AuditService(pipeline, sessions, stream, queue_size=5, max_concurrent=2)
    await pool.start()
    try:
        results = [await pool.admit(name, "1.0.0") for name in ("p1", "p2", "p3")]
        async with asyncio.timeout(WAIT_SECONDS):
            while pipeline.active < 2:  # noqa: ASYNC110
                await asyncio.sleep(0.02)
        await asyncio.sleep(0.1)  # give any (bug) third execution a chance to start
        assert pipeline.active == 2  # never three at once
        assert pipeline.max_active == 2
        for name in ("p1", "p2", "p3"):
            pipeline.blockers[name].set()
        async with asyncio.timeout(WAIT_SECONDS):
            reports = await asyncio.gather(*(r.future for r in results))
        assert all(report["verdict"] == "SAFE" for report in reports)
        assert pipeline.max_active == 2  # bound held throughout
    finally:
        async with asyncio.timeout(WAIT_SECONDS):
            await pool.close()


async def test_worker_survives_pipeline_exception(rig) -> None:
    """C5: a poisoned queue item errors its own session (durable audit_error,
    status=error, future raises) and the pool still processes the next item."""
    service, pipeline, sessions, stream = rig.service, rig.pipeline, rig.sessions, rig.stream
    pipeline.failures.add("pkg-poison")
    await service.start()
    poisoned = await service.admit("pkg-poison", "1.0.0")
    ok = await service.admit("pkg-ok", "1.0.0")
    async with asyncio.timeout(WAIT_SECONDS):
        with pytest.raises(RuntimeError, match="pipeline exploded"):
            await poisoned.future
        report = await ok.future
    assert report["verdict"] == "SAFE"
    assert (await sessions.get(poisoned.audit_id)).status == "error"
    events = await stream.read_after(audit_channel(poisoned.audit_id), -1)
    errors = [event for event in events if event["type"] == "audit_error"]
    assert len(errors) == 1
    assert errors[0]["data"]["code"] == "NPMGUARD-9999"


async def test_queued_count_counts_only_queued_rows(rig) -> None:
    """C8 (flip): queued_count() — the admission bound's denominator — counts
    only 'queued' rows; a row that has been marked running or finalized no longer
    counts."""
    sessions = rig.sessions
    a = await sessions.create("pkg-a", "1.0.0")
    assert await sessions.queued_count() == 1
    await sessions.mark_running(a.audit_id)
    assert await sessions.queued_count() == 0  # running is not queued
    b = await sessions.create("pkg-b", "1.0.0")
    await sessions.mark_running(b.audit_id)
    await sessions.finalize(b.audit_id, {"verdict": "SAFE"})
    assert await sessions.queued_count() == 0  # done is not queued


async def test_queued_rows_count_toward_the_queue_bound(rig) -> None:
    """C9 (flip): queued-but-unstarted audits count toward the wait-queue bound
    (queue_size), so a full queue refuses with QueueFullError — not the retired
    session cap's SessionLimitError."""
    pipeline, sessions, stream = rig.pipeline, rig.sessions, rig.stream
    service = AuditService(pipeline, sessions, stream, queue_size=1)  # worker never started
    first = await service.admit("pkg-a", "1.0.0")
    with pytest.raises(QueueFullError):
        await service.admit("pkg-b", "1.0.0")
    first.future.cancel()


def test_sync_audit_error_wire_shape(monkeypatch, tmp_path) -> None:
    """C6: a failed sync /audit returns the _audit_error wire shape
    {error:"Audit failed", message, code, retryable} — here via a resolve failure
    (registry unreachable), which is not an NpmGuardError → 9999/500/false."""
    from npmguard.api import create_app
    from npmguard.config import get_settings

    monkeypatch.setattr("npmguard.report_store.DATA_DIR", tmp_path / "reports")
    monkeypatch.setattr("npmguard.resolve.NPM_REGISTRY", "http://127.0.0.1:1")
    monkeypatch.setenv("NPMGUARD_ENV", "test")
    monkeypatch.setenv("NPMGUARD_PAYMENT_REQUIRED", "false")
    monkeypatch.setenv("NPMGUARD_MOCK_LLM", "true")
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "audit-logs"))
    monkeypatch.setenv(
        "NPMGUARD_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'wire.sqlite3'}"
    )
    get_settings.cache_clear()
    try:
        with TestClient(create_app()) as client:
            response = client.post("/audit", json={"packageName": "not-a-local-fixture"})
        assert response.status_code == 500
        body = response.json()
        assert set(body) == {"error", "message", "code", "retryable"}
        assert body["error"] == "Audit failed"
        assert body["code"] == "NPMGUARD-9999"
        assert body["retryable"] is False
    finally:
        get_settings.cache_clear()


async def test_submit_is_idempotent_by_audit_id(rig) -> None:
    """IDEM: two submits of the same session (the webhook-vs-stream replay race)
    return the SAME future with created=False on the second, and drive exactly
    one execution. The second submit lands while the worker holds the item, so
    the audit_id is still owned in _pending — the race the invariant protects."""
    service, sessions, pipeline = rig.service, rig.sessions, rig.pipeline
    pipeline.blockers["pkg-idem"] = asyncio.Event()
    await service.start()
    session = await sessions.create("pkg-idem", "1.0.0")
    first = await service.submit(session)
    async with asyncio.timeout(WAIT_SECONDS):
        await pipeline.first_started.wait()  # the worker owns the item mid-execute
    second = await service.submit(session)  # same audit_id → still owned
    assert second.future is first.future
    assert second.created is False
    pipeline.blockers["pkg-idem"].set()
    async with asyncio.timeout(WAIT_SECONDS):
        await first.future
    assert pipeline.started.count("pkg-idem") == 1  # executed exactly once


async def test_submit_reruns_a_recoverable_error(rig) -> None:
    """RETRY: submit() on an 'error' row resets it to 'queued' and re-runs it to
    completion — a claimed-but-errored (paid) audit is genuinely retryable."""
    service, sessions = rig.service, rig.sessions
    session = await sessions.create("pkg-retry", "1.0.0")
    await sessions.mark_running(session.audit_id)
    await sessions.finalize(session.audit_id, None, "prior failure")
    errored = await sessions.get(session.audit_id)
    assert errored.status == "error"
    await service.start()
    result = await service.submit(errored)
    assert result.created is True
    async with asyncio.timeout(WAIT_SECONDS):
        report = await result.future
    assert report["verdict"] == "SAFE"
    assert (await sessions.get(session.audit_id)).status == "done"


async def test_audit_enqueued_precedes_audit_started(rig) -> None:
    """NOTIFY: audit_enqueued (emitted at submit) is durable BEFORE audit_started
    (emitted when execution begins) — the client sees "queued" then "starting"."""
    pipeline, sessions, stream = StartEmittingPipeline(), rig.sessions, rig.stream
    service = AuditService(pipeline, sessions, stream, queue_size=5, max_concurrent=1)
    await service.start()
    try:
        session = await sessions.create("pkg-notify", "1.0.0")
        result = await service.submit(session)
        async with asyncio.timeout(WAIT_SECONDS):
            await result.future
        events = await stream.read_after(audit_channel(session.audit_id), -1)
        by_type = {event["type"]: event["seq"] for event in events}
        assert "audit_enqueued" in by_type and "audit_started" in by_type
        assert by_type["audit_enqueued"] < by_type["audit_started"]
    finally:
        async with asyncio.timeout(WAIT_SECONDS):
            await service.close()


async def test_recovery_fails_interrupted_running_sessions(rig) -> None:
    """C10: start() turns every pre-restart RUNNING session into an explicit
    retryable interruption: audit_error NPMGUARD-0031 on the durable channel and
    session status=error."""
    service, sessions, stream = rig.service, rig.sessions, rig.stream
    interrupted = await sessions.create("pkg-interrupted", "1.0.0")
    await sessions.mark_running(interrupted.audit_id)  # in-flight at the crash
    await service.start()
    restored = await sessions.get(interrupted.audit_id)
    assert restored.status == "error"
    assert restored.error == "Audit interrupted by engine restart"
    events = await stream.read_after(audit_channel(interrupted.audit_id), -1)
    assert [event["type"] for event in events] == ["audit_error"]
    assert events[0]["data"]["code"] == "NPMGUARD-0031"
    assert events[0]["data"]["retryable"] is True


async def test_recovery_noop_without_nonterminal_sessions(rig) -> None:
    """C11: with only finished sessions in the DB, recovery emits nothing and
    mutates nothing."""
    service, sessions, stream = rig.service, rig.sessions, rig.stream
    finished = await sessions.create("pkg-done", "1.0.0")
    await sessions.finalize(finished.audit_id, {"verdict": "SAFE"})
    await service.start()
    assert (await sessions.get(finished.audit_id)).status == "done"
    assert await stream.read_after(audit_channel(finished.audit_id), -1) == []


async def test_restart_reenqueues_queued_sessions(rig) -> None:
    """C12 (flip): durable 'queued' rows are RE-ENQUEUED by a fresh service and
    run to verdict_reached — never dropped. Only an interrupted 'running' row
    becomes a 0031."""
    pipeline, sessions, stream = rig.pipeline, rig.sessions, rig.stream
    # durable queued rows (a service whose worker never started)
    wide = AuditService(pipeline, sessions, stream, queue_size=5)
    queued_ids = []
    for name in ("pkg-q1", "pkg-q2"):
        result = await wide.admit(name, "1.0.0")
        result.future.cancel()  # the HTTP caller does not survive the restart
        queued_ids.append(result.audit_id)
    # an interrupted running row
    interrupted = await sessions.create("pkg-run", "1.0.0")
    await sessions.mark_running(interrupted.audit_id)

    fresh = AuditService(pipeline, sessions, stream, queue_size=5, max_concurrent=1)
    await fresh.start()
    try:
        for audit_id in queued_ids:
            await _wait_status(sessions, audit_id, "done")
            events = await stream.read_after(audit_channel(audit_id), -1)
            assert "verdict_reached" in [event["type"] for event in events]
        errored = await sessions.get(interrupted.audit_id)
        assert errored.status == "error"
        events = await stream.read_after(audit_channel(interrupted.audit_id), -1)
        assert [event["type"] for event in events] == ["audit_error"]
        assert events[0]["data"]["code"] == "NPMGUARD-0031"
    finally:
        async with asyncio.timeout(WAIT_SECONDS):
            await fresh.close()


async def test_demo_rows_excluded_from_recovery(rig) -> None:
    """DEMO: a demo-tagged row (file_contents IS NOT NULL) is invisible to
    running()/queued(), so restart recovery never 0031s it nor re-runs the real
    pipeline on it."""
    service, sessions, stream = rig.service, rig.sessions, rig.stream
    demo = await sessions.create("demo-pkg", file_contents={"index.js": "x"})
    await sessions.mark_running(demo.audit_id)  # a demo replay "in progress"
    await service.start()
    restored = await sessions.get(demo.audit_id)
    assert restored.status == "running"  # untouched by recovery
    events = await stream.read_after(audit_channel(demo.audit_id), -1)
    assert all(event["type"] != "audit_error" for event in events)
    await sessions.finalize(demo.audit_id, {"verdict": "SAFE"})  # tidy for teardown


async def test_close_is_bounded_and_finalizes_inflight(rig) -> None:
    """C13 (flip): close(deadline) is BOUNDED — a stalled in-flight audit no
    longer stalls shutdown. close returns within roughly the deadline, the
    stalled row is finalized error/0031, and its future resolves with an
    exception (never orphaned)."""
    service, pipeline, sessions, stream = rig.service, rig.pipeline, rig.sessions, rig.stream
    pipeline.blockers["pkg-stalled"] = asyncio.Event()
    await service.start()
    result = await service.submit(await sessions.create("pkg-stalled", "1.0.0"))
    async with asyncio.timeout(WAIT_SECONDS):
        await pipeline.first_started.wait()  # the stalled audit is definitely in-flight

    loop = asyncio.get_running_loop()
    started = loop.time()
    await service.close(deadline=BOUNDED_CLOSE_DEADLINE)
    elapsed = loop.time() - started
    assert elapsed < BOUNDED_CLOSE_DEADLINE + 3  # bounded, not unbounded

    assert (await sessions.get(result.audit_id)).status == "error"
    events = await stream.read_after(audit_channel(result.audit_id), -1)
    assert any(
        event["type"] == "audit_error" and event["data"]["code"] == "NPMGUARD-0031"
        for event in events
    )
    assert result.future.done()
    with pytest.raises(AuditIncompleteError):
        result.future.result()


async def test_close_leaves_queued_recoverable_while_0031ing_running(rig) -> None:
    """C13b (graceful/crash parity): a graceful close() 0031s the RUNNING audit
    (a mid-Docker phase cannot resume) but LEAVES the never-started QUEUED audit
    'queued' — a fresh service over the same DB re-enqueues and completes it. So
    a graceful shutdown drops a claimed paid audit no more than a crash does.
    Both futures still resolve (retryable), so no caller hangs."""
    service, pipeline, sessions, stream = rig.service, rig.pipeline, rig.sessions, rig.stream
    pipeline.blockers["pkg-running"] = asyncio.Event()
    await service.start()  # pool of one
    running = await service.submit(await sessions.create("pkg-running", "1.0.0"))
    async with asyncio.timeout(WAIT_SECONDS):
        await pipeline.first_started.wait()  # the worker is busy on pkg-running
    queued = await service.admit("pkg-queued", "1.0.0")  # sits behind the busy worker
    assert (await sessions.get(queued.audit_id)).status == "queued"

    await service.close(deadline=BOUNDED_CLOSE_DEADLINE)

    # RUNNING → error/0031 (unresumable); its future resolves with an exception
    assert (await sessions.get(running.audit_id)).status == "error"
    assert running.future.done()
    with pytest.raises(AuditIncompleteError):
        running.future.result()
    # QUEUED → STILL queued (recoverable), yet its future is resolved (no hang)
    assert (await sessions.get(queued.audit_id)).status == "queued"
    assert queued.future.done()
    with pytest.raises(AuditIncompleteError):
        queued.future.result()

    # recoverability: a fresh service re-enqueues the queued row and runs it
    pipeline.blockers["pkg-running"].set()
    fresh = AuditService(pipeline, sessions, stream, queue_size=5, max_concurrent=1)
    await fresh.start()
    try:
        await _wait_status(sessions, queued.audit_id, "done")
        events = await stream.read_after(audit_channel(queued.audit_id), -1)
        assert "verdict_reached" in [event["type"] for event in events]
        # the 0031'd running row is terminal — recovery must NOT re-run it
        assert (await sessions.get(running.audit_id)).status == "error"
    finally:
        async with asyncio.timeout(WAIT_SECONDS):
            await fresh.close()


async def test_concurrent_replay_of_errored_claim_dedups(rig) -> None:
    """RETRY-RACE: two concurrent submits of the SAME errored claim (a double
    paid replay — both callers read status=='error') dedup on _pending: exactly
    one reset_to_queued + one enqueue + one execution, the same future returned to
    both, and NO AssertionError from a losing guarded reset (the old reset-before-
    register order raised on rowcount 0 → a spurious 500 on a valid retry)."""
    service, sessions, pipeline = rig.service, rig.sessions, rig.pipeline
    session = await sessions.create("pkg-dbl-replay", "1.0.0")
    await sessions.mark_running(session.audit_id)
    await sessions.finalize(session.audit_id, None, "prior transient failure")
    errored = await sessions.get(session.audit_id)
    assert errored.status == "error"
    await service.start()
    # both callers hold the SAME errored snapshot and submit concurrently
    first, second = await asyncio.gather(service.submit(errored), service.submit(errored))
    assert first.future is second.future  # one owner, the other deduped
    assert sum((first.created, second.created)) == 1  # exactly one enqueued fresh
    async with asyncio.timeout(WAIT_SECONDS):
        report = await first.future
    assert report["verdict"] == "SAFE"
    assert (await sessions.get(session.audit_id)).status == "done"
    assert pipeline.started.count("pkg-dbl-replay") == 1  # executed exactly once


async def test_concurrent_admits_at_one_free_slot_never_wedge(rig) -> None:
    """C14 (flip): two concurrent admits into one nominal free slot never WEDGE.
    The old check-then-act left the loser blocked forever inside queue.put(); now
    the queue is unbounded and reserve() is a pure DB pre-check, so each racer
    either returns a SubmitResult or raises QueueFullError — neither hangs."""
    service, sessions = rig.service, rig.sessions
    occupied = await service.admit("pkg-occupied", "1.0.0")  # one of two slots

    racer_a = asyncio.create_task(service.admit("pkg-race-a", "1.0.0"))
    racer_b = asyncio.create_task(service.admit("pkg-race-b", "1.0.0"))
    done, pending = await asyncio.wait(
        {racer_a, racer_b}, timeout=CLOSE_STALL_OBSERVATION_SECONDS
    )
    assert len(pending) == 0  # neither wedges — the pin's core invariant
    for task in done:
        exc = task.exception()
        if exc is not None:
            assert isinstance(exc, QueueFullError)  # a clean refusal, not a hang
        else:
            result = task.result()
            assert isinstance(result, SubmitResult)
            result.future.cancel()
    occupied.future.cancel()
    # no session row is left behind by a wedged coroutine
    assert len(await sessions.running()) == 0


async def test_close_mid_item_resolves_future_and_finalizes(rig) -> None:
    """C15 (flip): close() while a worker is executing a queued item RESOLVES the
    item's future (with an exception) and finalizes the row error/0031 — no
    orphaned future, no reliance on a later start() to repair it."""
    service, pipeline, sessions, stream = rig.service, rig.pipeline, rig.sessions, rig.stream
    pipeline.blockers["pkg-mid-item"] = asyncio.Event()
    await service.start()
    result = await service.submit(await sessions.create("pkg-mid-item", "1.0.0"))
    async with asyncio.timeout(WAIT_SECONDS):
        await pipeline.first_started.wait()  # the worker holds the item mid-execute

    async with asyncio.timeout(WAIT_SECONDS):
        await service.close(deadline=BOUNDED_CLOSE_DEADLINE)
    assert result.future.done()  # resolved by close(), not orphaned
    with pytest.raises(AuditIncompleteError):
        result.future.result()
    restored = await sessions.get(result.audit_id)
    assert restored.status == "error"
    events = await stream.read_after(audit_channel(result.audit_id), -1)
    assert any(
        event["type"] == "audit_error" and event["data"]["code"] == "NPMGUARD-0031"
        for event in events
    )


async def _first_terminal_observation(stream, audit_id: str) -> list[dict[str, Any]]:
    """Bounded wait for the FIRST terminal frame on the channel; returns the
    full event log at that instant. Everything asserted afterwards must already
    hold — no further waiting is allowed (that is the invariant under test)."""
    async with asyncio.timeout(WAIT_SECONDS):
        while True:
            events = await stream.read_after(audit_channel(audit_id), -1)
            if any(event["type"] in {"verdict_reached", "audit_error"} for event in events):
                return events
            await asyncio.sleep(0.01)


async def test_terminal_frame_implies_durable_report_and_row(rig, tmp_path) -> None:
    """C16 — INVARIANT: the instant verdict_reached is first observable, the
    report file is already on disk and the row is already 'done'. The report is
    saved BEFORE the row turns terminal, and the terminal event commits in the
    SAME transaction as running->done — so these probes run with NO poll."""
    service, sessions, stream = rig.service, rig.sessions, rig.stream
    await service.start()
    session = await sessions.create("pkg-coherent", "1.0.0")
    await service.submit(session)
    events = await _first_terminal_observation(stream, session.audit_id)
    # audit_enqueued (at submit) precedes the terminal frame; the stub pipeline
    # emits nothing else, so the log is exactly these two at the terminal instant.
    assert [event["type"] for event in events] == ["audit_enqueued", "verdict_reached"]
    assert events[-1]["data"]["verdict"] == "SAFE"
    # instant probes — the invariant forbids any wait after the frame:
    restored = await sessions.get(session.audit_id)
    assert restored.status == "done"
    assert restored.report is not None
    persisted = tmp_path / "reports" / "pkg-coherent" / "1.0.0.json"
    assert persisted.is_file()
    assert json.loads(persisted.read_text(encoding="utf-8"))["verdict"] == "SAFE"


async def test_save_failure_lands_as_error_and_still_cleans_up(rig, monkeypatch) -> None:
    """C17 — INVARIANT: a save_report failure surfaces as running->error with a
    single audit_error and NO verdict_reached, and the workspace cleanup still
    runs (finally)."""
    service, pipeline, sessions, stream = rig.service, rig.pipeline, rig.sessions, rig.stream

    def _boom(*_args: Any, **_kwargs: Any) -> str:
        raise RuntimeError("disk full")

    monkeypatch.setattr("npmguard.service.save_report", _boom)
    await service.start()
    result = await service.admit("pkg-savefail", "1.0.0")
    async with asyncio.timeout(WAIT_SECONDS):
        with pytest.raises(RuntimeError, match="disk full"):
            await result.future
    restored = await sessions.get(result.audit_id)
    assert restored.status == "error"  # never 'done' without a durable report
    assert restored.error == "disk full"
    events = await stream.read_after(audit_channel(result.audit_id), -1)
    kinds = [event["type"] for event in events]
    assert "verdict_reached" not in kinds  # save failed BEFORE the terminal txn
    assert kinds.count("audit_error") == 1
    assert pipeline.results["pkg-savefail"].cleaned  # finally: no workspace leak
