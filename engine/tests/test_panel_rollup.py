# CLASS MAP — panel.scan.repo_scan.compute_rollup + RepoScanEngine.refresh_scan_progress
# (seam A: compute_rollup is PURE — RollupItems in, Rollup out, no DB;
#  seam B: refresh_scan_progress over a real throwaway sqlite — scan_items,
#  package_verdicts and panel_jobs are seeded directly so the count math is
#  observable without GitHub/docker)
#
# compute_rollup — one class per input region over (outcome × cached), where
# outcome ∈ {SAFE, DANGEROUS, ERROR, None(pending)} and severity is
# DANGEROUS > ERROR > SAFE (design §4.4, contract AuditSetRollup):
#   C1  empty set -> outcome None, every counter 0
#   C2  all SAFE -> SAFE
#   C3  DANGEROUS beats SAFE
#   C4  all pending -> outcome None (nothing concluded), pending == total
#   C5  all ERROR -> ERROR
#   C6  ERROR beats SAFE — a set whose audits crashed is NOT green
#   C7  DANGEROUS beats ERROR (max severity over concluded)
#   C8  pending NEVER contributes: SAFE + pending -> "SAFE so far, N pending"
#   C9  mixed severity + pending: every counter exact, outcome DANGEROUS
#   C10 cached is orthogonal — a subset of the concluded three, EXCLUDED from
#       the sum, and it does not change the outcome
#   C11 the wire shape is exactly the contract's seven keys
#   C12 INVARIANT boundary: an item outside SAFE|DANGEROUS|ERROR|None raises
#   C13 INVARIANT boundary: cached with no outcome, or cached+ERROR, raises
#       (cached ⇒ a LANDED verdict is what makes `audited = safe + dangerous -
#       cached` valid downstream)
# refresh_scan_progress (counts come from scan_items, NOT repo_deps):
#   C14 a running scan with an ACTIVE job stays 'running'; counters reflect items
#   C15 a running scan with NO active job is FINALIZED to 'done' + finished_at set
#   C16 counts: cached (cached flag), audited (concluded & !cached), failed (= the
#       ERROR bucket: no verdict and no live attempt)
#   C17 progress ignores repo_deps entirely — a repo_deps row that contradicts
#       scan_items must not change the counts
#   C18 a non-running scan is a no-op (already 'done' stays 'done')
#   C19 the finalized check-run outcome is ERROR when an audit failed among
#       otherwise-SAFE deps (the rollup, not a silent green)
import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from npmguard.panel import tables
from npmguard.panel.scan.repo_scan import RollupItem, compute_rollup

_ = tables


def _items(*outcomes: str | None) -> list[RollupItem]:
    return [RollupItem(outcome=outcome) for outcome in outcomes]


# --------------------------------------------------------------------------
# compute_rollup — pure matrix
# --------------------------------------------------------------------------


def test_rollup_empty() -> None:
    """C1: no items -> outcome None, zeroed counters (the invariant holds at 0)."""
    r = compute_rollup([])
    assert r.outcome is None
    assert (r.total, r.safe, r.dangerous, r.error, r.pending, r.cached) == (0, 0, 0, 0, 0, 0)


def test_rollup_all_safe() -> None:
    """C2: every item SAFE -> SAFE."""
    r = compute_rollup(_items("SAFE", "SAFE", "SAFE"))
    assert r.outcome == "SAFE"
    assert (r.safe, r.total) == (3, 3)


def test_rollup_dangerous_beats_safe() -> None:
    """C3: one DANGEROUS among SAFE -> DANGEROUS."""
    r = compute_rollup(_items("SAFE", "DANGEROUS", "SAFE"))
    assert r.outcome == "DANGEROUS"
    assert (r.dangerous, r.safe) == (1, 2)


def test_rollup_all_pending_has_no_outcome() -> None:
    """C4: nothing concluded -> outcome None. Not concluded is progress, never a
    verdict bucket."""
    r = compute_rollup(_items(None, None))
    assert r.outcome is None
    assert (r.pending, r.total) == (2, 2)
    assert (r.safe, r.dangerous, r.error) == (0, 0, 0)


def test_rollup_all_error() -> None:
    """C5: every audit failed -> ERROR, and the count says how many."""
    r = compute_rollup(_items("ERROR", "ERROR"))
    assert r.outcome == "ERROR"
    assert (r.error, r.total) == (2, 2)


def test_rollup_error_beats_safe() -> None:
    """C6: 12 crashed audits among 40 deps is NOT a green repo — ERROR outranks
    SAFE, and the error count is on the wire to prove it."""
    r = compute_rollup(_items(*(["SAFE"] * 28 + ["ERROR"] * 12)))
    assert r.outcome == "ERROR"
    assert (r.safe, r.error, r.total) == (28, 12, 40)


def test_rollup_dangerous_beats_error() -> None:
    """C7: severity is DANGEROUS > ERROR > SAFE."""
    r = compute_rollup(_items("ERROR", "DANGEROUS", "SAFE"))
    assert r.outcome == "DANGEROUS"


def test_rollup_pending_never_contributes() -> None:
    """C8: SAFE items + a pending one is 'SAFE so far, 1 pending' — never the old
    UNKNOWN, which is what conflated pending with failed."""
    r = compute_rollup(_items("SAFE", "SAFE", None))
    assert r.outcome == "SAFE"
    assert (r.safe, r.pending, r.total) == (2, 1, 3)


def test_rollup_mixed_counters_exact() -> None:
    """C9: one item in each state -> exact counters and DANGEROUS overall."""
    r = compute_rollup(_items("SAFE", "DANGEROUS", "ERROR", None))
    assert r.outcome == "DANGEROUS"
    assert (r.safe, r.dangerous, r.error, r.pending, r.total) == (1, 1, 1, 1, 4)


def test_rollup_cached_is_orthogonal() -> None:
    """C10: a cached item counts in its outcome bucket AND in cached; cached is
    excluded from the four-way sum, so it cannot double-count."""
    r = compute_rollup(
        [
            RollupItem(outcome="SAFE", cached=True),
            RollupItem(outcome="DANGEROUS", cached=True),
            RollupItem(outcome="SAFE", cached=False),
        ]
    )
    assert (r.safe, r.dangerous, r.cached, r.total) == (2, 1, 2, 3)
    assert r.safe + r.dangerous + r.error + r.pending == r.total
    assert r.outcome == "DANGEROUS"


def test_rollup_wire_shape() -> None:
    """C11: as_wire is exactly the contract's AuditSetRollup keys."""
    r = compute_rollup([RollupItem(outcome="SAFE", cached=True), RollupItem(outcome=None)])
    assert r.as_wire() == {
        "outcome": "SAFE",
        "total": 2,
        "safe": 1,
        "dangerous": 0,
        "error": 0,
        "pending": 1,
        "cached": 1,
    }


def test_rollup_rejects_foreign_outcome() -> None:
    """C12: a value outside the 3-state domain (a legacy SUSPECT/UNKNOWN row
    reaching the rollup) fails loud at the boundary that owns the counters."""
    for foreign in ("SUSPECT", "UNKNOWN", "safe"):
        with pytest.raises(AssertionError, match="outcome"):
            compute_rollup([RollupItem(outcome=foreign)])


def test_rollup_rejects_cached_without_landed_verdict() -> None:
    """C13: cached ⇒ a landed verdict. A cached item that is pending, or one that
    is cached AND errored, would silently corrupt the derived `audited` count, so
    both are refused."""
    for bad in (None, "ERROR"):
        with pytest.raises(AssertionError, match="cached item cannot"):
            compute_rollup([RollupItem(outcome=bad, cached=True)])


# --------------------------------------------------------------------------
# refresh_scan_progress — DB-backed, counts from scan_items
# --------------------------------------------------------------------------


def _engine_for(factory, *, finalize_check=None):
    from npmguard.panel.scan.repo_scan import RepoScanEngine

    # Only refresh_scan_progress is exercised here, so the caps/verdict/queue/
    # fetch collaborators are never called — pass inert placeholders.
    async def _never_fetch(_repo, _ref):  # pragma: no cover
        raise AssertionError("fetch must not run in a progress test")

    return RepoScanEngine(
        sessions=factory,
        caps=None,  # type: ignore[arg-type]
        verdict_index=None,  # type: ignore[arg-type]
        queue=None,  # type: ignore[arg-type]
        fetch_repo_deps=_never_fetch,
        finalize_check=finalize_check,
    )


async def _seed_repo(factory) -> None:
    async with factory() as session, session.begin():
        now = now_iso()
        await session.execute(
            tables.installations.insert().values(
                id=1, account_login="acme", account_type="Organization",
                created_at=now, updated_at=now,
            )
        )
        await session.execute(
            tables.repos.insert().values(
                id=10, installation_id=1, owner="acme", name="app",
                full_name="acme/app", created_at=now, updated_at=now,
            )
        )


@pytest.fixture
async def scan_engine(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'scan.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    await _seed_repo(factory)
    yield _engine_for(factory), factory
    await engine.dispose()


async def _new_scan(factory, *, status="running", check_run_id=None) -> int:
    async with factory() as session, session.begin():
        result = await session.execute(
            tables.scans.insert().values(
                repo_id=10, trigger_kind="manual", status=status,
                check_run_id=check_run_id, started_at=now_iso(),
            )
        )
        return int(result.inserted_primary_key[0])


async def _add_item(factory, scan_id, name, version, *, cached=False) -> None:
    async with factory() as session, session.begin():
        await session.execute(
            tables.scan_items.insert().values(
                scan_id=scan_id, name=name, version=version, cached=cached
            )
        )


async def _add_verdict(factory, name, version, verdict="SAFE") -> None:
    async with factory() as session, session.begin():
        await session.execute(
            tables.package_verdicts.insert().values(
                name=name, version=version, verdict=verdict,
                reason="", evidence_count=0, audited_at=now_iso(),
            )
        )


async def _add_active_job(factory, name, version) -> None:
    async with factory() as session, session.begin():
        await session.execute(
            tables.panel_jobs.insert().values(
                package_name=name, version=version, state="running",
                created_at=now_iso(),
            )
        )


async def _scan_row(factory, scan_id):
    async with factory() as session:
        return (
            (await session.execute(sa.select(tables.scans).where(tables.scans.c.id == scan_id)))
            .mappings()
            .one()
        )


async def test_progress_stays_running_with_active_job(scan_engine) -> None:
    """C14/C16: a scan with a still-active job keeps status 'running'; a cached
    item counts as cached and an audited item (verdict, not cached) counts as
    audited."""
    engine, factory = scan_engine
    scan_id = await _new_scan(factory)
    await _add_item(factory, scan_id, "cached-pkg", "1.0.0", cached=True)
    await _add_verdict(factory, "cached-pkg", "1.0.0")
    await _add_item(factory, scan_id, "done-pkg", "2.0.0", cached=False)
    await _add_verdict(factory, "done-pkg", "2.0.0")
    await _add_item(factory, scan_id, "pending-pkg", "3.0.0", cached=False)
    await _add_active_job(factory, "pending-pkg", "3.0.0")

    await engine.refresh_scan_progress(scan_id)

    row = await _scan_row(factory, scan_id)
    assert row["status"] == "running"
    assert row["finished_at"] is None
    assert row["total"] == 3
    assert row["cached"] == 1
    assert row["audited"] == 1
    assert row["failed"] == 0  # the pending one is still active, not failed


async def test_progress_finalizes_when_no_active_job(scan_engine) -> None:
    """C15/C16: no active job left -> status 'done', finished_at set; an item
    with no verdict and no active job is counted as failed (the ERROR bucket)."""
    engine, factory = scan_engine
    scan_id = await _new_scan(factory)
    await _add_item(factory, scan_id, "ok-pkg", "1.0.0", cached=False)
    await _add_verdict(factory, "ok-pkg", "1.0.0", "DANGEROUS")
    await _add_item(factory, scan_id, "lost-pkg", "2.0.0", cached=False)
    # no verdict, no active job -> failed

    await engine.refresh_scan_progress(scan_id)

    row = await _scan_row(factory, scan_id)
    assert row["status"] == "done"
    assert row["finished_at"] is not None
    assert row["total"] == 2
    assert row["audited"] == 1
    assert row["failed"] == 1


async def test_progress_ignores_repo_deps(scan_engine) -> None:
    """C17: progress reads scan_items only. A repo_deps index that disagrees
    with the scan's item set must not move the counters."""
    engine, factory = scan_engine
    scan_id = await _new_scan(factory)
    await _add_item(factory, scan_id, "only-item", "1.0.0", cached=False)
    await _add_verdict(factory, "only-item", "1.0.0")
    # Contradictory repo_deps: extra rows that are NOT in scan_items.
    async with factory() as session, session.begin():
        for i in range(5):
            await session.execute(
                tables.repo_deps.insert().values(
                    repo_id=10, name=f"noise-{i}", version="9.9.9", direct=False
                )
            )

    await engine.refresh_scan_progress(scan_id)

    row = await _scan_row(factory, scan_id)
    assert row["total"] == 1  # scan_items count, not repo_deps (which has 5)
    assert row["status"] == "done"


async def test_progress_noop_on_finished_scan(scan_engine) -> None:
    """C18: a scan that is already 'done' is not re-touched."""
    engine, factory = scan_engine
    scan_id = await _new_scan(factory, status="done")
    await _add_item(factory, scan_id, "x", "1.0.0", cached=False)

    await engine.refresh_scan_progress(scan_id)

    row = await _scan_row(factory, scan_id)
    assert row["status"] == "done"
    assert row["total"] == 0  # untouched — the seeded item was never counted


async def test_finalized_check_outcome_is_error_not_green(tmp_path) -> None:
    """C19: a scan where one audit could not conclude finalizes its check-run
    with ERROR, not SAFE and not 'still running'. This is the whole point of
    making ERROR an outcome — the pre-change rollup answered UNKNOWN here, which
    the check mapper read as 'not resolved yet' and the dashboard rendered as
    not-flagged."""
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'check.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    await _seed_repo(factory)

    concluded: list[str | None] = []

    async def finalize_check(_repo, _check_run_id, outcome) -> None:
        concluded.append(outcome)

    scan_engine = _engine_for(factory, finalize_check=finalize_check)
    scan_id = await _new_scan(factory, check_run_id=555)
    await _add_item(factory, scan_id, "fine-pkg", "1.0.0")
    await _add_verdict(factory, "fine-pkg", "1.0.0", "SAFE")
    await _add_item(factory, scan_id, "crashed-pkg", "2.0.0")  # no verdict, no job

    await scan_engine.refresh_scan_progress(scan_id)

    assert concluded == ["ERROR"]
    await engine.dispose()
