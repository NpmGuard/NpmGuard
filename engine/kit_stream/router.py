"""SSE endpoint. Cursor comes from `?since=` or the standard Last-Event-ID
header (native EventSource reconnects send it automatically); both mean
"I have everything up to and including this seq"."""

from collections.abc import Sequence
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from kit_spine import ValidationFailed
from kit_spine.ports import CHANNEL_PATTERN
from kit_stream.service import StreamService

DEFAULT_HEARTBEAT = 15.0


def make_stream_router(
    service: StreamService,
    heartbeat: float = DEFAULT_HEARTBEAT,
    dependencies: Sequence[Any] | None = None,
) -> APIRouter:
    # Plain FastAPI passthrough: apps plug auth's dependency in here.
    # Stream never knows auth exists (rule 2 — modules compose in the app).
    router = APIRouter(dependencies=list(dependencies) if dependencies else None)

    @router.get("/streams/{channel}")
    async def stream(channel: str, request: Request, since: int | None = None) -> StreamingResponse:
        if not CHANNEL_PATTERN.match(channel):
            raise ValidationFailed(f"invalid channel name: {channel!r}")
        cursor = since
        if cursor is None:
            last_event_id = request.headers.get("last-event-id")
            if last_event_id is not None:
                try:
                    cursor = int(last_event_id)
                except ValueError:
                    raise ValidationFailed("last-event-id must be an integer seq") from None
        return StreamingResponse(
            service.sse(channel, after=cursor if cursor is not None else -1, heartbeat=heartbeat),
            media_type="text/event-stream",
            headers={"cache-control": "no-cache", "x-accel-buffering": "no"},
        )

    return router
