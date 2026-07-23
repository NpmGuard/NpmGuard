import json
from collections.abc import AsyncIterator
from typing import Any

from pydantic import BaseModel

from kit_stream import StreamService
from kit_stream.service import READ_BATCH

TERMINAL_EVENTS = frozenset({"verdict_reached", "audit_error"})


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


class AuditEmitter:
    def __init__(self, audit_id: str, stream: StreamService) -> None:
        self.audit_id = audit_id
        self._stream = stream

    async def emit(self, event_type: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        return await self._stream.append(
            audit_channel(self.audit_id), event_type, _json_value(payload or {})
        )


def _wire_event(audit_id: str, envelope: dict[str, Any]) -> dict[str, Any]:
    data = envelope.get("data")
    payload = dict(data) if isinstance(data, dict) else {}
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
) -> AsyncIterator[str]:
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
