# CLASS MAP — SSE stream lifecycle over a real uvicorn engine (wire format,
#   replay, resume, fanout, drain, shutdown, batch/heartbeat boundaries)
# Axes: connect time (cold / late / resume / post-finish) × client count ×
#   DB engine (sqlite / postgres notifier) × event volume (batch boundary) ×
#   server lifecycle (running / finished / SIGTERM)
#   S11 cold connect      — legacy wire frames: id==seq, event==type, flat payload,
#                           auditId/timestamp on every frame, contiguous ordering
#   S12 late join         — mid-run connect gets full replay + live tail, identical
#                           to a cold listener's sequence
#   S13 drop → resume     — Last-Event-ID header AND ?since both replay strictly
#                           after the cursor, no duplicates (finished audit);
#                           S13b resumes onto a RUNNING audit (replay→live handoff)
#   S14 concurrent fanout — N clients converge on identical sequences, on sqlite
#                           AND postgres (the notifier implementations differ)
#   S15 finished audit    — replay-only drain: full history, no heartbeats, prompt close
#   S30 SIGTERM + open SSE— graceful close with a live follower attached
#                           (--timeout-graceful-shutdown carries the kit gotcha)
#   S33 batch boundary    — exactly READ_BATCH and READ_BATCH+1 events replay in
#                           order with no dup/stall (pins the events.py drift pair)
#   S34 heartbeat         — keep-alive comments at an injected interval in follow
#                           mode; never on the replay-only path (sse_events seam:
#                           the HTTP route does not expose the interval — see caveat)
# Adversarial pass: W4a — "which classes depend on the notifier?" Only follow-mode
#   ones (S12/S14/S30/S34); replay classes (S13/S15/S33) are read_after-only, so
#   the postgres axis is spent on S14 where the implementations actually diverge.

from __future__ import annotations

import asyncio
import contextlib
import time

import httpx
import pytest

from kit_spine import make_engine, make_notifier, make_session_factory
from kit_spine.db import metadata
from kit_stream import StreamService
from kit_stream.service import READ_BATCH
from npmguard.events import audit_channel, sse_events
from npmguard.persistence import AuditSessionStore
from tests.e2e.llm_mock import MockLlmClient, scripted_safe_roles
from tests.support.harness import sqlite_url
from tests.support.sse import (
    TERMINAL_EVENT_TYPES,
    SseFrame,
    collect_frames,
    event_types,
    iter_frames,
    terminal_frame,
)

pytestmark = pytest.mark.e2e

SAFE_VERDICT_DEADLINE_SECONDS = 120.0
# Delay injected into the scripted flag role so followers provably attach while
# the audit is still running (connect latency is milliseconds against this).
JOIN_WINDOW_DELAY_MS = 2000
DRAIN_DEADLINE_SECONDS = 30.0
DRAIN_MAX_SECONDS = 10.0
SEED_VISIBLE_DEADLINE_SECONDS = 10.0
SEED_POLL_SECONDS = 0.05
HEARTBEAT_INTERVAL_SECONDS = 0.2
INPROC_DEADLINE_SECONDS = 15.0

FILLER_EVENT_TYPE = "triage_progress"


def _safe_roles(flag_delay_ms: int = 0) -> dict:
    roles = scripted_safe_roles()
    if flag_delay_ms:
        roles["flag"] = {"kind": "delay", "delay_ms": flag_delay_ms, "then": roles["flag"]}
    return roles


def _ids(frames: list[SseFrame]) -> list[int]:
    return [frame.id for frame in frames]


def _assert_wire_frame(frame: SseFrame, audit_id: str) -> None:
    assert frame.data is not None
    assert frame.id == frame.data["seq"]
    assert frame.event == frame.data["type"]
    assert frame.data["auditId"] == audit_id
    assert isinstance(frame.data["timestamp"], str) and frame.data["timestamp"]


async def _finished_safe_audit(engine, mock_llm: MockLlmClient) -> tuple[str, list[SseFrame]]:
    """Run one scripted SAFE audit to its terminal event; return (auditId, frames)."""
    started = engine.start_audit("test-pkg-child-success")
    frames = await collect_frames(
        engine.base_url, started["auditId"], deadline=SAFE_VERDICT_DEADLINE_SECONDS
    )
    terminal = terminal_frame(frames)
    assert terminal is not None and terminal.type == "verdict_reached", event_types(frames)
    return started["auditId"], frames


class _DbSeam:
    """Out-of-band access to the ENGINE's database through the public kit/npmguard
    seams (StreamService append + AuditSessionStore), from the test process."""

    def __init__(self, db_url: str) -> None:
        self._db_url = db_url

    async def __aenter__(self) -> _DbSeam:
        self.engine = make_engine(self._db_url)
        factory = make_session_factory(self.engine)
        self.notifier = make_notifier(self._db_url)
        await self.notifier.start()
        self.stream = StreamService(factory, self.notifier)
        self.sessions = AuditSessionStore(factory)
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.notifier.close()
        await self.engine.dispose()


async def test_s11_cold_connect_wire_format(engine_factory, mock_llm: MockLlmClient):
    """S11 [C6]: cold connect delivers legacy-compatible frames — id: mirrors the
    payload seq, event: mirrors the flat payload type, auditId/timestamp present on
    every frame, ids contiguous from 0, phases paired, terminal last."""
    mock_llm.load(scripted_roles=_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url)
    audit_id, frames = await _finished_safe_audit(engine, mock_llm)

    for frame in frames:
        _assert_wire_frame(frame, audit_id)
    assert _ids(frames) == list(range(len(frames)))

    types = event_types(frames)
    # Single-owner rework: audit_enqueued (emitted at submit) is now the head
    # frame; audit_started follows when the worker begins execution.
    assert types[0] == "audit_enqueued"
    assert types[1] == "audit_started"
    assert types[-1] == "verdict_reached"
    # A single-terminal claim over the truncated collection would be a tautology
    # (collect_frames stops at the first terminal) — drain the FULL durable log.
    durable = await collect_frames(
        engine.base_url, audit_id, until_terminal=False, deadline=DRAIN_DEADLINE_SECONDS
    )
    durable_types = event_types(durable)
    assert durable_types.count("verdict_reached") == 1
    assert durable_types[-1] == "verdict_reached"  # terminal is last in the full log too

    # Payloads are FLAT — no nested data envelope on the wire.
    verdict = frames[-1]
    assert {"verdict", "rationale", "counts"} <= verdict.data.keys()
    assert set(verdict.data["counts"]) == {
        "total", "open", "inProgress", "confirmed", "refuted", "deferred",
    }
    assert "data" not in verdict.data
    for frame in frames:
        if frame.type in ("phase_started", "phase_completed"):
            assert isinstance(frame.data["phase"], str)

    # Every phase_completed has a preceding phase_started for the same phase.
    open_phases: list[str] = []
    for frame in frames:
        if frame.type == "phase_started":
            open_phases.append(frame.data["phase"])
        elif frame.type == "phase_completed":
            assert frame.data["phase"] in open_phases
            open_phases.remove(frame.data["phase"])


async def test_s12_late_join_full_replay_plus_tail(engine_factory, mock_llm: MockLlmClient):
    """S12 [C16]: a client connecting mid-run receives the full replay of earlier
    events PLUS the live tail, identical to the cold listener's sequence."""
    mock_llm.load(scripted_roles=_safe_roles(flag_delay_ms=JOIN_WINDOW_DELAY_MS))
    engine = engine_factory(llm_url=mock_llm.v1_url)
    started = engine.start_audit("test-pkg-child-success")
    audit_id = started["auditId"]

    cold_frames: list[SseFrame] = []
    late_task: asyncio.Task | None = None
    async with asyncio.timeout(SAFE_VERDICT_DEADLINE_SECONDS):
        async for frame in iter_frames(engine.base_url, audit_id):
            if frame.is_heartbeat:
                continue
            cold_frames.append(frame)
            if frame.type == "intent_extracted" and late_task is None:
                # The flag phase is still >= JOIN_WINDOW_DELAY_MS away from
                # completing — the late client attaches while running.
                late_task = asyncio.create_task(
                    collect_frames(
                        engine.base_url, audit_id, deadline=SAFE_VERDICT_DEADLINE_SECONDS
                    )
                )
            if frame.type in TERMINAL_EVENT_TYPES:
                break

    assert late_task is not None, event_types(cold_frames)
    late_frames = await late_task
    assert event_types(cold_frames)[-1] == "verdict_reached"
    assert _ids(late_frames) == _ids(cold_frames)
    assert event_types(late_frames) == event_types(cold_frames)
    # Replay part: events emitted BEFORE the join; tail part: the terminal event.
    # audit_enqueued (seq 0, emitted at submit) is the head of the full replay.
    assert event_types(late_frames)[0] == "audit_enqueued"
    assert event_types(late_frames)[-1] == "verdict_reached"


async def test_s13_resume_via_last_event_id_and_since(engine_factory, mock_llm: MockLlmClient):
    """S13 [C16]: after a drop, resuming with Last-Event-ID and with ?since both
    replay strictly-after the cursor with no duplicates."""
    mock_llm.load(scripted_roles=_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url)
    audit_id, full = await _finished_safe_audit(engine, mock_llm)

    cursor = full[len(full) // 2].id
    expected_ids = [frame.id for frame in full if frame.id > cursor]
    assert expected_ids, "cursor must leave a tail to resume"

    resumed_header = await collect_frames(
        engine.base_url, audit_id, last_event_id=cursor, deadline=SAFE_VERDICT_DEADLINE_SECONDS
    )
    resumed_query = await collect_frames(
        engine.base_url, audit_id, since=cursor, deadline=SAFE_VERDICT_DEADLINE_SECONDS
    )
    for resumed in (resumed_header, resumed_query):
        assert _ids(resumed) == expected_ids  # strictly-after, ordered, no dupes
        assert min(_ids(resumed)) > cursor
        assert resumed[-1].type == "verdict_reached"


async def test_s13b_resume_onto_running_audit(engine_factory, mock_llm: MockLlmClient):
    """S13 [C16] follow-mode half: resuming with Last-Event-ID while the audit is
    STILL RUNNING exercises the replay-from-cursor→live-handoff path (S13 above
    only covers the finished replay-only branch). The resumed stream must carry
    strictly-after ids with no duplicate and no gap through to the terminal."""
    mock_llm.load(scripted_roles=_safe_roles(flag_delay_ms=JOIN_WINDOW_DELAY_MS))
    engine = engine_factory(llm_url=mock_llm.v1_url)
    started = engine.start_audit("test-pkg-child-success")
    audit_id = started["auditId"]

    # First connection: drop after intent_extracted — the delayed flag phase
    # guarantees the audit is still >= JOIN_WINDOW_DELAY_MS from finishing.
    cursor: int | None = None
    async with asyncio.timeout(SAFE_VERDICT_DEADLINE_SECONDS):
        async for frame in iter_frames(engine.base_url, audit_id):
            if frame.is_heartbeat:
                continue
            if frame.type == "intent_extracted":
                cursor = frame.id
                break
    assert cursor is not None

    resumed = await collect_frames(
        engine.base_url, audit_id, last_event_id=cursor, deadline=SAFE_VERDICT_DEADLINE_SECONDS
    )
    assert resumed and resumed[-1].type == "verdict_reached"
    # Full history from a fresh replay defines the expected strictly-after tail.
    full = await collect_frames(
        engine.base_url, audit_id, deadline=SAFE_VERDICT_DEADLINE_SECONDS
    )
    expected_ids = [frame.id for frame in full if frame.id > cursor]
    assert _ids(resumed) == expected_ids  # no dup, no gap, cursor honored live


@pytest.mark.parametrize(
    "backend",
    [pytest.param("sqlite"), pytest.param("postgres", marks=pytest.mark.postgres)],
)
async def test_s14_concurrent_clients_converge(
    engine_factory, mock_llm: MockLlmClient, tmp_path, request, backend: str
):
    """S14 [C6,C16]: three concurrent followers on a running audit all receive
    identical sequences — on sqlite AND postgres (different notifier paths)."""
    if backend == "sqlite":
        db_url = sqlite_url(tmp_path / "s14.sqlite3")
    else:
        db_url = request.getfixturevalue("pg_provisioner").fresh_database()
    mock_llm.load(scripted_roles=_safe_roles(flag_delay_ms=JOIN_WINDOW_DELAY_MS))
    engine = engine_factory(llm_url=mock_llm.v1_url, db_url=db_url)

    started = engine.start_audit("test-pkg-child-success")
    audit_id = started["auditId"]
    all_frames = await asyncio.gather(
        *(
            collect_frames(engine.base_url, audit_id, deadline=SAFE_VERDICT_DEADLINE_SECONDS)
            for _ in range(3)
        )
    )
    first = all_frames[0]
    assert event_types(first)[-1] == "verdict_reached"
    for other in all_frames[1:]:
        assert _ids(other) == _ids(first)
        assert event_types(other) == event_types(first)


async def test_s15_finished_audit_drains_and_closes(engine_factory, mock_llm: MockLlmClient):
    """S15 [C16]: connecting to a finished audit replays the full history and
    closes promptly — no follow mode, no heartbeats (paired with the positive
    probe that the replay itself is complete and terminal)."""
    mock_llm.load(scripted_roles=_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url)
    audit_id, full = await _finished_safe_audit(engine, mock_llm)

    started_at = time.monotonic()
    drained = await collect_frames(
        engine.base_url,
        audit_id,
        include_heartbeats=True,
        until_terminal=False,  # rely on the server CLOSING the replay-only stream
        deadline=DRAIN_DEADLINE_SECONDS,
    )
    elapsed = time.monotonic() - started_at
    assert elapsed < DRAIN_MAX_SECONDS, f"replay-only stream took {elapsed:.1f}s to close"
    assert not any(frame.is_heartbeat for frame in drained)
    assert _ids(drained) == _ids(full)
    assert drained[-1].type == "verdict_reached"


async def test_s30_sigterm_with_open_sse_is_graceful(engine_factory, mock_llm: MockLlmClient):
    """S30: SIGTERM with a live follower attached exits gracefully within the
    close grace (the spawn carries --timeout-graceful-shutdown — kit's one open
    SSE stream must not block shutdown forever). The follower is attached to an
    out-of-band running session so no in-flight pipeline task is involved
    (that distinct stall class is S31, not covered here)."""
    engine = engine_factory(llm_url=mock_llm.v1_url)
    received: list[SseFrame] = []
    marker_seen = asyncio.Event()

    async def follow(audit_id: str) -> None:
        with contextlib.suppress(httpx.HTTPError):
            async for frame in iter_frames(engine.base_url, audit_id, deadline=60):
                if not frame.is_heartbeat:
                    received.append(frame)
                    marker_seen.set()

    async with _DbSeam(engine.db_url) as seam:
        session = await seam.sessions.create("sse-open-fixture")
        follower = asyncio.create_task(follow(session.audit_id))
        # Prove the follower is attached and live-tailing before the SIGTERM:
        # append a marker and wait (bounded) for it to arrive through the engine.
        await seam.stream.append(
            audit_channel(session.audit_id), "phase_started", {"phase": "marker"}
        )
        async with asyncio.timeout(SEED_VISIBLE_DEADLINE_SECONDS):
            await marker_seen.wait()
        assert received[0].data["phase"] == "marker"

        graceful = engine.close()
        assert graceful is True, engine.stderr_tail()
        follower.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await follower


@pytest.mark.parametrize("count", [READ_BATCH, READ_BATCH + 1])
async def test_s33_replay_batch_boundary(engine_factory, mock_llm: MockLlmClient, count: int):
    """S33 [C6,C16]: a finished channel holding exactly READ_BATCH and
    READ_BATCH+1 events replays fully in order — no duplicate, no stall — across
    the read-batch boundary (pins the events.py literal to kit_stream READ_BATCH)."""
    engine = engine_factory(llm_url=mock_llm.v1_url)
    async with _DbSeam(engine.db_url) as seam:
        session = await seam.sessions.create("batch-boundary-fixture")
        channel = audit_channel(session.audit_id)
        for index in range(count - 1):
            await seam.stream.append(channel, FILLER_EVENT_TYPE, {"index": index})
        await seam.stream.append(channel, "verdict_reached", {"verdict": "SAFE"})
        await seam.sessions.finalize(session.audit_id, {"verdict": "SAFE"})

        frames = await collect_frames(
            engine.base_url,
            session.audit_id,
            until_terminal=False,
            deadline=SAFE_VERDICT_DEADLINE_SECONDS,
        )
    assert len(frames) == count
    assert _ids(frames) == list(range(count))  # ordered, contiguous, no dup, no gap
    assert frames[-1].type == "verdict_reached"
    assert all(frame.type == FILLER_EVENT_TYPE for frame in frames[:-1])


async def test_s34_heartbeat_at_injected_interval(tmp_path):
    """S34 [C6]: sse_events in follow mode emits keep-alive comments at the
    injected interval; the replay-only path never does. In-process at the
    sse_events seam — the HTTP route hardcodes the 15s default (see caveats)."""
    db_url = sqlite_url(tmp_path / "hb.sqlite3")
    engine = make_engine(db_url)
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    notifier = make_notifier(db_url)
    await notifier.start()
    stream = StreamService(make_session_factory(engine), notifier)
    audit_id = "hb-fixture"
    channel = audit_channel(audit_id)
    try:
        await stream.append(channel, "phase_started", {"phase": "resolve"})

        follow_raw: list[str] = []
        finished = False
        generator = sse_events(
            audit_id, stream, after=-1, follow=True, heartbeat=HEARTBEAT_INTERVAL_SECONDS
        )
        async with asyncio.timeout(INPROC_DEADLINE_SECONDS):
            async for raw in generator:
                follow_raw.append(raw)
                if raw.startswith(":") and not finished:
                    # First heartbeat observed: now finish the stream.
                    finished = True
                    await stream.append(channel, "verdict_reached", {"verdict": "SAFE"})
        assert any(frame.startswith(":") for frame in follow_raw)
        assert "event: phase_started" in follow_raw[0]
        assert any("event: verdict_reached" in frame for frame in follow_raw)

        # Negative pair: the replay-only path over the same channel emits the
        # same events but no keep-alive comments, and terminates on its own.
        replay_raw: list[str] = []
        async with asyncio.timeout(INPROC_DEADLINE_SECONDS):
            async for raw in sse_events(
                audit_id, stream, after=-1, follow=False, heartbeat=HEARTBEAT_INTERVAL_SECONDS
            ):
                replay_raw.append(raw)
        assert replay_raw and not any(frame.startswith(":") for frame in replay_raw)
        assert any("event: verdict_reached" in frame for frame in replay_raw)
    finally:
        await notifier.close()
        await engine.dispose()
