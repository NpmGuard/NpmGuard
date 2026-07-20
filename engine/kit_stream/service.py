"""Append + read + SSE generation over the durable log.

Ordering: seq is allocated atomically — a single INSERT ... SELECT
COALESCE(MAX(seq)+1, 0) ... RETURNING seq. SQLite serializes writers, so
allocation never collides there; under Postgres MVCC two concurrent appends
to the same channel can compute the same max, the composite primary key
makes that collide loudly, and append retries with jittered backoff.
(The obvious two-step version — read max, then insert — retry-storms under
concurrency; the slice test caught it.)

Wake-up: notify after commit; subscribers re-query on every wake AND on
heartbeat, so a lost notify self-heals within one heartbeat interval on any
adapter."""

import asyncio
import json
import random
import time
from collections.abc import AsyncIterator
from typing import Any

import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kit_spine import Conflict, now_iso
from kit_spine.ports import EventNotifier, validate_channel
from kit_stream.models import stream_events

APPEND_RETRIES = 10
READ_BATCH = 500


def _envelope(row: sa.Row) -> dict[str, Any]:
    envelope: dict[str, Any] = {"type": row.type, "seq": row.seq, "ts": row.ts}
    if row.data is not None:
        envelope["data"] = row.data
    return envelope


def format_sse(envelope: dict[str, Any]) -> str:
    payload = json.dumps(envelope, separators=(",", ":"))
    return f"id: {envelope['seq']}\ndata: {payload}\n\n"


class StreamService:
    def __init__(
        self,
        session_factory: async_sessionmaker,
        notifier: EventNotifier,
        *,
        read_batch: int = READ_BATCH,
        append_retries: int = APPEND_RETRIES,
    ) -> None:
        # read_batch and append_retries are implementation-created class
        # boundaries — injectable so tests can reach them (TESTING.md).
        self._sessions = session_factory
        self._notifier = notifier
        self._read_batch = read_batch
        self._append_retries = append_retries
        self._notify_tasks: set[asyncio.Task] = set()  # keep-alive refs

    async def append(
        self,
        channel: str,
        type: str,
        data: Any = None,
        *,
        session: AsyncSession | None = None,
    ) -> dict[str, Any]:
        """Append an event. With `session=`, the write JOINS the caller's
        open transaction — the app's own rows and the event commit (or roll
        back) together, closing the row-without-event crash window. Two
        semantic shifts in that mode: the wake-up is deferred to the
        caller's COMMIT (a rollback never notifies), and a same-channel
        collision is a single attempt surfacing Conflict — a failed INSERT
        poisons the enclosing transaction, so the caller's whole unit of
        work is the retry boundary, not this statement."""
        validate_channel(channel)
        ts = now_iso()
        next_row = sa.select(
            sa.literal(channel),
            sa.func.coalesce(sa.func.max(stream_events.c.seq) + 1, 0),
            sa.literal(type),
            sa.literal(ts),
            sa.literal(data, type_=stream_events.c.data.type),
        ).where(stream_events.c.channel == channel)
        statement = (
            stream_events.insert()
            .from_select(["channel", "seq", "type", "ts", "data"], next_row)
            .returning(stream_events.c.seq)
        )

        def envelope(seq: int) -> dict[str, Any]:
            result: dict[str, Any] = {"type": type, "seq": seq, "ts": ts}
            if data is not None:
                result["data"] = data
            return result

        if session is not None:
            try:
                seq = (await session.execute(statement)).scalar_one()
            except IntegrityError as error:
                raise Conflict(
                    f"append to {channel!r} collided inside the caller's transaction"
                ) from error
            self._notify_on_commit(session, channel)
            return envelope(seq)

        for attempt in range(self._append_retries):
            try:
                async with self._sessions() as own, own.begin():
                    seq = (await own.execute(statement)).scalar_one()
            except IntegrityError:
                await asyncio.sleep(random.uniform(0, 0.002 * 2**attempt))
                continue
            await self._notifier.notify(channel)
            return envelope(seq)
        raise Conflict(
            f"append to {channel!r} kept colliding after {self._append_retries} attempts"
        )

    def _notify_on_commit(self, session: AsyncSession, channel: str) -> None:
        """Wake subscribers when the CALLER commits — never before (they
        would re-query and see nothing) and never on rollback. One pair of
        listeners per session drains a channel set, so repeated appends on
        one transaction wake each channel once."""
        info = session.sync_session.info
        pending: set[str] = info.setdefault("kit_stream_pending_notify", set())
        pending.add(channel)
        if info.get("kit_stream_notify_armed"):
            return
        info["kit_stream_notify_armed"] = True
        loop = asyncio.get_running_loop()

        @sa.event.listens_for(session.sync_session, "after_commit")
        def _fire(_sync_session) -> None:
            for ready in pending:
                task = loop.create_task(self._notifier.notify(ready))
                self._notify_tasks.add(task)
                task.add_done_callback(self._notify_tasks.discard)
            pending.clear()

        @sa.event.listens_for(session.sync_session, "after_rollback")
        def _drop(_sync_session) -> None:
            pending.clear()

    async def read_after(
        self, channel: str, after: int, limit: int | None = None
    ) -> list[dict[str, Any]]:
        validate_channel(channel)
        async with self._sessions() as session:
            rows = await session.execute(
                sa.select(stream_events)
                .where(stream_events.c.channel == channel, stream_events.c.seq > after)
                .order_by(stream_events.c.seq)
                .limit(limit if limit is not None else self._read_batch)
            )
            return [_envelope(row) for row in rows]

    async def sse(
        self, channel: str, after: int, heartbeat: float
    ) -> AsyncIterator[str]:
        """Replay from the cursor, then follow live. Subscribe BEFORE the
        first read — the reverse order can miss an event appended between
        read and subscribe."""
        validate_channel(channel)
        cursor = after
        last_emit = time.monotonic()
        async with self._notifier.subscribe(channel) as subscription:
            while True:
                # Shielded: a client disconnect cancelling us mid-query would
                # abandon the pooled connection un-checked-in (async
                # SQLAlchemy + cancellation). Let the short read finish and
                # clean up; the cancellation still propagates from the await.
                events = await asyncio.shield(self.read_after(channel, cursor))
                for envelope in events:
                    cursor = envelope["seq"]
                    last_emit = time.monotonic()
                    yield format_sse(envelope)
                if len(events) == self._read_batch:
                    continue  # full batch: more is likely pending — don't stall a heartbeat
                await subscription.wait(heartbeat)
                if time.monotonic() - last_emit >= heartbeat:
                    last_emit = time.monotonic()
                    yield ": keep-alive\n\n"

    async def prune(self, channel: str, before: int) -> int:
        """Delete events with seq < before. The log is append-only for
        consumers; retention is the owner's call."""
        validate_channel(channel)
        async with self._sessions() as session, session.begin():
            result = await session.execute(
                stream_events.delete().where(
                    stream_events.c.channel == channel, stream_events.c.seq < before
                )
            )
            return result.rowcount
