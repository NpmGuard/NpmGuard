# CLASS MAP — work OWNERSHIP across two AuditService instances sharing one database.
# Seams: two in-process AuditService instances over ONE real Postgres database, a
#        shared stub pipeline (it stands in for the global docker budget: a second
#        execution of the same audit_id is a second real container), StreamService
#        for the durable event probe.
# Axes: which instance created the row × what the other instance does (boots /
#       sweeps) × whether the first instance's claim is LIVE or LAPSED × what the
#       row and the caller's future end up as.
#
# Why this tier exists, and why Postgres specifically: `AuditService`'s ownership
# guarantee — "status == running iff an owned worker task will finalize the row" —
# was scoped to ONE PROCESS, because "owned" meant present in a process-local
# `_pending: dict[str, Future]`. Single-connection sqlite cannot exhibit the failure
# that scoping causes; two writers against a real server can. Every test here is
# about a fact that must be TRUE IN THE DATABASE rather than in some process's heap.
#
#   P1  a LIVE audit is not terminalized by another instance's arrival. This is the
#       one that fails against process-local ownership: `_recover()` sweeps every
#       `running` row it can see, so instance B's boot declares instance A's
#       in-flight audit "interrupted by engine restart" while A is still executing
#       it — a false 0031 on a live paid audit, and then A's own terminal
#       transaction finds the row already terminal. Same bug class as 5dbf25a
#       ("stop boot recovery finalizing a live bench run"), at multi-instance scale.
#
# The assertions deliberately name no claim column: this file states the OBSERVABLE
# contract (whose row may whose code touch), so it stays honest against any
# implementation of ownership, durable or not.
from __future__ import annotations

import asyncio
from typing import Any

import pytest
from pydantic import BaseModel

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard.events import audit_channel
from npmguard.persistence import AuditSessionStore
from npmguard.service import AuditService

pytestmark = [pytest.mark.e2e, pytest.mark.postgres]

WAIT_SECONDS = 15  # generous bound for any awaited queue outcome
SETTLE_SECONDS = 0.5  # long enough for a (bug) recovery sweep to land


class _Counts(BaseModel):
    total: int = 0
    open: int = 0
    inProgress: int = 0
    confirmed: int = 0
    refuted: int = 0
    deferred: int = 0


class _Report(BaseModel):
    verdict: str = "SAFE"
    rationale: str = "stub rationale"
    counts: _Counts = _Counts()
    trace: list = []


class _Result:
    def __init__(self) -> None:
        self.report = _Report()
        self.cleaned = False
        self.files: dict[str, str] = {}

    def cleanup(self) -> None:
        self.cleaned = True


class SharedPipeline:
    """One pipeline behind BOTH instances — it is the global docker budget.

    Counting executions per package here is how a test in one process observes
    "this audit ran twice on the cluster", which is the failure a per-process
    ownership map cannot see, let alone prevent.
    """

    def __init__(self) -> None:
        self.blockers: dict[str, asyncio.Event] = {}
        self.started: list[str] = []
        self.first_started = asyncio.Event()

    async def run(self, package_name: str, *, audit_id: str, version: str | None, emitter: Any):
        self.started.append(package_name)
        self.first_started.set()
        blocker = self.blockers.get(package_name)
        if blocker is not None:
            await blocker.wait()
        else:
            await asyncio.sleep(0.01)
        return _Result()


@pytest.fixture
async def cluster(pg_provisioner, tmp_path, monkeypatch):
    """One Postgres database, one store/stream/pipeline, N AuditService instances.

    ``cluster.instance(**kwargs)`` builds an unstarted service over the SAME
    database — the stand-in for a second engine process. All instances are closed
    at teardown, blockers released first so nothing waits out a deadline.
    """
    monkeypatch.setattr("npmguard.report_store.DATA_DIR", tmp_path / "reports")
    engine = make_engine(pg_provisioner.fresh_database())
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    pipeline = SharedPipeline()
    sessions = AuditSessionStore(factory)
    stream = StreamService(factory, PollingNotifier())
    instances: list[AuditService] = []

    class Cluster:
        def __init__(self) -> None:
            self.pipeline = pipeline
            self.sessions = sessions
            self.stream = stream

        def instance(self, **kwargs) -> AuditService:
            kwargs.setdefault("queue_size", 10)
            kwargs.setdefault("max_concurrent", 1)
            service = AuditService(pipeline, sessions, stream, **kwargs)
            instances.append(service)
            return service

    yield Cluster()

    for blocker in pipeline.blockers.values():
        blocker.set()
    for service in instances:
        async with asyncio.timeout(WAIT_SECONDS):
            await service.close()
    await engine.dispose()


async def _event_types(stream, audit_id: str) -> list[str]:
    return [event["type"] for event in await stream.read_after(audit_channel(audit_id), -1)]


async def test_p1_a_live_audit_survives_another_instances_boot(cluster) -> None:
    """P1: instance B starting up must NOT terminalize the audit instance A is
    executing right now. A's row stays `running`, no audit_error is appended, and
    A's own terminal transaction still completes normally.

    Against process-local ownership this fails at the first assertion: B's
    `_recover()` cannot tell A's live row from an orphan, so it 0031s a paid audit
    mid-flight — and A's `_finish` then meets a row that is already terminal.
    """
    node_a = cluster.instance()
    cluster.pipeline.blockers["pkg-live"] = asyncio.Event()
    await node_a.start()

    live = await node_a.admit("pkg-live", "1.0.0")
    async with asyncio.timeout(WAIT_SECONDS):
        await cluster.pipeline.first_started.wait()  # A is definitely executing it
    assert (await cluster.sessions.get(live.audit_id)).status == "running"

    node_b = cluster.instance()
    await node_b.start()  # the second engine process arrives
    await asyncio.sleep(SETTLE_SECONDS)  # give a (bug) sweep time to land

    # A's work is untouched: still running, and no terminal frame invented for it.
    assert (await cluster.sessions.get(live.audit_id)).status == "running"
    assert "audit_error" not in await _event_types(cluster.stream, live.audit_id)

    # ...and A still finishes it itself, without meeting an already-terminal row.
    cluster.pipeline.blockers["pkg-live"].set()
    async with asyncio.timeout(WAIT_SECONDS):
        report = await live.future
    assert report["verdict"] == "SAFE"
    assert (await cluster.sessions.get(live.audit_id)).status == "done"
    assert await _event_types(cluster.stream, live.audit_id) == [
        "audit_enqueued",
        "verdict_reached",
    ]
    assert cluster.pipeline.started.count("pkg-live") == 1  # executed exactly once
