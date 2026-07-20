from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Any

import structlog

from kit_stream import StreamService

from .errors import NpmGuardError, QueueFullError
from .events import AuditEmitter
from .persistence import AuditSession, AuditSessionStore
from .pipeline import AuditPipeline
from .report_store import save_report

log = structlog.get_logger("npmguard.audit")


@dataclass(frozen=True)
class QueueItem:
    session: AuditSession
    future: asyncio.Future[dict[str, Any]]


class AuditService:
    """Own audit execution and the single-worker compatibility queue.

    Streaming/payment audits start immediately, matching the old backend.
    Direct and CRE audits use one worker to bound registry, model, and Docker load.
    """

    def __init__(
        self,
        pipeline: AuditPipeline,
        sessions: AuditSessionStore,
        stream: StreamService,
        *,
        queue_size: int = 50,
    ) -> None:
        self.pipeline = pipeline
        self.sessions = sessions
        self.stream = stream
        self.queue: asyncio.Queue[QueueItem] = asyncio.Queue(maxsize=queue_size)
        self._worker: asyncio.Task[None] | None = None
        self._tasks: set[asyncio.Task[Any]] = set()

    async def start(self) -> None:
        await self._fail_interrupted()
        if self._worker is None:
            self._worker = asyncio.create_task(self._work_queue(), name="npmguard-audit-queue")

    async def close(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None
        if self._tasks:
            await asyncio.gather(*tuple(self._tasks), return_exceptions=True)

    async def enqueue(
        self, package_name: str, version: str | None = None
    ) -> tuple[AuditSession, asyncio.Future[dict[str, Any]], int]:
        if self.queue.full():
            raise QueueFullError()
        session = await self.sessions.create(package_name, version)
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        await self.queue.put(QueueItem(session, future))
        return session, future, self.queue.qsize()

    def launch(self, session: AuditSession) -> None:
        task = asyncio.create_task(
            self._execute(session), name=f"npmguard-audit-{session.audit_id}"
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _work_queue(self) -> None:
        while True:
            item = await self.queue.get()
            try:
                result = await self._execute(item.session)
            except Exception as exc:
                if not item.future.done():
                    item.future.set_exception(exc)
            else:
                if not item.future.done():
                    item.future.set_result(result)
            finally:
                self.queue.task_done()

    async def _fail_interrupted(self) -> None:
        """Never leave pre-restart sessions looking live forever.

        A hard process stop cannot safely resume a Docker/LLM phase from its
        midpoint. Recovery therefore makes the interruption explicit and
        retryable in the durable event log and session state.
        """
        for session in await self.sessions.running():
            emitter = AuditEmitter(session.audit_id, self.stream)
            message = "Audit interrupted by engine restart"
            await emitter.emit(
                "audit_error",
                {"error": message, "code": "NPMGUARD-0031", "retryable": True},
            )
            await self.sessions.finalize(session.audit_id, None, message)

    async def _execute(self, session: AuditSession) -> dict[str, Any]:
        emitter = AuditEmitter(session.audit_id, self.stream)
        try:
            result = await self.pipeline.run(
                session.package_name,
                audit_id=session.audit_id,
                version=session.requested_version,
                emitter=emitter,
            )
            report = result.report.model_dump(mode="json", exclude_none=False)
            await self.sessions.finalize(session.audit_id, report)
            save_report(session.package_name, session.requested_version or "latest", result.report)
            result.cleanup()
            return report
        except Exception as exc:
            message = str(exc) or type(exc).__name__
            code = exc.code if isinstance(exc, NpmGuardError) else "NPMGUARD-9999"
            retryable = exc.retryable if isinstance(exc, NpmGuardError) else False
            with contextlib.suppress(Exception):
                await emitter.emit(
                    "audit_error",
                    {"error": message, "code": code, "retryable": retryable},
                )
            await self.sessions.finalize(session.audit_id, None, message)
            log.exception(
                "audit failed",
                audit_id=session.audit_id,
                package_name=session.package_name,
                code=code,
            )
            raise
