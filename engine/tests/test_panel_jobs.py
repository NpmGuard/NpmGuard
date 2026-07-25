# CLASS MAP — panel.jobs.PanelJobQueue + PanelScanWorker
# (seam: real throwaway sqlite over kit metadata.create_all for the durable
#  queue; the AuditService is a FAKE whose admit() returns a resolvable future +
#  a stubbed saved report, and load_report is injected — the real pipeline/docker
#  never runs)
# PanelJobQueue:
#   C1 enqueue a pair -> one queued row; RE-enqueue the SAME (pkg,version) while
#      active -> deduped (still one row) via the active partial-unique index
#   C2 a pair that reached a TERMINAL state (done) can be enqueued again (the
#      active index only blocks queued/running)
#   C3 claim_next guards queued->running: the claimed job flips to 'running';
#      a second claim on an empty queue returns None
#   C4 fail() retries to the back of the queue until MAX_ATTEMPTS, then 'failed'
#   C5 release() returns a claimed job to 'queued' WITHOUT counting an attempt
#   C6 reset_stale() requeues 'running' rows and bumps attempts (crash counted)
# PanelScanWorker full cycle (fake AuditService + injected load_report):
#   C7 process() a claimed job -> admit called, future awaited, verdict upserted
#      from the saved report, job marked 'done', scans-refresh callback fired
#   C8 admit raising QueueFullError -> job released back to 'queued', NO verdict,
#      no attempt consumed (backpressure, not failure)
#   C9 the audit future raising -> job goes back to 'queued' (retry), verdict
#      stays absent, scans-refresh still fired (a failure can complete a scan)
#   C10 on_dangerous seam: a landed DANGEROUS verdict fires the injected alert
#       hook with (pkg, version, origin); a SAFE verdict does NOT
#   C11 origin is READ from the job row, not derived from what the job points at:
#       a public_repo_scan job reports 'public_repo_scan' and a watch job reports
#       'watchlist'. The retired derivation ("watch iff scan_id is None") could
#       not tell those two apart, so every public-repo finding was filed as watch
# PanelWorkerPool shutdown:
#   C12 close() stops idle workers gracefully — the loops exit BETWEEN jobs, so
#       no worker is killed while holding a checked-out DB session (that leaked
#       one pooled connection per worker per shutdown)
#   C13 close() wakes an idling worker immediately rather than waiting out the
#       full idle_poll — a slow stop is what tempts a caller into cancelling
#   C14 close() still terminates when a worker is wedged inside a job: the
#       cancel backstop fires after the timeout rather than hanging forever
import asyncio

import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.errors import QueueFullError
from npmguard.panel import tables
from npmguard.panel.jobs import (
    MAX_ATTEMPTS,
    PanelJobQueue,
    PanelScanWorker,
    PanelWorkerPool,
)
from npmguard.panel.verdict_index import VerdictIndex
from npmguard.service import SubmitResult

_ = tables


@pytest.fixture
async def db(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'jobs.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    yield factory
    await engine.dispose()


async def _job_row(factory, job_id):
    async with factory() as session:
        return (
            (
                await session.execute(
                    sa.select(tables.panel_jobs).where(tables.panel_jobs.c.id == job_id)
                )
            )
            .mappings()
            .one()
        )


async def _count_jobs(factory, name, version):
    async with factory() as session:
        return (
            await session.execute(
                sa.select(sa.func.count())
                .select_from(tables.panel_jobs)
                .where(
                    tables.panel_jobs.c.package_name == name,
                    tables.panel_jobs.c.version == version,
                )
            )
        ).scalar_one()


# --------------------------------------------------------------------------
# PanelJobQueue
# --------------------------------------------------------------------------


async def test_enqueue_dedupes_active_pair(db) -> None:
    """C1: enqueuing the same active (pkg, version) twice inserts one row."""
    queue = PanelJobQueue(db)
    assert await queue.enqueue("left-pad", "1.3.0") is True
    assert await queue.enqueue("left-pad", "1.3.0") is False  # deduped
    assert await _count_jobs(db, "left-pad", "1.3.0") == 1


async def test_terminal_pair_can_requeue(db) -> None:
    """C2: once a pair is terminal (done), it is enqueueable again — the active
    index only blocks queued/running."""
    queue = PanelJobQueue(db)
    await queue.enqueue("pkg", "1.0.0")
    job = await queue.claim_next()
    await queue.complete(job.id)
    assert await queue.enqueue("pkg", "1.0.0") is True
    assert await _count_jobs(db, "pkg", "1.0.0") == 2  # one done, one fresh queued


async def test_claim_guards_transition(db) -> None:
    """C3: claim flips the oldest queued job to 'running'; an empty queue claims
    None."""
    queue = PanelJobQueue(db)
    await queue.enqueue("a", "1.0.0")
    job = await queue.claim_next()
    assert job is not None
    row = await _job_row(db, job.id)
    assert row["state"] == "running"
    assert row["started_at"] is not None
    assert await queue.claim_next() is None  # nothing left queued


async def test_fail_retries_then_fails(db) -> None:
    """C4: fail() retries (back to 'queued', attempts++) until MAX_ATTEMPTS, then
    marks the job 'failed'."""
    queue = PanelJobQueue(db)
    await queue.enqueue("flaky", "1.0.0")
    outcomes = []
    for _ in range(MAX_ATTEMPTS):
        job = await queue.claim_next()
        assert job is not None
        outcomes.append(await queue.fail(job, "boom"))
    assert outcomes == ["retried"] * (MAX_ATTEMPTS - 1) + ["failed"]
    row = await _job_row(db, job.id)
    assert row["state"] == "failed"
    assert row["attempts"] == MAX_ATTEMPTS
    assert row["error"] == "boom"


async def test_release_does_not_count_attempt(db) -> None:
    """C5: release() (QueueFull backpressure) returns the job to 'queued' with
    attempts unchanged."""
    queue = PanelJobQueue(db)
    await queue.enqueue("busy", "1.0.0")
    job = await queue.claim_next()
    await queue.release(job)
    row = await _job_row(db, job.id)
    assert row["state"] == "queued"
    assert row["attempts"] == 0  # no attempt burned
    assert row["started_at"] is None


async def test_reset_stale_requeues_running(db) -> None:
    """C6: reset_stale() requeues rows stuck 'running' and bumps attempts so a
    crashing payload can't loop forever."""
    queue = PanelJobQueue(db)
    await queue.enqueue("stuck", "1.0.0")
    job = await queue.claim_next()  # -> running
    count = await queue.reset_stale()
    assert count == 1
    row = await _job_row(db, job.id)
    assert row["state"] == "queued"
    assert row["attempts"] == 1  # the crashed run is counted


# --------------------------------------------------------------------------
# PanelScanWorker — full cycle with a fake AuditService
# --------------------------------------------------------------------------


class _FakeAudits:
    """Stand-in for AuditService: admit() returns a SubmitResult whose future is
    already resolved with the report (or raises QueueFull / a failure)."""

    def __init__(self, *, report=None, queue_full=False, fail=None) -> None:
        self._report = report
        self._queue_full = queue_full
        self._fail = fail
        self.calls: list[tuple[str, str | None]] = []

    async def admit(self, package_name: str, version: str | None = None) -> SubmitResult:
        self.calls.append((package_name, version))
        if self._queue_full:
            raise QueueFullError()
        loop = asyncio.get_running_loop()
        future: asyncio.Future = loop.create_future()
        if self._fail is not None:
            future.set_exception(self._fail)
        else:
            future.set_result(self._report)
        return SubmitResult(
            audit_id=f"{package_name}@{version}",
            queue_position=0,
            future=future,
            created=True,
        )


def _worker(queue, audits, index, *, report=None, touched=None, on_dangerous=None):
    def _load_report(name, version):
        return (report, version) if report is not None else None

    return PanelScanWorker(
        queue,
        audits,
        index,
        load_report=_load_report,
        on_sets_touched=touched,
        on_dangerous=on_dangerous,
        queue_full_backoff=0.0,
    )


async def test_worker_full_cycle_indexes_verdict(db) -> None:
    """C7: a worker claims a job, admit()s it, awaits the future, upserts the
    verdict from the saved report, marks the job done, and fires the callback."""
    queue = PanelJobQueue(db)
    index = VerdictIndex(db)
    report = {"verdict": "DANGEROUS", "rationale": "exfil", "confirmedHypIds": ["h1", "h2"]}
    audits = _FakeAudits(report=report)

    touched: list[tuple[str, str]] = []

    async def _on_touched(name, version):
        touched.append((name, version))

    worker = _worker(queue, audits, index, report=report, touched=_on_touched)

    await queue.enqueue("evil-pkg", "1.2.3")
    job = await queue.claim_next()
    await worker.process(job)

    assert audits.calls == [("evil-pkg", "1.2.3")]
    row = await _job_row(db, job.id)
    assert row["state"] == "done"
    verdict = await index.get("evil-pkg", "1.2.3")
    assert verdict["verdict"] == "DANGEROUS"
    assert verdict["reason"] == "exfil"
    assert verdict["evidenceCount"] == 2
    assert touched == [("evil-pkg", "1.2.3")]


async def test_worker_queue_full_releases_job(db) -> None:
    """C8: admit raising QueueFull leaves the job queued (backpressure) with no
    verdict written and no attempt consumed."""
    queue = PanelJobQueue(db)
    index = VerdictIndex(db)
    audits = _FakeAudits(queue_full=True)
    worker = _worker(queue, audits, index)

    await queue.enqueue("busy-pkg", "1.0.0")
    job = await queue.claim_next()
    await worker.process(job)

    row = await _job_row(db, job.id)
    assert row["state"] == "queued"
    assert row["attempts"] == 0
    assert await index.get("busy-pkg", "1.0.0") is None


async def test_worker_audit_failure_retries_and_notifies(db) -> None:
    """C9: an audit future that raises sends the job back to 'queued' (retry),
    leaves the verdict absent, and still fires the scans-refresh callback (a
    terminal failure can complete a scan)."""
    queue = PanelJobQueue(db)
    index = VerdictIndex(db)
    audits = _FakeAudits(fail=RuntimeError("sandbox died"))

    touched: list[tuple[str, str]] = []

    async def _on_touched(name, version):
        touched.append((name, version))

    worker = _worker(queue, audits, index, touched=_on_touched)

    await queue.enqueue("crash-pkg", "2.0.0")
    job = await queue.claim_next()
    await worker.process(job)

    row = await _job_row(db, job.id)
    assert row["state"] == "queued"  # first failure retries
    assert row["attempts"] == 1
    assert row["error"] == "sandbox died"
    assert await index.get("crash-pkg", "2.0.0") is None
    assert touched == [("crash-pkg", "2.0.0")]


async def test_worker_fires_on_dangerous_seam(db) -> None:
    """C10: a landed DANGEROUS verdict fires the alert hook with the job's own
    recorded origin; a SAFE verdict does not."""
    queue = PanelJobQueue(db)
    index = VerdictIndex(db)
    fired: list[tuple[str, str, str]] = []

    async def _on_dangerous(name, version, origin):
        fired.append((name, version, origin))

    report = {"verdict": "DANGEROUS", "rationale": "exfil", "confirmedHypIds": ["h1"]}
    worker = _worker(
        queue, _FakeAudits(report=report), index, report=report, on_dangerous=_on_dangerous
    )
    await queue.enqueue("evil", "1.0.0", origin="repo_scan", org="acme")
    job = await queue.claim_next()
    await worker.process(job)
    assert fired == [("evil", "1.0.0", "repo_scan")]

    # A SAFE verdict must NOT fire the hook.
    fired.clear()
    safe = {"verdict": "SAFE", "rationale": "", "confirmedHypIds": []}
    worker = _worker(
        queue, _FakeAudits(report=safe), index, report=safe, on_dangerous=_on_dangerous
    )
    await queue.enqueue("good", "1.0.0")
    job = await queue.claim_next()
    await worker.process(job)
    assert fired == []


@pytest.mark.parametrize(
    ("origin", "org"),
    [("public_repo_scan", "acme"), ("watchlist", None)],
)
async def test_worker_reports_the_jobs_recorded_origin(db, origin, org) -> None:
    """C11: the origin is a column, not a derivation. A public-repo audit and a
    registry-watch audit both carry org/scan shapes the old
    ``"watch" if scan_id is None`` rule read identically, so it filed every public
    finding as a watch alert; reading the recorded origin cannot."""
    queue = PanelJobQueue(db)
    index = VerdictIndex(db)
    fired: list[tuple[str, str, str]] = []

    async def _on_dangerous(name, version, seen):
        fired.append((name, version, seen))

    report = {"verdict": "DANGEROUS", "rationale": "malware", "confirmedHypIds": ["h1"]}
    worker = _worker(
        queue, _FakeAudits(report=report), index, report=report, on_dangerous=_on_dangerous
    )
    await queue.enqueue("watched", "3.0.0", origin=origin, org=org)
    job = await queue.claim_next()
    await worker.process(job)
    assert fired == [("watched", "3.0.0", origin)]


# --------------------------------------------------------------------------
# PanelWorkerPool — graceful shutdown
# --------------------------------------------------------------------------


async def test_pool_close_stops_idle_workers_between_jobs(db) -> None:
    """C12: idle workers exit their loop instead of being cancelled mid-session.

    The observable is the CancelledError: a hard cancel propagates out of the
    gathered task, a graceful stop returns normally. That distinction is the
    whole bug — a worker cancelled inside `claim_next` never returns its pooled
    connection, and `engine.dispose()` cannot reclaim what was never returned.
    """
    pool = PanelWorkerPool(
        PanelJobQueue(db),
        _FakeAudits(),
        VerdictIndex(db),
        count=4,
        idle_poll=30.0,  # long enough that a "stop" that merely waits would hang
    )
    pool.start()
    tasks = list(pool._tasks)
    await asyncio.sleep(0.05)  # let every worker reach its idle park

    await asyncio.wait_for(pool.close(), timeout=5.0)

    assert all(task.done() for task in tasks)
    assert not any(task.cancelled() for task in tasks), (
        "a worker was cancelled rather than stopped — it may have died holding a session"
    )


async def test_pool_close_does_not_wait_out_the_idle_poll(db) -> None:
    """C13: stop wakes the idle sleep immediately."""
    pool = PanelWorkerPool(
        PanelJobQueue(db),
        _FakeAudits(),
        VerdictIndex(db),
        count=2,
        idle_poll=30.0,
    )
    pool.start()
    await asyncio.sleep(0.05)

    loop = asyncio.get_running_loop()
    started = loop.time()
    await pool.close()
    elapsed = loop.time() - started

    # Generous bound: the point is "does not wait out 30s", not a tight timing
    # assertion (which would be flaky under load).
    assert elapsed < 5.0, f"close() waited {elapsed:.2f}s — the idle poll was not woken"


async def test_pool_close_cancels_a_wedged_worker(db) -> None:
    """C14: a worker stuck inside a job is cancelled after the timeout.

    Graceful-first must not become hang-forever: `process` can be parked on an
    admit future that never resolves. Losing that one connection beats never
    completing shutdown.
    """

    class _NeverAdmits:
        async def admit(self, package_name, version=None):
            await asyncio.Event().wait()  # never resolves

    queue = PanelJobQueue(db)
    await queue.enqueue("wedged", "1.0.0")
    pool = PanelWorkerPool(queue, _NeverAdmits(), VerdictIndex(db), count=1)
    pool.start()
    await asyncio.sleep(0.05)  # let the worker claim the job and park

    tasks = list(pool._tasks)
    await asyncio.wait_for(pool.close(deadline=0.2), timeout=5.0)

    assert all(task.done() for task in tasks)
