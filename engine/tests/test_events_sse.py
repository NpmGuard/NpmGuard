# CLASS MAP — events.AuditEmitter + sse_events wire/cursor/mode semantics
# (seams: StreamService over a throwaway sqlite DB + PollingNotifier; follow-mode
#  classes consume the sse_events async generator in-process — kit: ASGITransport
#  cannot live-follow; the uvicorn seam itself is e2e S11-S15. Route-layer classes
#  C4/C5a/C16 use TestClient over a completed NPMGUARD_MOCK_LLM audit.)
# Wire:   C1  frame = id:/event:/data: lines; payload FLATTENED into the envelope;
#             auditId/timestamp/seq present in data
#         C2  payload key collision (type/seq) → PINNED precedence: payload wins inside
#             data JSON; the SSE id:/event: lines keep the envelope's seq/type
#         C2b payload normalization: BaseModel / nested dict-of-model / tuple values
#             serialize to plain JSON on the wire (_json_value seam)
# Cursor: C3  no cursor → full replay
#         C4  Last-Event-ID header beats ?since (route layer)
#         C5  invalid cursors: non-int → -1 full replay (route); negative → full
#             replay; beyond-head → empty, no stall (generator level)
#         C6  mid-stream cursor → strictly-after events only, no duplicates
#         C7  cursor == last seq → empty replay, immediate close (no follow)
# Modes:  C8  finished session → replay-only then close; never waits a heartbeat (C16 claim)
#         C9  running → replay-then-follow; HTTP body ends at verdict_reached
#         C10 follow ends at audit_error too
#         C11 emit-before-finalize window: terminal event already in the log when a
#             follow stream connects → delivered from replay, stream still terminates
# Bounds: C12 heartbeat comments at the injected interval on follow; never on replay-only
#         C13 batch boundary: exactly 500 and 501 events replay ordered, no dup, no stall
#             (READ_BATCH is imported from kit_stream — the drift pair is dead; pinned)
# Fanout: C14 two concurrent followers see identical sequences [sqlite; postgres variant
#             gated on NPMGUARD_TEST_PG_DSN — the notifier implementation differs]
#         C15 events durable: full replay from a FRESH engine over the same DB file
# API:    C16 unknown audit id → 404 (route layer)
# Adversarial pass: W5 2026-07-23 — "can a follower hang forever on a finished
#   audit?" → C8/C11 bound replay-only and terminal-in-replay completion; every
#   follow consumer runs under asyncio.timeout.
import asyncio
import json
import os
from typing import Any

import pytest
from fastapi.testclient import TestClient

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from kit_stream.service import READ_BATCH
from npmguard import events as events_module
from npmguard.events import AuditEmitter, audit_channel, sse_events

DRAIN_SECONDS = 15  # generous bound for any full stream drain
HEARTBEAT_INTERVAL = 0.2  # injected — never the 15s production default
AUDIT_ID = "aud1"

pg_gate = pytest.mark.skipif(
    not os.environ.get("NPMGUARD_TEST_PG_DSN"),
    reason=(
        "postgres fanout class needs NPMGUARD_TEST_PG_DSN — the LISTEN/NOTIFY "
        "notifier differs from the sqlite polling notifier"
    ),
)


@pytest.fixture
async def rig(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'events.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    stream = StreamService(make_session_factory(engine), PollingNotifier())
    yield stream, AuditEmitter(AUDIT_ID, stream)
    await engine.dispose()


def _parse(frame: str) -> dict[str, Any]:
    if frame.startswith(":"):
        return {"comment": frame.strip()}
    parsed: dict[str, Any] = {}
    for line in frame.splitlines():
        if line.startswith("id: "):
            parsed["id"] = int(line.removeprefix("id: "))
        elif line.startswith("event: "):
            parsed["event"] = line.removeprefix("event: ")
        elif line.startswith("data: "):
            parsed["data"] = json.loads(line.removeprefix("data: "))
    return parsed


async def _drain(generator, *, deadline: float = DRAIN_SECONDS) -> list[dict[str, Any]]:
    frames = []
    async with asyncio.timeout(deadline):
        async for frame in generator:
            frames.append(_parse(frame))
    return frames


async def test_wire_format_flattens_payload_into_envelope(rig) -> None:
    """C1: each frame carries id:/event:/data: lines; data is the envelope
    (type/auditId/timestamp/seq) with the payload keys FLATTENED beside them."""
    stream, emitter = rig
    await emitter.emit("phase_started", {"phase": "resolve"})
    frames = await _drain(sse_events(AUDIT_ID, stream, follow=False))
    assert len(frames) == 1
    frame = frames[0]
    assert frame["id"] == 0
    assert frame["event"] == "phase_started"
    data = frame["data"]
    assert data["type"] == "phase_started"
    assert data["auditId"] == AUDIT_ID
    assert data["seq"] == 0
    assert isinstance(data["timestamp"], str) and data["timestamp"]
    assert data["phase"] == "resolve"  # payload key sits beside envelope keys


async def test_payload_collision_precedence_pinned(rig) -> None:
    """C2 — PINNED precedence: payload keys named type/seq overwrite the envelope
    copy inside the data JSON, while the SSE id:/event: lines keep the envelope's
    real seq and type."""
    stream, emitter = rig
    await emitter.emit("real_event", {"type": "spoofed", "seq": 999})
    frame = (await _drain(sse_events(AUDIT_ID, stream, follow=False)))[0]
    assert frame["id"] == 0  # envelope wins on the wire framing
    assert frame["event"] == "real_event"
    assert frame["data"]["type"] == "spoofed"  # payload wins inside data
    assert frame["data"]["seq"] == 999


async def test_payload_normalizes_models_and_tuples(rig) -> None:
    """C2b: a payload holding a BaseModel, a nested dict containing a model, and
    a tuple round-trips to plain JSON on the wire — a payload shape that stops
    serializing would otherwise only surface as an opaque emit crash mid-audit."""
    from pydantic import BaseModel

    class _Counts(BaseModel):
        total: int
        confirmed: int

    stream, emitter = rig
    await emitter.emit(
        "verdict_reached",
        {
            "counts": _Counts(total=2, confirmed=1),
            "nested": {"inner": _Counts(total=0, confirmed=0)},
            "pair": ("a", 1),
        },
    )
    frame = (await _drain(sse_events(AUDIT_ID, stream, follow=False)))[0]
    data = frame["data"]
    assert data["counts"] == {"total": 2, "confirmed": 1}
    assert data["nested"] == {"inner": {"total": 0, "confirmed": 0}}
    assert data["pair"] == ["a", 1]  # tuples normalize to JSON arrays


async def test_no_cursor_full_replay(rig) -> None:
    """C3: the default cursor (-1) replays every event in order."""
    stream, emitter = rig
    for index in range(3):
        await emitter.emit("progress", {"index": index})
    frames = await _drain(sse_events(AUDIT_ID, stream, follow=False))
    assert [frame["id"] for frame in frames] == [0, 1, 2]
    assert [frame["data"]["index"] for frame in frames] == [0, 1, 2]


async def test_invalid_cursor_shapes_at_generator_level(rig) -> None:
    """C5 (generator half): a negative cursor behaves as full replay; a cursor
    beyond the head yields nothing and terminates immediately (no stall)."""
    stream, emitter = rig
    await emitter.emit("progress", {"index": 0})
    negative = await _drain(sse_events(AUDIT_ID, stream, after=-5, follow=False))
    assert [frame["id"] for frame in negative] == [0]
    beyond = await _drain(sse_events(AUDIT_ID, stream, after=10**9, follow=False))
    assert beyond == []


async def test_mid_stream_cursor_strictly_after(rig) -> None:
    """C6: replay from a mid-stream cursor yields only strictly-later events,
    never a duplicate of the cursor event."""
    stream, emitter = rig
    for index in range(4):
        await emitter.emit("progress", {"index": index})
    frames = await _drain(sse_events(AUDIT_ID, stream, after=1, follow=False))
    assert [frame["id"] for frame in frames] == [2, 3]


async def test_cursor_at_head_replays_nothing(rig) -> None:
    """C7: a cursor equal to the last seq replays nothing and closes at once."""
    stream, emitter = rig
    await emitter.emit("progress", {"index": 0})
    await emitter.emit("progress", {"index": 1})
    frames = await _drain(sse_events(AUDIT_ID, stream, after=1, follow=False))
    assert frames == []


async def test_finished_session_replay_only_never_waits(rig) -> None:
    """C8 (claim C16): follow=False drains and closes without ever waiting a
    heartbeat interval — proven by draining well inside the default 15s
    heartbeat — and emits zero comment frames."""
    stream, emitter = rig
    await emitter.emit("verdict_reached", {"verdict": "SAFE"})
    frames = await _drain(sse_events(AUDIT_ID, stream, follow=False), deadline=5)
    assert [frame["event"] for frame in frames] == ["verdict_reached"]
    assert not any("comment" in frame for frame in frames)


async def test_follow_replays_then_ends_at_verdict(rig) -> None:
    """C9: a follow stream replays history, then delivers live events, and the
    generator terminates at verdict_reached."""
    stream, emitter = rig
    await emitter.emit("phase_started", {"phase": "resolve"})
    consumer = asyncio.create_task(
        _drain(sse_events(AUDIT_ID, stream, follow=True, heartbeat=HEARTBEAT_INTERVAL))
    )
    await asyncio.sleep(0.05)  # let the consumer subscribe; correctness never depends on this
    await emitter.emit("file_flagged", {"file": "index.js"})
    await emitter.emit("verdict_reached", {"verdict": "DANGEROUS"})
    frames = await asyncio.wait_for(consumer, DRAIN_SECONDS)
    kinds = [frame["event"] for frame in frames if "event" in frame]
    assert kinds == ["phase_started", "file_flagged", "verdict_reached"]


async def test_follow_ends_at_audit_error(rig) -> None:
    """C10: audit_error is terminal for a follow stream exactly like a verdict."""
    stream, emitter = rig
    consumer = asyncio.create_task(
        _drain(sse_events(AUDIT_ID, stream, follow=True, heartbeat=HEARTBEAT_INTERVAL))
    )
    await emitter.emit("audit_error", {"error": "boom", "code": "NPMGUARD-9999"})
    frames = await asyncio.wait_for(consumer, DRAIN_SECONDS)
    kinds = [frame["event"] for frame in frames if "event" in frame]
    assert kinds == ["audit_error"]


async def test_terminal_event_in_replay_still_terminates_follow(rig) -> None:
    """C11 (emit-before-finalize window): the verdict is already in the log when
    a follow stream connects (session row not yet flipped) → the verdict arrives
    from replay and the stream still terminates instead of following forever."""
    stream, emitter = rig
    await emitter.emit("phase_started", {"phase": "resolve"})
    await emitter.emit("verdict_reached", {"verdict": "SAFE"})
    frames = await _drain(
        sse_events(AUDIT_ID, stream, follow=True, heartbeat=HEARTBEAT_INTERVAL)
    )
    kinds = [frame["event"] for frame in frames if "event" in frame]
    assert kinds == ["phase_started", "verdict_reached"]


async def test_heartbeat_comments_only_on_follow(rig) -> None:
    """C12: with an injected 0.2s interval, an idle follow stream yields
    ': keep-alive' comments between events; the replay-only path never does."""
    stream, emitter = rig
    await emitter.emit("phase_started", {"phase": "resolve"})
    generator = sse_events(AUDIT_ID, stream, follow=True, heartbeat=HEARTBEAT_INTERVAL)
    try:
        async with asyncio.timeout(DRAIN_SECONDS):
            first = _parse(await anext(generator))
            second = _parse(await anext(generator))
    finally:
        await generator.aclose()
    assert first["event"] == "phase_started"
    assert second == {"comment": ": keep-alive"}
    replay_only = await _drain(sse_events(AUDIT_ID, stream, follow=False))
    assert not any("comment" in frame for frame in replay_only)


async def test_batch_boundary_500_and_501(rig) -> None:
    """C13: replays of exactly READ_BATCH (500) and READ_BATCH+1 events cross the
    batch boundary in order with no duplicates and no stall. READ_BATCH here IS
    kit_stream's constant (import), pinning the former drift pair dead."""
    assert READ_BATCH == 500
    assert events_module.READ_BATCH is READ_BATCH  # single shared constant
    stream, _ = rig
    for audit_id, count in (("batch500", READ_BATCH), ("batch501", READ_BATCH + 1)):
        channel = audit_channel(audit_id)
        for index in range(count):
            await stream.append(channel, "progress", {"index": index})
        frames = await _drain(sse_events(audit_id, stream, follow=False), deadline=60)
        assert [frame["id"] for frame in frames] == list(range(count))


async def test_two_followers_see_identical_sequences(rig) -> None:
    """C14 (sqlite/polling notifier): two concurrent follow consumers observe the
    exact same ordered frames through to the terminal event."""
    stream, emitter = rig
    consumers = [
        asyncio.create_task(
            _drain(sse_events(AUDIT_ID, stream, follow=True, heartbeat=HEARTBEAT_INTERVAL))
        )
        for _ in range(2)
    ]
    await asyncio.sleep(0.05)
    for index in range(3):
        await emitter.emit("progress", {"index": index})
    await emitter.emit("verdict_reached", {"verdict": "SAFE"})
    first, second = await asyncio.wait_for(asyncio.gather(*consumers), DRAIN_SECONDS)
    events_only = [
        [(frame["id"], frame["event"]) for frame in frames if "event" in frame]
        for frames in (first, second)
    ]
    assert events_only[0] == events_only[1]
    assert events_only[0][-1][1] == "verdict_reached"


@pytest.mark.postgres
@pg_gate
async def test_two_followers_identical_sequences_postgres() -> None:
    """C14 (postgres): same fanout guarantee through the LISTEN/NOTIFY notifier —
    the implementation that actually differs from sqlite's polling."""
    from kit_spine.notify_postgres import PostgresNotifier
    from tests.support.harness import PostgresProvisioner

    provisioner = PostgresProvisioner.start()
    url = provisioner.fresh_database()
    engine = make_engine(url)
    notifier = PostgresNotifier(url)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
        await notifier.start()
        stream = StreamService(make_session_factory(engine), notifier)
        emitter = AuditEmitter(AUDIT_ID, stream)
        consumers = [
            asyncio.create_task(
                _drain(sse_events(AUDIT_ID, stream, follow=True, heartbeat=HEARTBEAT_INTERVAL))
            )
            for _ in range(2)
        ]
        await asyncio.sleep(0.1)
        for index in range(3):
            await emitter.emit("progress", {"index": index})
        await emitter.emit("verdict_reached", {"verdict": "SAFE"})
        first, second = await asyncio.wait_for(asyncio.gather(*consumers), DRAIN_SECONDS)
        events_only = [
            [(frame["id"], frame["event"]) for frame in frames if "event" in frame]
            for frames in (first, second)
        ]
        assert events_only[0] == events_only[1]
        assert events_only[0][-1][1] == "verdict_reached"
    finally:
        await notifier.close()
        await engine.dispose()
        provisioner.stop()


async def test_events_durable_across_engine_instances(tmp_path) -> None:
    """C15: events written through one engine replay in full from a brand-new
    engine over the same database file — the log is durable, not process state."""
    path = tmp_path / "durable.sqlite3"
    engine = make_engine(f"sqlite+aiosqlite:///{path}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    emitter = AuditEmitter(AUDIT_ID, StreamService(make_session_factory(engine), PollingNotifier()))
    await emitter.emit("phase_started", {"phase": "resolve"})
    await emitter.emit("verdict_reached", {"verdict": "SAFE"})
    await engine.dispose()

    reopened = make_engine(f"sqlite+aiosqlite:///{path}")
    try:
        stream = StreamService(make_session_factory(reopened), PollingNotifier())
        frames = await _drain(sse_events(AUDIT_ID, stream, follow=False))
        assert [frame["event"] for frame in frames] == ["phase_started", "verdict_reached"]
    finally:
        await reopened.dispose()


# ── Route layer (TestClient over a completed NPMGUARD_MOCK_LLM audit) ─────────


@pytest.fixture(scope="module")
def route_client(tmp_path_factory):
    from npmguard.api import create_app
    from npmguard.config import get_settings

    tmp = tmp_path_factory.mktemp("events-route")
    patcher = pytest.MonkeyPatch()
    patcher.setattr("npmguard.report_store.DATA_DIR", tmp / "reports")
    patcher.setenv("NPMGUARD_ENV", "test")
    patcher.setenv("NPMGUARD_PAYMENT_REQUIRED", "false")
    patcher.setenv("NPMGUARD_MOCK_LLM", "true")
    patcher.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp / "audit-logs"))
    patcher.setenv("NPMGUARD_DATABASE_URL", f"sqlite+aiosqlite:///{tmp / 'route.sqlite3'}")
    get_settings.cache_clear()
    client = TestClient(create_app())
    with client:
        import time

        audit_id = client.post(
            "/audit/stream", json={"packageName": "test-pkg-child-success"}
        ).json()["auditId"]
        # Same 30s deadline style as test_api.REPORT_DEADLINE_SECONDS — a 5s
        # bound flaked risk on loaded CI for the identical mock-LLM flow.
        deadline = time.monotonic() + 30.0
        while time.monotonic() < deadline:
            if client.get(f"/audit/{audit_id}/report").status_code != 202:
                break
            time.sleep(0.02)
        assert client.get(f"/audit/{audit_id}/report").status_code == 200
        yield client, audit_id
    get_settings.cache_clear()
    patcher.undo()


def _route_frames(client: TestClient, audit_id: str, **request: Any) -> list[dict[str, Any]]:
    response = client.get(f"/audit/{audit_id}/events", **request)
    assert response.status_code == 200
    return [
        _parse(chunk + "\n\n") for chunk in response.text.split("\n\n") if chunk.strip()
    ]


def test_last_event_id_header_beats_since_param(route_client) -> None:
    """C4 (route): when both cursors are present, the Last-Event-ID header wins
    over the ?since query parameter."""
    client, audit_id = route_client
    full = _route_frames(client, audit_id)
    assert len(full) >= 2
    last = full[-1]["id"]
    header_wins = _route_frames(
        client,
        audit_id,
        params={"since": -1},
        headers={"Last-Event-ID": str(last - 1)},
    )
    assert [frame["id"] for frame in header_wins] == [last]


def test_non_integer_cursor_falls_back_to_full_replay(route_client) -> None:
    """C5 (route): an unparseable cursor value degrades to -1 → full replay,
    never a 4xx or a crash."""
    client, audit_id = route_client
    full = _route_frames(client, audit_id)
    garbled = _route_frames(client, audit_id, params={"since": "not-a-number"})
    assert [frame["id"] for frame in garbled] == [frame["id"] for frame in full]


def test_unknown_audit_events_is_404(route_client) -> None:
    """C16: the events route refuses an unknown audit id with 404 before any
    stream is opened."""
    client, _ = route_client
    response = client.get("/audit/00000000-0000-0000-0000-000000000000/events")
    assert response.status_code == 404
    assert response.json() == {"error": "Audit session not found"}
