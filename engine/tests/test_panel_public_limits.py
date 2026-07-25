# CLASS MAP — panel.public_limits.PublicScanLimits + the coverage trim it feeds
# (seam: real DB per test — throwaway sqlite over kit metadata.create_all, with
#  the REAL AuditSetStore for the trim classes so what is asserted is the set the
#  store actually wrote, not a projection of the budget arithmetic.)
#
# The ONE quantity this module bounds is "how many NEW audits may a scan buy" —
# a cache hit is free to serve, a miss buys a sandboxed audit. F-F6's dep-count
# cap and its cached-only-past-the-cap are that number at two extremes, which is
# why they share a class group here rather than having one each.
#
# assert_capacity (the only refusal on this surface):
#   C1  below the live-scan limit -> passes
#   C2  at the limit -> TooManyLiveScansError carrying the limit
#   C3  a FINISHED scan is not live; another user's live scan is not counted
# new_audit_budget (per-scan ∧ per-month, 0 = UNLIMITED on either):
#   C4  both knobs 0 -> None (uncapped)
#   C5  per-scan knob alone -> that number
#   C6  monthly knob alone -> monthly minus what this user already bought
#   C7  both -> the SMALLER of the two
#   C8  a month already overspent -> 0, never negative
# new_audits_this_month (spend is recomputed, never metered):
#   C9  counts only NON-cached items, only this user's, only public_repo_scan
#   C10 a set from a previous month does not count against this one
# Coverage trim in AuditSetStore.create (max_new_audits):
#   C11 budget 0 -> CACHED-ONLY: every cache hit is covered, every miss is left
#       OUT of the set, and NOTHING is enqueued
#   C12 budget < misses -> cached hits + exactly `budget` misses, DIRECT deps
#       kept first and the order deterministic
#   C13 uncovered deps are absent from the ITEM table entirely — they are not
#       parked as unenqueued items, because `item_outcome` would then report each
#       of them as an audit that was attempted and FAILED
#   C14 a repeat scan of the same package set costs nothing: everything is cached
#       by then, so it is fully covered under a budget of 0
#   C15 max_new_audits=None (every billed origin) never trims
from collections.abc import Sequence
from typing import cast

import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard.config import Settings
from npmguard.panel import tables
from npmguard.panel.audit_set import (
    ORIGIN_PUBLIC_REPO_SCAN,
    ORIGIN_REPO_SCAN,
    AuditSetSpec,
    build_store,
)
from npmguard.panel.lockfile import LockfileDep
from npmguard.panel.public_limits import PublicScanLimits, TooManyLiveScansError
from npmguard.panel.verdict_index import VerdictIndex
from npmguard.persistence import AuditSessionStore, audit_sessions
from npmguard.pipeline import AuditPipeline
from npmguard.service import AuditService

# Import so metadata.create_all sees the panel tables.
_ = tables

USER = 7
OTHER_USER = 8


def _settings(**overrides) -> Settings:
    base = dict(
        public_scan_max_new_audits=0,
        public_scan_monthly_new_audits=0,
        public_scan_max_concurrent=2,
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture
async def db(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'limits.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    now = now_iso()
    async with factory() as session, session.begin():
        for user_id in (USER, OTHER_USER):
            await session.execute(
                tables.gh_users.insert().values(
                    id=user_id, login=f"u{user_id}", created_at=now, updated_at=now
                )
            )
    yield factory
    await engine.dispose()


class _StubPipeline:
    """Never runs: no worker pool is started in these classes."""

    async def run(self, package_name, *, audit_id, version, local_path=None, emitter=None):  # pragma: no cover
        raise AssertionError("the pipeline must not run here")


@pytest.fixture
async def store(db):
    notifier = PollingNotifier(poll_interval=0.01)
    await notifier.start()
    yield build_store(
        db,
        VerdictIndex(db),
        AuditService(
            cast(AuditPipeline, _StubPipeline()),
            AuditSessionStore(db),
            StreamService(db, notifier),
        ),
        StreamService(db, notifier),
        notifier,
    ), db
    await notifier.close()


async def _add_set(
    factory,
    *,
    user_id: int = USER,
    origin: str = ORIGIN_PUBLIC_REPO_SCAN,
    origin_ref: int = 999,
    finished: bool = True,
    started_at: str | None = None,
    items: Sequence[tuple[str, str, bool]] = (),
) -> int:
    """One audit set with hand-written items. `items` is (name, version, cached)."""
    now = now_iso()
    async with factory() as session, session.begin():
        result = await session.execute(
            tables.audit_sets.insert().values(
                origin=origin,
                origin_ref=origin_ref,
                requested_by=user_id if origin == ORIGIN_PUBLIC_REPO_SCAN else None,
                trigger_kind="manual",
                started_at=started_at or now,
                finished_at=now if finished else None,
            )
        )
        set_id = int(result.inserted_primary_key[0])
        for name, version, cached in items:
            await session.execute(
                tables.audit_set_items.insert().values(
                    set_id=set_id, name=name, version=version, cached=cached
                )
            )
    return set_id


def _deps(*pairs: tuple[str, str], direct: bool = True) -> list[LockfileDep]:
    return [LockfileDep(name, version, direct, None) for name, version in pairs]


async def _items(factory, set_id: int) -> dict[str, bool]:
    """The set's covered items -> whether each was a cache hit."""
    async with factory() as session:
        rows = (
            (
                await session.execute(
                    sa.select(tables.audit_set_items).where(
                        tables.audit_set_items.c.set_id == set_id
                    )
                )
            )
            .mappings()
            .all()
        )
    return {row["name"]: bool(row["cached"]) for row in rows}


# --- assert_capacity ------------------------------------------------------


async def test_capacity_under_limit_passes(db) -> None:
    """C1: one live scan against a limit of two passes."""
    await _add_set(db, finished=False)
    await PublicScanLimits(sessions=db, settings=_settings()).assert_capacity(USER)


async def test_capacity_at_limit_refuses_with_the_limit(db) -> None:
    """C2: at the limit the scan is REFUSED — the one refusal on this surface,
    because "wait for one to finish" is an honest answer and "upgrade" is not."""
    await _add_set(db, finished=False, origin_ref=1)
    await _add_set(db, finished=False, origin_ref=2)
    with pytest.raises(TooManyLiveScansError) as exc:
        await PublicScanLimits(sessions=db, settings=_settings()).assert_capacity(USER)
    assert exc.value.limit == 2


async def test_capacity_counts_only_live_scans_of_this_user(db) -> None:
    """C3: a finished scan is not live, and another user's live scans are not this
    user's concurrency — the bound is per requester, like every other one here."""
    await _add_set(db, finished=True, origin_ref=1)
    await _add_set(db, finished=True, origin_ref=2)
    await _add_set(db, user_id=OTHER_USER, finished=False, origin_ref=3)
    await _add_set(db, user_id=OTHER_USER, finished=False, origin_ref=4)
    await PublicScanLimits(sessions=db, settings=_settings()).assert_capacity(USER)


# --- new_audit_budget -----------------------------------------------------


async def test_budget_uncapped_when_both_knobs_are_zero(db) -> None:
    """C4: 0 is the UNLIMITED sentinel on both knobs (the convention caps.py uses
    for plan limits), so it drops out rather than clamping the budget to zero."""
    limits = PublicScanLimits(sessions=db, settings=_settings())
    assert await limits.new_audit_budget(USER) is None


async def test_budget_uses_the_per_scan_knob_alone(db) -> None:
    """C5: the per-scan ceiling with no monthly one."""
    limits = PublicScanLimits(
        sessions=db, settings=_settings(public_scan_max_new_audits=30)
    )
    assert await limits.new_audit_budget(USER) == 30


async def test_budget_is_the_month_minus_what_was_already_bought(db) -> None:
    """C6: the monthly ceiling nets off this user's spend so far."""
    await _add_set(db, items=[("a", "1", False), ("b", "1", False), ("c", "1", True)])
    limits = PublicScanLimits(
        sessions=db, settings=_settings(public_scan_monthly_new_audits=10)
    )
    # Two misses bought, one cache hit was free.
    assert await limits.new_audit_budget(USER) == 8


async def test_budget_is_the_smaller_of_the_two_ceilings(db) -> None:
    """C7: whichever binds first."""
    await _add_set(db, items=[("a", "1", False)])
    limits = PublicScanLimits(
        sessions=db,
        settings=_settings(
            public_scan_max_new_audits=5, public_scan_monthly_new_audits=10
        ),
    )
    assert await limits.new_audit_budget(USER) == 5


async def test_budget_never_goes_negative(db) -> None:
    """C8: an overspent month yields 0 — cached-only — not a negative budget that
    a `len(misses) > budget` comparison would read as "trim to nothing" by luck."""
    await _add_set(db, items=[(f"p{n}", "1", False) for n in range(6)])
    limits = PublicScanLimits(
        sessions=db, settings=_settings(public_scan_monthly_new_audits=4)
    )
    assert await limits.new_audit_budget(USER) == 0


# --- new_audits_this_month ------------------------------------------------


async def test_month_spend_counts_only_this_users_public_misses(db) -> None:
    """C9: spend is a NEW audit, bought by THIS user, on a PUBLIC scan. A cache
    hit is free, another user's set is theirs, and a repo scan is billed through
    the monthly audit budget in caps.py instead."""
    await _add_set(db, items=[("mine", "1", False), ("cached", "1", True)])
    await _add_set(db, user_id=OTHER_USER, origin_ref=2, items=[("theirs", "1", False)])
    await _add_set(db, origin=ORIGIN_REPO_SCAN, origin_ref=3, items=[("repo", "1", False)])
    limits = PublicScanLimits(sessions=db, settings=_settings())
    assert await limits.new_audits_this_month(USER) == 1


async def test_month_spend_excludes_a_previous_month(db) -> None:
    """C10: the budget resets at the month boundary, the same way account_usage's
    does — and without a usage row to reset, because nothing is metered."""
    await _add_set(db, started_at="2001-02-03T04:05:06Z", items=[("old", "1", False)])
    limits = PublicScanLimits(sessions=db, settings=_settings())
    assert await limits.new_audits_this_month(USER) == 0


# --- the coverage trim ----------------------------------------------------


async def test_zero_budget_covers_the_cache_and_buys_nothing(store) -> None:
    """C11: cached-only. Every hit is covered and every miss is left out, so the
    scan still answers for what is already known and spends nothing."""
    sets, factory = store
    await VerdictIndex(factory).upsert("known", "1.0.0", "SAFE")
    set_id = await sets.create(
        AuditSetSpec(
            origin=ORIGIN_PUBLIC_REPO_SCAN,
            origin_ref=999,
            trigger="manual",
            items=_deps(("known", "1.0.0"), ("fresh", "2.0.0")),
            requested_by=USER,
            max_new_audits=0,
        )
    )
    assert await _items(factory, set_id) == {"known": True}
    async with factory() as session:
        jobs = (await session.execute(sa.select(audit_sessions))).mappings().all()
    assert jobs == []


async def test_budget_keeps_direct_deps_first_and_is_deterministic(store) -> None:
    """C12/C13: with room for one miss, the DIRECT dependency is the one bought —
    and the deps that did not fit are absent from the item table rather than
    parked in it, because an item with no verdict and no live job is ERROR ("we
    tried and failed"), which is a different lie from the one this avoids."""
    sets, factory = store
    await VerdictIndex(factory).upsert("known", "1.0.0", "SAFE")
    set_id = await sets.create(
        AuditSetSpec(
            origin=ORIGIN_PUBLIC_REPO_SCAN,
            origin_ref=999,
            trigger="manual",
            items=[
                LockfileDep("known", "1.0.0", False, None),
                LockfileDep("transitive-a", "1.0.0", False, None),
                LockfileDep("transitive-b", "1.0.0", False, None),
                LockfileDep("direct", "1.0.0", True, None),
            ],
            requested_by=USER,
            max_new_audits=1,
        )
    )
    assert await _items(factory, set_id) == {"known": True, "direct": False}


async def test_a_repeat_scan_costs_nothing_even_at_zero_budget(store) -> None:
    """C14: the property the installation-scoped cap had to buy with a
    COUNT(DISTINCT github_repo_id) special case. Here it falls out of what cost
    MEANS — a repeat's packages are all cached, so a budget of 0 still covers the
    whole lockfile and the funnel does not punish the user who came back."""
    sets, factory = store
    verdicts = VerdictIndex(factory)
    first = await sets.create(
        AuditSetSpec(
            origin=ORIGIN_PUBLIC_REPO_SCAN,
            origin_ref=999,
            trigger="manual",
            items=_deps(("a", "1.0.0"), ("b", "1.0.0")),
            requested_by=USER,
            max_new_audits=None,
        )
    )
    assert len(await _items(factory, first)) == 2
    await verdicts.upsert("a", "1.0.0", "SAFE")
    await verdicts.upsert("b", "1.0.0", "DANGEROUS")

    repeat = await sets.create(
        AuditSetSpec(
            origin=ORIGIN_PUBLIC_REPO_SCAN,
            origin_ref=999,
            trigger="manual",
            items=_deps(("a", "1.0.0"), ("b", "1.0.0")),
            requested_by=OTHER_USER,
            max_new_audits=0,
        )
    )
    assert await _items(factory, repeat) == {"a": True, "b": True}


async def test_no_budget_never_trims(store) -> None:
    """C15: `None` is what every billed origin passes — a repo scan covers its
    repo or refuses (assert_budget); it never half-covers it."""
    sets, factory = store
    set_id = await sets.create(
        AuditSetSpec(
            origin=ORIGIN_REPO_SCAN,
            origin_ref=10,
            trigger="manual",
            items=_deps(("a", "1.0.0"), ("b", "1.0.0"), ("c", "1.0.0")),
        )
    )
    assert len(await _items(factory, set_id)) == 3
