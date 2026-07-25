import json
from collections.abc import AsyncGenerator
from typing import Any, Protocol

from pydantic import BaseModel

from kit_stream import StreamService
from kit_stream.service import READ_BATCH

TERMINAL_EVENTS = frozenset({"verdict_reached", "audit_error"})
# The four fields _wire_event stamps on every SSE frame from the durable
# envelope. `type` is the discriminator of the event union
# (shared/src/events.ts: AuditEventSchema), so a payload key of the same name
# does not merely duplicate a field — it decides which shape a consumer parses.
ENVELOPE_KEYS = frozenset({"type", "auditId", "timestamp", "seq"})


def _json_value(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", exclude_none=False)
    if isinstance(value, dict):
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def audit_channel(audit_id: str) -> str:
    # Kit notifiers require a Postgres-safe identifier. UUIDs are normalized
    # so the same durable channel works for SQLite polling and LISTEN/NOTIFY.
    return f"audit_{audit_id.replace('-', '')}"


class Emitting(Protocol):
    """The one method the pipeline uses from an emitter.

    Structural, so a caller that only wants the frames — the demo recorder, the
    replay slices — can pass a recorder instead of standing up a StreamService.
    """

    async def emit(
        self, event_type: str, payload: dict[str, Any] | None = None
    ) -> object: ...  # pragma: no cover


class AuditEmitter:
    def __init__(self, audit_id: str, stream: StreamService) -> None:
        self.audit_id = audit_id
        self._stream = stream

    async def emit(self, event_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        body = payload or {}
        # INVARIANT: a payload never carries an ENVELOPE_KEYS name, so flattening
        # it onto the envelope (_wire_event) cannot shadow the envelope's own
        # value. Asserted at the PRODUCER because this is where such a payload
        # would be born: the emit site is in the traceback, the audit errors
        # honestly, and no poisoned row reaches the durable log to break every
        # future reader of that audit's stream. Every one of the 17 declared
        # event shapes keeps its payload fields disjoint from the envelope
        # (shared/src/events.ts), and demo replay strips these four keys off the
        # recorded frames before re-emitting (demo.py) — so nothing legitimate
        # trips this.
        assert not (body.keys() & ENVELOPE_KEYS), (
            f"{event_type} payload would shadow envelope field(s) "
            f"{sorted(body.keys() & ENVELOPE_KEYS)} on audit {self.audit_id}"
        )
        return await self._stream.append(
            audit_channel(self.audit_id), event_type, _json_value(body)
        )


def _wire_event(audit_id: str, envelope: dict[str, Any]) -> dict[str, Any]:
    data = envelope.get("data")
    payload = dict(data) if isinstance(data, dict) else {}
    # INVARIANT: the flattening below is lossless — the envelope always wins
    # because nothing else can claim its four names. Re-asserted on the READ side
    # because a row can reach here from a writer that never went through
    # AuditEmitter (service._finish appends the terminal frame straight to the
    # stream) or from an older engine that wrote the row; a shadowed `type` would
    # otherwise hand the consumer a different event shape than the one the
    # id:/event: framing announces.
    assert not (payload.keys() & ENVELOPE_KEYS), (
        f"event seq={envelope['seq']} type={envelope['type']} on audit {audit_id} "
        f"carries envelope field(s) {sorted(payload.keys() & ENVELOPE_KEYS)} in its payload"
    )
    return {
        "type": envelope["type"],
        "auditId": audit_id,
        "timestamp": envelope["ts"],
        "seq": envelope["seq"],
        **payload,
    }


def _format_event(audit_id: str, envelope: dict[str, Any]) -> str:
    event = _wire_event(audit_id, envelope)
    data = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
    return f"id: {envelope['seq']}\nevent: {envelope['type']}\ndata: {data}\n\n"


async def sse_events(
    audit_id: str,
    stream: StreamService,
    *,
    after: int = -1,
    follow: bool,
    heartbeat: float = 15,
) -> AsyncGenerator[str]:
    channel = audit_channel(audit_id)
    if not follow:
        cursor = after
        while True:
            rows = await stream.read_after(channel, cursor)
            if not rows:
                return
            for envelope in rows:
                cursor = envelope["seq"]
                yield _format_event(audit_id, envelope)
            if len(rows) < READ_BATCH:
                return

    async for frame in stream.sse(channel, after, heartbeat):
        if frame.startswith(":"):
            yield frame
            continue
        data_line = next(line for line in frame.splitlines() if line.startswith("data: "))
        envelope = json.loads(data_line.removeprefix("data: "))
        yield _format_event(audit_id, envelope)
        if envelope["type"] in TERMINAL_EVENTS:
            return
