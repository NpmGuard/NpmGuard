# CLASS MAP — the panel's half of ONE durable queue: lane dispatch on
# `audit_sessions` + panel.settle.build_settle_hook
# (seam: a real throwaway sqlite over kit metadata.create_all; a stub pipeline
#  standing in for the executor, and an injected load_report — the real
#  pipeline/docker never runs)
#
# This file replaces the panel's own queue and worker pool. What it pins is the
# SEMANTICS those carried, now served by the core queue's lanes: dedupe, an
# unbounded scan lane, a per-lane retry budget, and the aftermath of a settle.
#
# Dispatch:
#   C1 enqueueing the same active (pkg, version) twice creates ONE row; the
#      partial-unique dedupe index over ACTIVE rows is the durable backstop
#   C2 a pair that reached a TERMINAL state can be enqueued again — dedupe binds
#      active work, not history
#   C3 a PAID audit never dedupes against panel work, and vice versa: each payment
#      buys its own audit_id, and two payers must not share one verdict
#   C4 the panel lane is UNBOUNDED — a scan enqueues past `queue_size` rather than
#      refusing its own dependencies, while the paid lane still refuses
#   C5 lane RANK orders the queue: a paid audit is claimed ahead of panel work that
#      was enqueued first
#   C6 org FAIRNESS: with one org already running, the next claim prefers a
#      different org's work over its oldest queued row
# Retry budget (per lane):
#   C7 a panel failure returns to `queued` with attempts bumped, NO terminal event
#      appended, and runs again — a retry is not an ending
#   C8 after the lane's budget the row goes terminal `error` with audit_error
#   C9 a PAID failure is terminal on the FIRST attempt: its payer must see it, and
#      a silent re-run would spend a second audit against one payment
# The settle hook:
#   C10 a settled panel audit upserts the verdict from the report FILE and nudges
#       every set covering the pair
#   C11 a landed DANGEROUS verdict fires the alert hook with the origin the ROW
#       carries; a SAFE verdict does not. Deriving origin from what the work points
#       at cannot tell a public-repo scan from a registry-watch audit
#   C12 a settle with no landable verdict writes NO verdict row and still refreshes
#       the sets — the pair reads as ERROR, a visible gap, never a set waiting
#       forever on finished work
#   C13 a PAID audit's settle is ignored by the panel: no verdict row, no refresh
#
# Not here, deliberately: graceful shutdown, claim/lease recovery and concurrent
# claiming are the CORE queue's contract, pinned in test_service_queue.py and
# tests/e2e/test_service_claims.py against real postgres. Duplicating them against
# sqlite would assert less and imply more.
import asyncio
from dataclasses import replace
from typing import Any, cast

import pytest
import sqlalchemy as sa
from pydantic import BaseModel

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier  # noqa: I001 - grouped with kit above
from kit_stream import StreamService
from npmguard.errors import QueueFullError
from npmguard.events import audit_channel
from npmguard.lanes import PAID, PANEL, WATCH
from npmguard.panel import tables
from npmguard.panel.audit_set import ORIGIN_PUBLIC_REPO_SCAN, ORIGIN_WATCHLIST
from npmguard.panel.settle import build_settle_hook
from npmguard.persistence import (
    AuditSession,
    AuditSessionStore,
    EnqueueSpec,
    audit_sessions,
    dedupe_key,
)
from npmguard.pipeline import AuditPipeline
from npmguard.service import AuditService

_ = tables

WAIT_SECONDS = 15


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
        self.files: dict[str, str] = {}

    def cleanup(self) -> None:
        return None


class StubPipeline:
    """Fails a package for its first ``failures[name]`` executions, then succeeds."""

    def __init__(self) -> None:
        self.failures: dict[str, int] = {}
        self.runs: list[str] = []

    async def run(self, package_name: str, *, audit_id: str, version: str | None, emitter: Any):
        self.runs.append(package_name)
        remaining = self.failures.get(package_name, 0)
        if remaining:
            self.failures[package_name] = remaining - 1
            raise RuntimeError(f"transient failure for {package_name}")
        await asyncio.sleep(0)
        return _Result()


@pytest.fixture
async def rig(tmp_path, monkeypatch):
    monkeypatch.setattr("npmguard.report_store.DATA_DIR", tmp_path / "reports")
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'settle.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    pipeline = StubPipeline()
    sessions = AuditSessionStore(factory)
    stream = StreamService(factory, PollingNotifier())

    class Rig:
        def __init__(self) -> None:
            self.factory = factory
            self.pipeline = pipeline
            self.sessions = sessions
            self.stream = stream
            self.services: list[AuditService] = []

        def service(self, **kwargs) -> AuditService:
            kwargs.setdefault("queue_size", 2)
            kwargs.setdefault("max_concurrent", 1)
            service = AuditService(
                cast(AuditPipeline, pipeline), sessions, stream, **kwargs
            )
            self.services.append(service)
            return service

        async def enqueue(self, name, version, *, lane=PANEL, org=None, origin=None):
            service = self.services[0] if self.services else self.service()
            return await service.enqueue_many(
                [
                    EnqueueSpec(
                        name,
                        version,
                        lane=lane,
                        org=org,
                        origin=origin,
                        dedupe_key=dedupe_key(name, version),
                    )
                ]
            )

    rig = Rig()
    yield rig
    for service in rig.services:
        async with asyncio.timeout(WAIT_SECONDS):
            await service.close()
    await engine.dispose()


async def _rows(factory, name):
    async with factory() as session:
        return (
            (
                await session.execute(
                    sa.select(audit_sessions).where(audit_sessions.c.package_name == name)
                )
            )
            .mappings()
            .all()
        )


async def _wait_status(sessions, audit_id, status) -> None:
    async with asyncio.timeout(WAIT_SECONDS):
        while (await sessions.get(audit_id)).status != status:  # noqa: ASYNC110
            await asyncio.sleep(0.02)


# --------------------------------------------------------------------------
# dispatch
# --------------------------------------------------------------------------


async def test_c1_enqueue_dedupes_an_active_pair(rig) -> None:
    """C1: the same active (pkg, version) enqueued twice yields one row."""
    first = await rig.enqueue("left-pad", "1.3.0")
    second = await rig.enqueue("left-pad", "1.3.0")
    assert len(first) == 1
    assert second == []  # deduped, and therefore not charged
    assert len(await _rows(rig.factory, "left-pad")) == 1


async def test_c2_a_terminal_pair_can_be_enqueued_again(rig) -> None:
    """C2: dedupe binds ACTIVE work, not history — once the audit is terminal the
    pair is auditable again (a republished version, a later scan)."""
    created = await rig.enqueue("pkg", "1.0.0")
    await rig.sessions.finalize(created[0].audit_id, {"verdict": "SAFE"})
    again = await rig.enqueue("pkg", "1.0.0")
    assert len(again) == 1
    assert len(await _rows(rig.factory, "pkg")) == 2


async def test_c3_a_paid_audit_never_shares_with_panel_work(rig) -> None:
    """C3: each payment buys its own audit_id. A paid audit carries no dedupe key,
    so it neither collapses into active panel work nor absorbs a second payer."""
    service = rig.service()
    await rig.enqueue("shared-pkg", "2.0.0")
    paid_a = await service.admit("shared-pkg", "2.0.0", lane_name=PAID)
    paid_b = await service.admit("shared-pkg", "2.0.0", lane_name=PAID)

    assert paid_a.audit_id != paid_b.audit_id
    assert len(await _rows(rig.factory, "shared-pkg")) == 3  # 1 panel + 2 paid
    for result in (paid_a, paid_b):
        assert (await rig.sessions.get(result.audit_id)).dedupe_key is None


async def test_c4_the_panel_lane_is_unbounded_and_paid_is_not(rig) -> None:
    """C4: a scan enqueues every cache-missing dependency rather than refusing its
    own work, while the bounded paid lane still refuses past `queue_size`."""
    service = rig.service(queue_size=2)  # deliberately smaller than the batch
    created = await service.enqueue_many(
        [
            EnqueueSpec(f"dep-{index}", "1.0.0", lane=PANEL, dedupe_key=f"dep-{index}@1.0.0")
            for index in range(6)
        ]
    )
    assert len(created) == 6  # absorbed, not refused

    await service.admit("paid-a", "1.0.0", lane_name=PAID)
    await service.admit("paid-b", "1.0.0", lane_name=PAID)
    with pytest.raises(QueueFullError):  # the bound counts only the paid lane
        await service.admit("paid-c", "1.0.0", lane_name=PAID)


async def test_c5_lane_rank_puts_paid_work_first(rig) -> None:
    """C5: panel work enqueued FIRST is still claimed after a later paid audit —
    a 300-dep scan must not sit in front of somebody who paid."""
    service = rig.service()
    await service.enqueue_many(
        [EnqueueSpec("scan-dep", "1.0.0", lane=PANEL, dedupe_key="scan-dep@1.0.0")]
    )
    paid = await service.sessions.create("paid-pkg", "1.0.0", lane=PAID)

    claimed = await rig.sessions.claim_next("owner-1", ttl_seconds=60.0)
    assert claimed is not None
    assert claimed.audit_id == paid.audit_id  # ranked ahead despite arriving later


async def test_c6_org_fairness_prefers_a_starved_org(rig) -> None:
    """C6: with one org's work already running, the next claim goes to the OTHER
    org even though the busy org has the older queued row — one big install
    cannot starve the rest."""
    busy = await rig.sessions.create(
        "busy-first", "1.0.0", lane=PANEL, org="busy", dedupe_key="busy-first@1.0.0"
    )
    await rig.sessions.mark_running(busy.audit_id)  # busy org occupies the pool
    await rig.sessions.create(
        "busy-second", "1.0.0", lane=PANEL, org="busy", dedupe_key="busy-second@1.0.0"
    )
    quiet = await rig.sessions.create(
        "quiet-only", "1.0.0", lane=PANEL, org="quiet", dedupe_key="quiet-only@1.0.0"
    )

    claimed = await rig.sessions.claim_next("owner-1", ttl_seconds=60.0)
    assert claimed is not None
    assert claimed.audit_id == quiet.audit_id


# --------------------------------------------------------------------------
# retry budget
# --------------------------------------------------------------------------


async def test_c7_a_panel_failure_retries_without_a_terminal_frame(rig) -> None:
    """C7: one transient failure on a panel audit sends the row back to `queued`
    with attempts bumped and NOTHING terminal appended, then it runs and succeeds.

    The absent frame is the point: `audit_error` is terminal and every reader stops
    at the first one, so emitting it for an attempt that will be followed by
    another would strand every follower on an audit that is still alive.
    """
    rig.pipeline.failures["flaky"] = 1
    service = rig.service()
    created = await service.enqueue_many(
        [EnqueueSpec("flaky", "1.0.0", lane=PANEL, dedupe_key="flaky@1.0.0")]
    )
    await service.start()

    await _wait_status(rig.sessions, created[0].audit_id, "done")
    settled = await rig.sessions.get(created[0].audit_id)
    assert settled.attempts == 1  # one failure counted
    assert rig.pipeline.runs.count("flaky") == 2  # failed once, then succeeded
    types = [
        event["type"]
        for event in await rig.stream.read_after(audit_channel(created[0].audit_id), -1)
    ]
    assert "audit_error" not in types  # the retry appended no ending
    assert types[-1] == "verdict_reached"


async def test_c8_the_lane_budget_ends_in_a_terminal_error(rig) -> None:
    """C8: past the lane's attempts the row goes terminal `error` with a single
    audit_error — a permanently failing dependency stops consuming the pool."""
    rig.pipeline.failures["broken"] = 99
    service = rig.service()
    created = await service.enqueue_many(
        [EnqueueSpec("broken", "1.0.0", lane=PANEL, dedupe_key="broken@1.0.0")]
    )
    await service.start()

    await _wait_status(rig.sessions, created[0].audit_id, "error")
    settled = await rig.sessions.get(created[0].audit_id)
    assert settled.attempts == 2  # the last attempt terminalizes rather than counting
    assert rig.pipeline.runs.count("broken") == 3  # the panel lane's budget
    types = [
        event["type"]
        for event in await rig.stream.read_after(audit_channel(created[0].audit_id), -1)
    ]
    assert types.count("audit_error") == 1


async def test_c9_a_paid_failure_is_terminal_on_the_first_attempt(rig) -> None:
    """C9: a paid audit gets ONE attempt. Its payer must see the failure, and a
    silent re-run would spend a second audit's budget against one payment."""
    rig.pipeline.failures["paid-broken"] = 99
    service = rig.service()
    await service.start()
    result = await service.admit("paid-broken", "1.0.0", lane_name=PAID)

    async with asyncio.timeout(WAIT_SECONDS):
        with pytest.raises(RuntimeError, match="transient failure"):
            await result.future
    settled = await rig.sessions.get(result.audit_id)
    assert settled.status == "error"
    assert settled.attempts == 0  # never requeued
    assert rig.pipeline.runs.count("paid-broken") == 1


# --------------------------------------------------------------------------
# the settle hook
# --------------------------------------------------------------------------


class FakeVerdictIndex:
    def __init__(self) -> None:
        self.upserts: list[tuple[str, str, str]] = []

    async def upsert(self, name, version, verdict, reason, evidence) -> None:
        self.upserts.append((name, version, verdict))


class FakeSets:
    def __init__(self) -> None:
        self.touched: list[tuple[str, str]] = []

    async def refresh_touching(self, name, version) -> None:
        self.touched.append((name, version))


_SETTLED = AuditSession(
    audit_id="aid-1",
    package_name="pkg",
    requested_version="1.0.0",
    status="done",
    package_path=None,
    file_contents=None,
    report={"verdict": "SAFE", "rationale": "fine"},
    error=None,
    claimed_by=None,
    lease_expires_at=None,
    lane=PANEL,
    org=None,
    origin=ORIGIN_WATCHLIST,
    attempts=0,
    dedupe_key="pkg@1.0.0",
    created_at="2026-01-01T00:00:00.000Z",
    updated_at="2026-01-01T00:00:00.000Z",
)


def _settled(**overrides) -> AuditSession:
    return replace(_SETTLED, **overrides)


def _hook(verdicts, sets, *, report=None, alerts=None):
    async def on_dangerous(name, version, origin) -> None:
        assert alerts is not None
        alerts.append((name, version, origin))

    return build_settle_hook(
        verdicts,
        cast(Any, sets),
        on_dangerous=on_dangerous if alerts is not None else None,
        load_report=lambda name, version: (report, version) if report else None,
    )


async def test_c10_a_settled_panel_audit_indexes_the_report_file(rig) -> None:
    """C10: the verdict comes from the report FILE where there is one, and every
    set covering the pair is nudged."""
    verdicts, sets = FakeVerdictIndex(), FakeSets()
    on_settled = _hook(
        verdicts, sets, report={"verdict": "DANGEROUS", "rationale": "from the file"}
    )

    # the row's own report says SAFE; the file outranks it
    await on_settled(_settled(report={"verdict": "SAFE", "rationale": "from the row"}))

    assert verdicts.upserts == [("pkg", "1.0.0", "DANGEROUS")]
    assert sets.touched == [("pkg", "1.0.0")]


async def test_c11_the_alert_carries_the_origin_the_row_holds(rig) -> None:
    """C11: a DANGEROUS verdict alerts with the audit row's recorded origin, so a
    public-repo finding is not filed as a registry-watch one; SAFE alerts never."""
    alerts: list[tuple[str, str, str]] = []
    verdicts, sets = FakeVerdictIndex(), FakeSets()
    dangerous = _hook(
        verdicts,
        sets,
        report={"verdict": "DANGEROUS", "rationale": "exfil"},
        alerts=alerts,
    )
    await dangerous(_settled(origin=ORIGIN_PUBLIC_REPO_SCAN))
    assert alerts == [("pkg", "1.0.0", ORIGIN_PUBLIC_REPO_SCAN)]

    safe = _hook(verdicts, sets, report={"verdict": "SAFE", "rationale": "ok"}, alerts=alerts)
    await safe(_settled(origin=ORIGIN_WATCHLIST, lane=WATCH))
    assert len(alerts) == 1  # unchanged: a SAFE verdict raises nothing


async def test_c12_an_unlandable_verdict_still_refreshes_the_sets(rig) -> None:
    """C12: a settle with nothing landable writes NO verdict row and still nudges
    the sets. The pair then reads as ERROR — a visible coverage gap, rather than a
    set that waits forever on work that already finished."""
    verdicts, sets = FakeVerdictIndex(), FakeSets()
    on_settled = _hook(verdicts, sets)  # no file, and the row carries no report

    await on_settled(_settled(status="error", report=None, error="pipeline exploded"))

    assert verdicts.upserts == []
    assert sets.touched == [("pkg", "1.0.0")]


async def test_c13_a_paid_settle_is_not_the_panels_business(rig) -> None:
    """C13: a paid audit joins no set and fills no shared cache, so the panel does
    nothing with it — not even a refresh."""
    verdicts, sets = FakeVerdictIndex(), FakeSets()
    on_settled = _hook(verdicts, sets, report={"verdict": "DANGEROUS", "rationale": "x"})

    await on_settled(_settled(lane=PAID, dedupe_key=None))

    assert verdicts.upserts == []
    assert sets.touched == []
