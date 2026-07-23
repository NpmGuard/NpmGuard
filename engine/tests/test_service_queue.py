# CLASS MAP — AuditService queue + session cap + restart recovery + shutdown
# (seams: constructor-injected queue_size / AuditSessionStore(max_running=N);
#  throwaway sqlite DB; stub pipeline; StreamService for the durable event probe)
# Queue:    C1 enqueue below bound → 1-based queue position reported per item
#           C2 queue full (queue_size=2) → QueueFullError NPMGUARD-0040, 503, retryable
#           C3 single worker: two queued audits never overlap (max concurrency == 1)
#           C4 /audit/stream launch() BYPASSES the queue — a launched audit completes
#              while the queue worker is stalled. PINNED divergence, INTENDED-or-UNENFORCED:
#              stream launches are bounded only by the session cap, not the queue.
#           C5 worker survives a pipeline exception → future carries it, session errored,
#              audit_error event durable, NEXT item still processed
#           C6 sync /audit failure → wire shape {error:"Audit failed", message, code, retryable}
# Cap:      C7 max_running=1 → second create raises SessionLimitError NPMGUARD-0050, 503, retryable
#           C8 done/error sessions do NOT count toward the cap
#           C9 queued-but-unstarted sessions DO count (status=running from creation)
# Recovery: C10 start() fails interrupted running rows: audit_error NPMGUARD-0031 retryable
#               on the durable channel + session finalized as error
#           C11 no running rows → recovery is a no-op, zero spurious events
#           C12 queued items are lost on restart but their sessions get C10 treatment (S32 twin)
# Shutdown: C13 close() awaits in-flight launches UNBOUNDED — a stalled audit stalls close().
#               PINNED (UNENFORCED): observed with a bounded wait, then released; the
#               fix (bounded close) is a maintainer decision, not this test's.
#           C14 concurrent enqueue at ONE free slot — PINNED check-then-act: both pass
#               the queue.full() check, both create sessions, the loser blocks inside
#               queue.put() with its session already counting toward the cap.
#           C15 close() with the worker mid-queued-item — PINNED: the cancel rips
#               through _execute; the item's future never resolves and its session
#               stays running until the next start() recovery (0031).
# Lifecycle: C16 terminal coherence (success) — INVARIANT: at the FIRST observation of
#               verdict_reached the report file is on disk and the row is 'done'
#               (report → row+event, one transaction; no post-terminal poll needed)
#            C17 terminal coherence (failure) — INVARIANT: a save_report failure lands
#               as running->error + audit_error (never the old done->error flip) and
#               the workspace cleanup still runs (finally; the old path leaked it)
# Adversarial pass: W5 2026-07-23 — "can a queue bug wedge the worker permanently?" →
#   C5 proves the worker outlives a poisoned item; C13 documents the one known wedge.
# Adversarial pass: 2026-07-23/A1 — the Queue axis was entirely sequential; C14/C15
#   add the concurrency/shutdown boundary pins.
# Invariant pass: 2026-07-23/lifecycle-coherence — the terminal frame used to be
#   emitted inside pipeline.run BEFORE finalize+save (the S29 flake, contained by
#   tests/support/waits.py polling); C16/C17 assert the enforced ordering.
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
from npmguard.errors import QueueFullError, SessionLimitError
from npmguard.events import audit_channel
from npmguard.persistence import AuditSessionStore
from npmguard.service import AuditService

WAIT_SECONDS = 15  # generous bound for any awaited queue outcome
CLOSE_STALL_OBSERVATION_SECONDS = 0.5  # long enough to prove close() has not returned


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


async def test_enqueue_reports_one_based_positions(rig) -> None:
    """C1: with the worker not yet draining, successive enqueues report their
    1-based position in the queue."""
    service = rig.service
    _, future_a, position_a = await service.enqueue("pkg-a", "1.0.0")
    _, future_b, position_b = await service.enqueue("pkg-b", "1.0.0")
    assert (position_a, position_b) == (1, 2)
    future_a.cancel()
    future_b.cancel()


async def test_queue_full_is_typed_retryable_503(rig) -> None:
    """C2: the third enqueue against queue_size=2 refuses with QueueFullError —
    NPMGUARD-0040, http 503, retryable — and creates NO session."""
    service, sessions = rig.service, rig.sessions
    _, future_a, _ = await service.enqueue("pkg-a", "1.0.0")
    _, future_b, _ = await service.enqueue("pkg-b", "1.0.0")
    with pytest.raises(QueueFullError) as excinfo:
        await service.enqueue("pkg-c", "1.0.0")
    assert excinfo.value.code == "NPMGUARD-0040"
    assert excinfo.value.http_status == 503
    assert excinfo.value.retryable is True
    assert len(await sessions.running()) == 2  # the refused audit never got a session
    future_a.cancel()
    future_b.cancel()


async def test_single_worker_never_overlaps_queued_audits(rig) -> None:
    """C3: two queued audits execute sequentially — observed max concurrency is 1
    and both futures resolve to reports."""
    service, pipeline = rig.service, rig.pipeline
    await service.start()
    _, future_a, _ = await service.enqueue("pkg-a", "1.0.0")
    _, future_b, _ = await service.enqueue("pkg-b", "1.0.0")
    async with asyncio.timeout(WAIT_SECONDS):
        report_a, report_b = await asyncio.gather(future_a, future_b)
    assert report_a["verdict"] == "SAFE"
    assert report_b["verdict"] == "SAFE"
    assert pipeline.max_active == 1


async def test_stream_launch_bypasses_queue_pinned(rig) -> None:
    """C4 — PINNED divergence (INTENDED-or-UNENFORCED): launch() (the
    /audit/stream path) executes immediately even while the single queue worker
    is stalled on a queued item; stream launches are not queue-serialized."""
    service, pipeline, sessions = rig.service, rig.pipeline, rig.sessions
    pipeline.blockers["queued-stalled"] = asyncio.Event()
    await service.start()
    _, queued_future, _ = await service.enqueue("queued-stalled", "1.0.0")

    streamed = await sessions.create("streamed-pkg", "1.0.0")
    service.launch(streamed)
    async with asyncio.timeout(WAIT_SECONDS):
        # bounded DB-status poll: session status is the public seam here and no
        # completion event exists for it — the timeout above bounds the wait
        while (await sessions.get(streamed.audit_id)).status == "running":  # noqa: ASYNC110
            await asyncio.sleep(0.02)
    assert (await sessions.get(streamed.audit_id)).status == "done"
    assert not queued_future.done()  # the queued audit is still stalled behind the worker
    pipeline.blockers["queued-stalled"].set()
    async with asyncio.timeout(WAIT_SECONDS):
        await queued_future


async def test_worker_survives_pipeline_exception(rig) -> None:
    """C5: a poisoned queue item errors its own session (durable audit_error,
    status=error, future raises) and the worker still processes the next item."""
    service, pipeline, sessions, stream = rig.service, rig.pipeline, rig.sessions, rig.stream
    pipeline.failures.add("pkg-poison")
    await service.start()
    poisoned, poison_future, _ = await service.enqueue("pkg-poison", "1.0.0")
    _, ok_future, _ = await service.enqueue("pkg-ok", "1.0.0")
    async with asyncio.timeout(WAIT_SECONDS):
        with pytest.raises(RuntimeError, match="pipeline exploded"):
            await poison_future
        report = await ok_future
    assert report["verdict"] == "SAFE"
    assert (await sessions.get(poisoned.audit_id)).status == "error"
    events = await stream.read_after(audit_channel(poisoned.audit_id), -1)
    errors = [event for event in events if event["type"] == "audit_error"]
    assert len(errors) == 1
    assert errors[0]["data"]["code"] == "NPMGUARD-9999"


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


async def test_session_cap_is_typed_retryable_503(rig) -> None:
    """C7: with max_running=1, the second create raises SessionLimitError —
    NPMGUARD-0050, http 503, retryable."""
    capped = AuditSessionStore(rig.factory, max_running=1)  # same DB, shrunken cap
    await capped.create("pkg-a", "1.0.0")
    with pytest.raises(SessionLimitError) as excinfo:
        await capped.create("pkg-b", "1.0.0")
    assert excinfo.value.code == "NPMGUARD-0050"
    assert excinfo.value.http_status == 503
    assert excinfo.value.retryable is True


async def test_finished_sessions_do_not_count_toward_cap(rig) -> None:
    """C8: done and error sessions free their cap slot — only status=running
    counts."""
    capped = AuditSessionStore(rig.factory, max_running=1)
    done = await capped.create("pkg-a", "1.0.0")
    await capped.finalize(done.audit_id, {"verdict": "SAFE"})
    errored = await capped.create("pkg-b", "1.0.0")
    await capped.finalize(errored.audit_id, None, "boom")
    third = await capped.create("pkg-c", "1.0.0")  # both prior slots released
    assert third.status == "running"


async def test_queued_unstarted_sessions_count_toward_cap(rig) -> None:
    """C9: a queued-but-unstarted audit already holds a running session row, so
    it consumes cap even though no worker has touched it."""
    capped = AuditSessionStore(rig.factory, max_running=1)
    service = AuditService(rig.pipeline, capped, rig.stream, queue_size=5)
    _, future, _ = await service.enqueue("pkg-a", "1.0.0")  # worker never started
    with pytest.raises(SessionLimitError):
        await service.enqueue("pkg-b", "1.0.0")
    future.cancel()


async def test_recovery_fails_interrupted_sessions(rig) -> None:
    """C10: start() turns every pre-restart running session into an explicit
    retryable interruption: audit_error NPMGUARD-0031 on the durable channel and
    session status=error."""
    service, sessions, stream = rig.service, rig.sessions, rig.stream
    interrupted = await sessions.create("pkg-interrupted", "1.0.0")
    await service.start()
    restored = await sessions.get(interrupted.audit_id)
    assert restored.status == "error"
    assert restored.error == "Audit interrupted by engine restart"
    events = await stream.read_after(audit_channel(interrupted.audit_id), -1)
    assert [event["type"] for event in events] == ["audit_error"]
    assert events[0]["data"]["code"] == "NPMGUARD-0031"
    assert events[0]["data"]["retryable"] is True


async def test_recovery_noop_without_running_sessions(rig) -> None:
    """C11: with only finished sessions in the DB, recovery emits nothing and
    mutates nothing."""
    service, sessions, stream = rig.service, rig.sessions, rig.stream
    finished = await sessions.create("pkg-done", "1.0.0")
    await sessions.finalize(finished.audit_id, {"verdict": "SAFE"})
    await service.start()
    assert (await sessions.get(finished.audit_id)).status == "done"
    assert await stream.read_after(audit_channel(finished.audit_id), -1) == []


async def test_restart_errors_queued_sessions_too(rig, tmp_path) -> None:
    """C12 (S32 twin): queued items die with the process, but their sessions are
    running rows — a fresh service over the same DB errors ALL of them (the
    running one and the queued ones alike) with NPMGUARD-0031."""
    pipeline, sessions, stream = rig.pipeline, rig.sessions, rig.stream
    wide = AuditService(pipeline, sessions, stream, queue_size=5)
    ids = []
    for name in ("pkg-q1", "pkg-q2", "pkg-q3"):
        session, future, _ = await wide.enqueue(name, "1.0.0")  # worker never started
        future.cancel()
        ids.append(session.audit_id)
    # simulate the hard restart: a NEW service instance (empty in-memory queue)
    # over the same durable store
    fresh = AuditService(pipeline, sessions, stream, queue_size=2)
    await fresh.start()
    try:
        for audit_id in ids:
            assert (await sessions.get(audit_id)).status == "error"
            events = await stream.read_after(audit_channel(audit_id), -1)
            assert [event["type"] for event in events] == ["audit_error"]
            assert events[0]["data"]["code"] == "NPMGUARD-0031"
    finally:
        async with asyncio.timeout(WAIT_SECONDS):
            await fresh.close()


async def test_concurrent_enqueue_at_one_free_slot_pinned(rig) -> None:
    """C14 — PINNED check-then-act: two concurrent enqueues into one free slot
    (queue_size=2, one occupied, worker never started) BOTH pass the full()
    check — the winner enqueues, the loser blocks unboundedly inside put() with
    its session already created (counting toward the cap) instead of getting a
    QueueFullError. Deterministic: each enqueue suspends at sessions.create,
    so both full() checks run before either put()."""
    service, sessions = rig.service, rig.sessions
    _, occupied_future, _ = await service.enqueue("pkg-occupied", "1.0.0")

    racer_a = asyncio.create_task(service.enqueue("pkg-race-a", "1.0.0"))
    racer_b = asyncio.create_task(service.enqueue("pkg-race-b", "1.0.0"))
    done, pending = await asyncio.wait(
        {racer_a, racer_b}, timeout=CLOSE_STALL_OBSERVATION_SECONDS
    )
    assert len(done) == 1 and len(pending) == 1  # winner returned, loser is stuck
    winner = done.pop().result()
    winner[1].cancel()
    loser = pending.pop()
    # The loser's session already exists and counts toward the cap while the
    # coroutine is wedged in put() — three running rows for a queue of two.
    assert len(await sessions.running()) == 3
    loser.cancel()
    with pytest.raises(asyncio.CancelledError):
        await loser
    occupied_future.cancel()


async def test_close_mid_queued_item_leaves_future_unresolved_pinned(rig) -> None:
    """C15 — PINNED: close() while the WORKER is executing a queued item cancels
    _execute through the worker task — the item's future never resolves and its
    session stays 'running'; only the NEXT start() recovers it as a 0031. A
    caller awaiting the future of a shut-down service waits forever (pin)."""
    service, pipeline, sessions, stream = rig.service, rig.pipeline, rig.sessions, rig.stream
    pipeline.blockers["pkg-mid-item"] = asyncio.Event()
    await service.start()
    session, future, _ = await service.enqueue("pkg-mid-item", "1.0.0")
    async with asyncio.timeout(WAIT_SECONDS):
        await pipeline.first_started.wait()  # the worker holds the item mid-execute

    async with asyncio.timeout(WAIT_SECONDS):
        await service.close()  # queued path: close() returns despite the stall
    assert not future.done()  # pinned: the future is orphaned, never resolved
    assert (await sessions.get(session.audit_id)).status == "running"

    await service.start()  # restart recovery is the designed repair path
    assert (await sessions.get(session.audit_id)).status == "error"
    events = await stream.read_after(audit_channel(session.audit_id), -1)
    assert [event["type"] for event in events] == ["audit_error"]
    assert events[0]["data"]["code"] == "NPMGUARD-0031"
    assert not future.done()  # still unresolved even after recovery


async def test_close_stalls_on_inflight_launch_pinned(rig) -> None:
    """C13 — PINNED (UNENFORCED): close() gathers in-flight launched tasks with
    no bound, so one stalled audit stalls shutdown. Observed with a bounded wait
    (close not done after the observation window), then released to completion."""
    service, pipeline, sessions = rig.service, rig.pipeline, rig.sessions
    pipeline.blockers["pkg-stalled"] = asyncio.Event()
    await service.start()
    session = await sessions.create("pkg-stalled", "1.0.0")
    service.launch(session)
    async with asyncio.timeout(WAIT_SECONDS):
        await pipeline.first_started.wait()  # the stalled audit is definitely in-flight

    closer = asyncio.create_task(service.close())
    done, pending = await asyncio.wait({closer}, timeout=CLOSE_STALL_OBSERVATION_SECONDS)
    assert closer in pending, "close() returned while an audit was stalled — pin broken"
    pipeline.blockers["pkg-stalled"].set()
    async with asyncio.timeout(WAIT_SECONDS):
        await closer


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
    SAME transaction as running->done — so these probes run with NO poll (the
    e2e waits in tests/support/waits.py are now redundant)."""
    service, sessions, stream = rig.service, rig.sessions, rig.stream
    session = await sessions.create("pkg-coherent", "1.0.0")
    service.launch(session)
    events = await _first_terminal_observation(stream, session.audit_id)
    assert [event["type"] for event in events] == ["verdict_reached"]
    assert events[0]["data"]["verdict"] == "SAFE"
    # instant probes — the invariant forbids any wait after the frame:
    restored = await sessions.get(session.audit_id)
    assert restored.status == "done"
    assert restored.report is not None
    persisted = tmp_path / "reports" / "pkg-coherent" / "1.0.0.json"
    assert persisted.is_file()  # S29's flaking probe, now unpolled
    assert json.loads(persisted.read_text(encoding="utf-8"))["verdict"] == "SAFE"


async def test_save_failure_lands_as_error_and_still_cleans_up(rig, monkeypatch) -> None:
    """C17 — INVARIANT: a save_report failure surfaces as running->error with a
    single audit_error and NO verdict_reached — the old code finalized 'done'
    before saving, then flipped the row done->error and skipped cleanup() (not
    in a finally). The workspace cleanup must run regardless."""
    service, pipeline, sessions, stream = rig.service, rig.pipeline, rig.sessions, rig.stream

    def _boom(*_args: Any, **_kwargs: Any) -> str:
        raise RuntimeError("disk full")

    monkeypatch.setattr("npmguard.service.save_report", _boom)
    await service.start()
    session, future, _ = await service.enqueue("pkg-savefail", "1.0.0")
    async with asyncio.timeout(WAIT_SECONDS):
        with pytest.raises(RuntimeError, match="disk full"):
            await future
    restored = await sessions.get(session.audit_id)
    assert restored.status == "error"  # never 'done' without a durable report
    assert restored.error == "disk full"
    events = await stream.read_after(audit_channel(session.audit_id), -1)
    kinds = [event["type"] for event in events]
    assert "verdict_reached" not in kinds  # save failed BEFORE the terminal txn
    assert kinds.count("audit_error") == 1
    assert pipeline.results["pkg-savefail"].cleaned  # finally: no workspace leak
