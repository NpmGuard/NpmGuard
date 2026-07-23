from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import structlog

from kit_stream import StreamService

from .errors import AuditIncompleteError, NpmGuardError, QueueFullError
from .events import AuditEmitter, audit_channel
from .persistence import AuditSession, AuditSessionStore
from .pipeline import AuditPipeline
from .report_store import save_report

log = structlog.get_logger("npmguard.audit")

CLOSE_DEADLINE_SECONDS = 10.0


@dataclass(frozen=True)
class SubmitResult:
    audit_id: str
    queue_position: int
    future: asyncio.Future[dict[str, Any]]
    created: bool


class AuditService:
    """Sole owner of audit execution.

    Every session-creation path funnels through ``submit`` (directly or via
    ``admit``). A bounded wait queue (``queue_size``, enforced by ``reserve`` on
    the durable ``queued`` count) feeds a fixed pool of ``max_concurrent``
    workers. ``status == running`` iff an owned worker task will finalize the
    row; ``status == queued`` iff an owned task exists (in the hot in-memory
    queue) that will start or fail it. Restart recovery re-enqueues durable
    ``queued`` rows and 0031-errors interrupted ``running`` rows, so a claimed
    paid audit is never dropped.
    """

    def __init__(
        self,
        pipeline: AuditPipeline,
        sessions: AuditSessionStore,
        stream: StreamService,
        *,
        queue_size: int = 50,
        max_concurrent: int | None = None,
    ) -> None:
        self.pipeline = pipeline
        self.sessions = sessions
        self.stream = stream
        self.queue_size = queue_size
        self.max_concurrent = max_concurrent or 1
        # UNBOUNDED: the real admission bound is reserve()/queued_count() (DB), run
        # BEFORE claim/create so a claimed paid audit is NEVER dropped by a
        # put_nowait QueueFull. The asyncio.Queue only carries slack.
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._workers: list[asyncio.Task[None]] = []

    async def start(self) -> None:
        await self._recover()
        self._workers = [
            asyncio.create_task(self._worker(), name=f"npmguard-audit-worker-{index}")
            for index in range(self.max_concurrent)
        ]

    async def reserve(self) -> None:
        """Capacity gate — no side effects. Every admission path calls this
        BEFORE create/claim, so a refusal never leaves a row or consumes a
        payment proof."""
        if await self.sessions.queued_count() >= self.queue_size:
            raise QueueFullError()

    async def admit(self, package_name: str, version: str | None = None) -> SubmitResult:
        """FREE/CRE/dev entry: reserve -> create(queued) -> submit. A refusal
        (QueueFull) creates no row."""
        await self.reserve()
        session = await self.sessions.create(package_name, version)
        return await self.submit(session)

    async def submit(self, session: AuditSession) -> SubmitResult:
        """The single owner entry every path reaches. Idempotent, audit_id-keyed.

        Registration and enqueue happen with NO await between the ``_pending``
        check and the ``put_nowait`` — asyncio's single thread makes that atomic
        against a concurrent submit of the same audit_id (the webhook-vs-stream
        race resolves to exactly one execution)."""
        aid = session.audit_id
        loop = asyncio.get_running_loop()

        if aid in self._pending:  # already owned (queued/running)
            return SubmitResult(aid, self.queue.qsize(), self._pending[aid], created=False)
        if session.status == "done":  # terminal, no-op
            fut: asyncio.Future[dict[str, Any]] = loop.create_future()
            fut.set_result(session.report or {})
            return SubmitResult(aid, 0, fut, created=False)

        # Fresh 'queued' (create/claim) or a recoverable 'error' replay. REGISTER
        # the owned future with NO await between the `_pending` check above and
        # this assignment, so a concurrent submit of the SAME audit_id dedups here
        # — both the webhook-vs-stream race AND a double paid-replay of an errored
        # claim (two callers that both read status=='error') resolve to one owner.
        # (The old order awaited reset_to_queued BEFORE registering, so two errored
        # replays could both reach it and the loser's guarded reset asserted on a
        # rowcount of 0 → a spurious 500 on a valid retry.)
        fut = loop.create_future()
        self._pending[aid] = fut
        if session.status == "error":
            # error->queued must commit BEFORE put_nowait: a worker that dequeued a
            # still-'error' row would skip it (status != 'queued') and drop the
            # claim. The registration above already deduped concurrent replays, so
            # exactly one caller reaches this guarded reset (rowcount is always 1).
            await self.sessions.reset_to_queued(aid)
        self.queue.put_nowait(aid)
        position = self.queue.qsize()
        await AuditEmitter(aid, self.stream).emit(
            "audit_enqueued", {"queuePosition": position}
        )
        return SubmitResult(aid, position, fut, created=True)

    async def _worker(self) -> None:
        while True:
            aid = await self.queue.get()
            try:
                session = await self.sessions.get(aid)
                if session is None or session.status != "queued":
                    continue  # closed/reset/gone between enqueue and dequeue
                if not await self.sessions.mark_running(aid):
                    continue  # lost the guarded queued->running transition
                running = await self.sessions.get(aid)
                assert running is not None
                result = await self._execute(running)
            except Exception as exc:
                fut = self._pending.get(aid)
                if fut is not None and not fut.done():
                    fut.set_exception(exc)
            else:
                fut = self._pending.get(aid)
                if fut is not None and not fut.done():
                    fut.set_result(result)
            finally:
                # Keep an UNRESOLVED future in _pending (e.g. a CancelledError from
                # close() ripped through _execute mid-pipeline) so close() step 4
                # finalizes the row and resolves it — no orphaned future, no row
                # stuck 'running'. A resolved/absent future is popped normally.
                fut = self._pending.get(aid)
                if fut is None or fut.done():
                    self._pending.pop(aid, None)
                self.queue.task_done()

    def _reenqueue(self, session: AuditSession) -> None:
        # Durable queued row recovered at startup: no HTTP caller survives a
        # restart, so the future is detached (the client reconnects via SSE, and
        # the follow flag now includes 'queued'). audit_enqueued was already
        # emitted pre-restart — not re-emitted.
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        fut.add_done_callback(
            lambda f: None if f.cancelled() else f.exception()  # swallow, never warn
        )
        self._pending[session.audit_id] = fut
        self.queue.put_nowait(session.audit_id)

    async def _recover(self) -> None:
        """Never leave pre-restart sessions looking live forever, and never drop
        a queued claim.

        A hard process stop cannot safely resume a Docker/LLM phase from its
        midpoint, so interrupted ``running`` rows become an explicit, retryable
        0031 in the durable log. Durable ``queued`` rows (which never started)
        are RE-ENQUEUED into the fresh in-memory queue before the pool spins up —
        they run to completion. Demo replays are excluded from both (running/
        queued filter file_contents IS NULL)."""
        for session in await self.sessions.running():
            message = "Audit interrupted by engine restart"
            await self._finish(
                session.audit_id,
                error=message,
                event_type="audit_error",
                payload={"error": message, "code": "NPMGUARD-0031", "retryable": True},
            )
        for session in await self.sessions.queued():
            self._reenqueue(session)

    async def close(self, deadline: float = CLOSE_DEADLINE_SECONDS) -> None:
        """Bounded shutdown. Post-condition: no owned session is left ``running``
        and no owned future is unresolved. Never-started ``queued`` rows are
        deliberately LEFT ``queued`` (not finalized to error) so the next
        ``start()`` re-enqueues and completes them — a graceful shutdown must not
        drop a claimed paid audit that a crash would have preserved (crash/
        graceful parity on the never-drop rule)."""
        # 1. Drain the in-memory wait queue. These ids never started execution
        # (still 'queued'), so LEAVE their rows 'queued' — the next start()'s
        # _recover re-enqueues and runs them to completion. Only resolve their
        # futures (retryable) so no sync caller hangs and no future goes
        # unretrieved. This loop has no await, so no worker can dequeue mid-drain.
        while not self.queue.empty():
            try:
                aid = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._resolve_error(aid)
            self.queue.task_done()

        # 2. Give running workers up to `deadline` to finish naturally. Workers
        # only consume the queue (never add to _pending during shutdown), so this
        # snapshot is stable; asyncio.wait returns at deadline without raising.
        inflight = [f for f in self._pending.values() if not f.done()]
        if inflight:
            await asyncio.wait(inflight, timeout=deadline)

        # 3. Cancel the worker pool.
        for worker in self._workers:
            worker.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers = []

        # 4. Any still-owned row (a worker was mid-item at cancellation): 0031 it
        # if it reached 'running' (unresumable), LEAVE it 'queued' otherwise
        # (a worker cancelled between dequeue and mark_running — restart re-runs
        # it), and ALWAYS resolve its future so nothing is orphaned.
        for aid, fut in list(self._pending.items()):
            await self._shutdown_finalize(aid)
            if not fut.done():
                fut.set_exception(AuditIncompleteError("shutdown", "engine stopped"))
            self._pending.pop(aid, None)

    async def _shutdown_finalize(self, audit_id: str) -> None:
        # Only a RUNNING row (a Docker/LLM phase already mid-flight that a hard
        # stop cannot safely resume) is finalized to a retryable 0031 here. A
        # QUEUED row is LEFT 'queued' so the next start()'s _recover re-enqueues
        # and completes it — graceful shutdown must not drop a claimed paid audit
        # that a crash would have preserved. (Terminal rows are already done.)
        session = await self.sessions.get(audit_id)
        if session is None or session.status != "running":
            return
        message = "Audit interrupted by engine shutdown"
        await self._finish(
            audit_id,
            error=message,
            event_type="audit_error",
            payload={"error": message, "code": "NPMGUARD-0031", "retryable": True},
        )

    def _resolve_error(self, audit_id: str) -> None:
        fut = self._pending.pop(audit_id, None)
        if fut is not None and not fut.done():
            fut.set_exception(AuditIncompleteError("shutdown", "engine stopped"))

    async def _finish(
        self,
        audit_id: str,
        *,
        event_type: str,
        payload: dict[str, Any],
        report: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        # INVARIANT: the non-terminal->terminal row transition and the terminal
        # event (verdict_reached | audit_error) commit in ONE transaction. No
        # consumer can observe a terminal frame for a non-terminal row; a failed
        # append rolls the row back, where restart recovery repairs it — never a
        # terminal row with no terminal event, never a suppressed emit stranding
        # a follower.
        async with self.sessions.transaction() as db:
            await self.sessions.finalize(audit_id, report, error, session=db)
            await self.stream.append(audit_channel(audit_id), event_type, payload, session=db)

    async def _execute(self, session: AuditSession) -> dict[str, Any]:
        emitter = AuditEmitter(session.audit_id, self.stream)
        try:
            result = await self.pipeline.run(
                session.package_name,
                audit_id=session.audit_id,
                version=session.requested_version,
                emitter=emitter,
            )
            try:
                report = result.report.model_dump(mode="json", exclude_none=False)
                # INVARIANT: terminal order is report-file, THEN row+event. The
                # report is durable on disk before the row leaves 'running',
                # and verdict_reached commits atomically with running->done —
                # a client acting on the terminal frame always finds the
                # persisted report.
                save_report(
                    session.package_name, session.requested_version or "latest", result.report
                )
                await self._finish(
                    session.audit_id,
                    report=report,
                    event_type="verdict_reached",
                    payload={
                        "verdict": result.report.verdict,
                        "rationale": result.report.rationale,
                        "counts": result.report.counts.model_dump(mode="json"),
                        "confirmedCount": result.report.counts.confirmed,
                    },
                )
            finally:
                # unconditional: a save/finalize failure must not leak the workspace
                result.cleanup()
            return report
        except Exception as exc:
            message = str(exc) or type(exc).__name__
            code = exc.code if isinstance(exc, NpmGuardError) else "NPMGUARD-9999"
            retryable = exc.retryable if isinstance(exc, NpmGuardError) else False
            await self._finish(
                session.audit_id,
                error=message,
                event_type="audit_error",
                payload={"error": message, "code": code, "retryable": retryable},
            )
            log.exception(
                "audit failed",
                audit_id=session.audit_id,
                package_name=session.package_name,
                code=code,
            )
            raise
