"""Bounded SSE client for the engine's /audit/{id}/events stream.

Parses ``id:``/``event:``/``data:`` frames, tolerates ``: keep-alive`` comment
heartbeats, stops on terminal events, and supports cursor resume via both the
``Last-Event-ID`` header and the ``?since=`` query parameter. Every collection
is bounded by a named, generous deadline — never an unbounded read.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

import httpx

TERMINAL_EVENT_TYPES = frozenset({"verdict_reached", "audit_error"})
STREAM_DEADLINE_SECONDS = 120.0
CONNECT_TIMEOUT_SECONDS = 10.0


@dataclass(frozen=True)
class SseFrame:
    id: int | None
    event: str | None
    data: dict[str, Any] | None
    comment: str | None = None

    @property
    def is_heartbeat(self) -> bool:
        return self.data is None and self.comment is not None

    @property
    def type(self) -> str | None:
        """Event type from the wire payload (falls back to the ``event:`` field)."""
        if self.data is not None and isinstance(self.data.get("type"), str):
            return self.data["type"]
        return self.event


async def iter_frames(
    base_url: str,
    audit_id: str,
    *,
    since: int | None = None,
    last_event_id: int | None = None,
    deadline: float = STREAM_DEADLINE_SECONDS,
) -> AsyncIterator[SseFrame]:
    """Yield frames from the audit event stream until the server closes it.

    The read timeout equals ``deadline`` so a silent stream cannot hang longer
    than the caller's bound even without heartbeats.
    """
    params = {"since": str(since)} if since is not None else None
    headers = {"Last-Event-ID": str(last_event_id)} if last_event_id is not None else None
    timeout = httpx.Timeout(CONNECT_TIMEOUT_SECONDS, read=deadline)
    async with (
        httpx.AsyncClient(timeout=timeout) as client,
        client.stream(
            "GET", f"{base_url}/audit/{audit_id}/events", params=params, headers=headers
        ) as response,
    ):
        response.raise_for_status()
        frame_id: int | None = None
        frame_event: str | None = None
        data_lines: list[str] = []
        comment: str | None = None
        async for line in response.aiter_lines():
            if line == "":
                if data_lines or comment is not None:
                    data = json.loads("\n".join(data_lines)) if data_lines else None
                    yield SseFrame(frame_id, frame_event, data, comment)
                frame_id = None
                frame_event = None
                data_lines = []
                comment = None
                continue
            if line.startswith(":"):
                comment = line[1:].strip()
                continue
            field, _, value = line.partition(":")
            value = value.removeprefix(" ")
            if field == "id":
                frame_id = int(value) if value.lstrip("-").isdigit() else None
            elif field == "event":
                frame_event = value
            elif field == "data":
                data_lines.append(value)
        if data_lines or comment is not None:  # stream closed without trailing blank line
            data = json.loads("\n".join(data_lines)) if data_lines else None
            yield SseFrame(frame_id, frame_event, data, comment)


async def collect_frames(
    base_url: str,
    audit_id: str,
    *,
    since: int | None = None,
    last_event_id: int | None = None,
    until_terminal: bool = True,
    include_heartbeats: bool = False,
    deadline: float = STREAM_DEADLINE_SECONDS,
) -> list[SseFrame]:
    """Collect frames until a terminal event (or stream close), bounded by deadline."""
    frames: list[SseFrame] = []
    async with asyncio.timeout(deadline):
        async for frame in iter_frames(
            base_url, audit_id, since=since, last_event_id=last_event_id, deadline=deadline
        ):
            if frame.is_heartbeat:
                if include_heartbeats:
                    frames.append(frame)
                continue
            frames.append(frame)
            if until_terminal and frame.type in TERMINAL_EVENT_TYPES:
                break
    return frames


def event_types(frames: list[SseFrame]) -> list[str]:
    """Ordered event-type sequence (heartbeats excluded) — skeleton-comparable."""
    return [frame.type for frame in frames if not frame.is_heartbeat and frame.type]


def find_frame(frames: list[SseFrame], event_type: str) -> SseFrame | None:
    return next((frame for frame in frames if frame.type == event_type), None)


def find_frames(frames: list[SseFrame], event_type: str) -> list[SseFrame]:
    return [frame for frame in frames if frame.type == event_type]


def terminal_frame(frames: list[SseFrame]) -> SseFrame | None:
    return next((frame for frame in frames if frame.type in TERMINAL_EVENT_TYPES), None)
