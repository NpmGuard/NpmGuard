"""Durable panel audit-job queue + worker pool (port of TS ``jobs/{queue,workers}``).

The ``panel_jobs`` table is the panel's **outer, durable, unbounded** audit
queue. A partial-unique index (``ix_panel_jobs_active_pkg``) guarantees at most
one *active* (``queued``/``running``) job per ``(package, version)`` — concurrent
scans needing the same package share the one job, and scan progress is computed
from ``scan_items ⋈ package_verdicts``, never from job ownership.

Fan-out topology (the load-bearing decision): the worker pool does **not** run a
second executor. Each cache-miss is funnelled into ``AuditService.admit`` — the
engine's single owner of audit execution and the inner *bounded* gate (the
Docker sandbox cap ``max_running_sessions``). The worker awaits the admit
future, then reads the saved report and upserts the verdict index. When the
inner gate is full, ``admit`` raises :class:`QueueFullError`; the worker releases
the job back to ``queued`` (no attempt consumed) and backs off — the durable
``panel_jobs`` buffer is the outer queue that absorbs the backpressure.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass

import sqlalchemy as sa
import structlog
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso

from ..errors import QueueFullError
from ..report_store import load_report as default_load_report
from .tables import panel_jobs
from .verdict_index import LANDABLE_VERDICTS, VerdictIndex, assess_report

log = structlog.get_logger("npmguard.panel.jobs")

MAX_ATTEMPTS = 3
_ACTIVE_STATES = ("queued", "running")


@dataclass(frozen=True)
class JobSpec:
    """One enqueue request. ``org`` is the billing account (``None`` = a
    registry-watch audit, which is not charged); ``scan_id`` ties the job to a
    scan (``None`` for public/watch)."""

    package_name: str
    version: str
    org: str | None = None
    scan_id: int | None = None


@dataclass(frozen=True)
class PanelJob:
    """A claimed job row the worker acts on."""

    id: int
    org: str | None
    scan_id: int | None
    package_name: str
    version: str
    state: str
    attempts: int


class PanelJobQueue:
    """Durable queue over ``panel_jobs``.

    Every transition is a guarded async DB write. ``claim_next`` is race-safe
    across the worker pool: it guards the ``queued -> running`` update on the
    row still being ``queued`` and reports the claim lost when another worker
    won.
    """

    def __init__(self, sessions: async_sessionmaker) -> None:
        self._sessions = sessions

    async def enqueue(
        self,
        package_name: str,
        version: str,
        *,
        scan_id: int | None = None,
        org: str | None = None,
    ) -> bool:
        """Enqueue one pair; ``True`` iff a new job row was inserted (deduped
        against any active job for the same pair)."""
        return (
            await self.enqueue_many([JobSpec(package_name, version, org, scan_id)]) == 1
        )

    async def enqueue_many(self, specs: Iterable[JobSpec]) -> int:
        """Insert jobs, skipping any pair that already has an active job. Returns
        how many rows were actually inserted (= the budget to charge).

        Dedupe is a pre-check ``SELECT`` inside the enqueue transaction, so a
        duplicate earlier in the same batch is also caught. The partial-unique
        index is the durable backstop for a cross-process race under postgres.
        """
        specs = list(specs)
        if not specs:
            return 0
        now = now_iso()
        inserted = 0
        async with self._sessions() as session, session.begin():
            for spec in specs:
                active = (
                    await session.execute(
                        sa.select(panel_jobs.c.id)
                        .where(
                            panel_jobs.c.package_name == spec.package_name,
                            panel_jobs.c.version == spec.version,
                            panel_jobs.c.state.in_(_ACTIVE_STATES),
                        )
                        .limit(1)
                    )
                ).first()
                if active is not None:
                    continue
                await session.execute(
                    panel_jobs.insert().values(
                        kind="audit_package",
                        lane="cheap",
                        org=spec.org,
                        scan_id=spec.scan_id,
                        package_name=spec.package_name,
                        version=spec.version,
                        state="queued",
                        attempts=0,
                        created_at=now,
                    )
                )
                inserted += 1
        return inserted

    async def claim_next(self) -> PanelJob | None:
        """Claim the oldest queued job, fairest-org first. Returns ``None`` when
        the queue is empty or the guarded claim was lost to another worker."""
        j = panel_jobs
        r = panel_jobs.alias("r")
        # Fairness: prefer the org with the fewest jobs currently running, oldest
        # first — one big install can't starve the others. `is_not_distinct_from`
        # is the NULL-safe org match (renders `IS` on sqlite, `IS NOT DISTINCT
        # FROM` on postgres), so watch jobs (org NULL) group together.
        running_for_org = (
            sa.select(sa.func.count())
            .select_from(r)
            .where(r.c.state == "running", r.c.org.is_not_distinct_from(j.c.org))
            .scalar_subquery()
        )
        async with self._sessions() as session, session.begin():
            row = (
                (
                    await session.execute(
                        sa.select(j)
                        .where(j.c.state == "queued", j.c.lane == "cheap")
                        .order_by(running_for_org, j.c.created_at)
                        .limit(1)
                    )
                )
                .mappings()
                .first()
            )
            if row is None:
                return None
            result = await session.execute(
                j.update()
                .where(j.c.id == row["id"], j.c.state == "queued")
                .values(state="running", started_at=now_iso())
            )
            if result.rowcount != 1:
                return None  # lost the guarded queued->running race
        return PanelJob(
            id=row["id"],
            org=row["org"],
            scan_id=row["scan_id"],
            package_name=row["package_name"],
            version=row["version"],
            state="running",
            attempts=row["attempts"],
        )

    async def complete(self, job_id: int) -> None:
        async with self._sessions() as session, session.begin():
            await session.execute(
                panel_jobs.update()
                .where(panel_jobs.c.id == job_id)
                .values(state="done", finished_at=now_iso(), error=None)
            )

    async def fail(self, job: PanelJob, error: str) -> str:
        """Record an audit failure. Retries to the back of the queue until
        ``MAX_ATTEMPTS``, then marks the job ``failed`` (its dep verdict stays
        null, ``jobState='failed'``). Returns ``'retried'`` or ``'failed'``."""
        now = now_iso()
        attempts = job.attempts + 1
        async with self._sessions() as session, session.begin():
            if attempts >= MAX_ATTEMPTS:
                await session.execute(
                    panel_jobs.update()
                    .where(panel_jobs.c.id == job.id)
                    .values(state="failed", attempts=attempts, finished_at=now, error=error)
                )
                return "failed"
            # Bump created_at so the retry goes to the back of the queue.
            await session.execute(
                panel_jobs.update()
                .where(panel_jobs.c.id == job.id)
                .values(
                    state="queued",
                    attempts=attempts,
                    created_at=now,
                    started_at=None,
                    error=error,
                )
            )
            return "retried"

    async def release(self, job: PanelJob) -> None:
        """Backpressure release: return a claimed job to ``queued`` without
        counting an attempt (``admit`` raised QueueFull — no audit was tried)."""
        async with self._sessions() as session, session.begin():
            await session.execute(
                panel_jobs.update()
                .where(panel_jobs.c.id == job.id)
                .values(state="queued", started_at=None)
            )

    async def reset_stale(self) -> int:
        """Startup recovery: jobs stuck ``running`` from a crashed process go
        back to ``queued``, with ``attempts`` incremented so a payload that kills
        the process can't crash-loop forever."""
        async with self._sessions() as session, session.begin():
            result = await session.execute(
                panel_jobs.update()
                .where(panel_jobs.c.state == "running")
                .values(state="queued", started_at=None, attempts=panel_jobs.c.attempts + 1)
            )
        if result.rowcount:
            log.info("panel jobs requeued after restart", count=result.rowcount)
        return result.rowcount


# The AuditService seam the worker funnels into. Only ``admit`` is used; typed
# structurally so tests can inject a fake without the full service.
class _Admitting:
    async def admit(self, package_name: str, version: str | None = None):  # pragma: no cover
        ...


LoadReport = Callable[[str, str], tuple[dict, str] | None]
ScansTouched = Callable[[str, str], Awaitable[None]]
# Fired when a completed audit lands a DANGEROUS verdict: (package, version,
# source). ``source`` is 'watch' for a registry-watch job (no owning scan) else
# 'scan'. Injected so jobs.py stays testable without the alerts subsystem — the
# wire stage binds it to alerts.notify.handle_dangerous_verdict.
OnDangerous = Callable[[str, str, str], Awaitable[None]]


class PanelScanWorker:
    """Drains the durable queue into ``AuditService.admit`` and indexes verdicts.

    A worker claims a job, funnels the pair into the inner bounded executor,
    awaits its future, then reads the saved report and upserts the verdict
    index. QueueFull backpressure releases the job; an audit failure is retried
    then failed. After every settle it nudges the scans that cover the pair.
    """

    def __init__(
        self,
        queue: PanelJobQueue,
        audits: _Admitting,
        verdict_index: VerdictIndex,
        *,
        load_report: LoadReport = default_load_report,
        on_scans_touched: ScansTouched | None = None,
        on_dangerous: OnDangerous | None = None,
        queue_full_backoff: float = 1.0,
        idle_poll: float = 1.0,
    ) -> None:
        self._queue = queue
        self._audits = audits
        self._verdict_index = verdict_index
        self._load_report = load_report
        self._on_scans_touched = on_scans_touched
        self._on_dangerous = on_dangerous
        self._queue_full_backoff = queue_full_backoff
        self._idle_poll = idle_poll

    async def process(self, job: PanelJob) -> None:
        """Run one claimed job to a settle. Safe to drive directly in tests."""
        # Cross-scan short-circuit: the verdict may have landed via another
        # scan's job between this job's creation and its claim.
        if await self._verdict_index.get(job.package_name, job.version) is not None:
            await self._queue.complete(job.id)
            await self._notify(job)
            return

        try:
            result = await self._audits.admit(job.package_name, job.version)
        except QueueFullError:
            # Inner gate full — leave the job queued and back off. The durable
            # panel_jobs buffer is the outer unbounded queue.
            await self._queue.release(job)
            await asyncio.sleep(self._queue_full_backoff)
            return

        try:
            report_result = await result.future
        except Exception as exc:  # noqa: BLE001 - any audit failure is a job failure
            message = str(exc) or type(exc).__name__
            outcome = await self._queue.fail(job, message)
            log.warning(
                "panel audit failed",
                package=job.package_name,
                version=job.version,
                outcome=outcome,
                error=message,
            )
            await self._notify(job)
            return

        # Report files stay authoritative — prefer the persisted report, falling
        # back to the future's payload if the on-disk version drifted.
        loaded = self._load_report(job.package_name, job.version)
        report = loaded[0] if loaded else report_result
        verdict, reason, evidence = assess_report(report or {})
        if verdict in LANDABLE_VERDICTS:
            await self._verdict_index.upsert(
                job.package_name, job.version, verdict, reason, evidence
            )
            # Alert hook: only when WE landed the verdict (the cross-scan short-
            # circuit above leaves alerting to the job that produced it).
            if verdict == "DANGEROUS" and self._on_dangerous is not None:
                source = "watch" if job.scan_id is None else "scan"
                await self._on_dangerous(job.package_name, job.version, source)
        await self._queue.complete(job.id)
        await self._notify(job)

    async def run_forever(self) -> None:
        while True:
            job = await self._queue.claim_next()
            if job is None:
                await asyncio.sleep(self._idle_poll)
                continue
            try:
                await self.process(job)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - guard the worker loop
                log.exception("panel worker crashed on job", job_id=job.id)

    async def _notify(self, job: PanelJob) -> None:
        if self._on_scans_touched is not None:
            await self._on_scans_touched(job.package_name, job.version)


class PanelWorkerPool:
    """A fixed set of :class:`PanelScanWorker` loops over one queue."""

    def __init__(
        self,
        queue: PanelJobQueue,
        audits: _Admitting,
        verdict_index: VerdictIndex,
        *,
        count: int,
        load_report: LoadReport = default_load_report,
        on_scans_touched: ScansTouched | None = None,
        on_dangerous: OnDangerous | None = None,
    ) -> None:
        self._workers = [
            PanelScanWorker(
                queue,
                audits,
                verdict_index,
                load_report=load_report,
                on_scans_touched=on_scans_touched,
                on_dangerous=on_dangerous,
            )
            for _ in range(count)
        ]
        self._tasks: list[asyncio.Task[None]] = []

    def start(self) -> None:
        if self._tasks:
            return
        self._tasks = [
            asyncio.create_task(worker.run_forever(), name=f"npmguard-panel-worker-{i}")
            for i, worker in enumerate(self._workers)
        ]
        log.info("panel worker pool started", count=len(self._tasks))

    async def close(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []


__all__ = [
    "MAX_ATTEMPTS",
    "JobSpec",
    "OnDangerous",
    "PanelJob",
    "PanelJobQueue",
    "PanelScanWorker",
    "PanelWorkerPool",
]
