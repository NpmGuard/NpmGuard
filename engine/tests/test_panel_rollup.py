# CLASS MAP — panel.scan.repo_scan.compute_rollup + RepoScanEngine.refresh_scan_progress
# (seam A: compute_rollup is PURE — verdicts in, Rollup out, no DB;
#  seam B: refresh_scan_progress over a real throwaway sqlite — scan_items,
#  package_verdicts and panel_jobs are seeded directly so the count math is
#  observable without GitHub/docker)
# compute_rollup worst-dep-wins MATRIX (spec §5, ordering DANGEROUS>SUSPECT(=0)>UNKNOWN>SAFE):
#   C1  empty deps -> verdict None, all buckets 0
#   C2  all SAFE -> verdict SAFE
#   C3  any DANGEROUS present (with SAFE) -> verdict DANGEROUS
#   C4  a NULL (pending/unaudited) dep -> counted as unknown, verdict UNKNOWN
#   C5  never SAFE while a dep is pending: SAFE + NULL -> UNKNOWN (not SAFE)
#   C6  DANGEROUS beats a pending NULL -> DANGEROUS
#   C7  suspect bucket is ALWAYS 0 in dev; unknown counts NULL deps; accepts dep mappings
# refresh_scan_progress (counts come from scan_items, NOT repo_deps):
#   C8  a running scan with an ACTIVE job stays 'running'; counters reflect items
#   C9  a running scan with NO active job is FINALIZED to 'done' + finished_at set
#   C10 counts: cached (cached flag), audited (verdict & !cached), failed (no verdict & !active)
#   C11 progress ignores repo_deps entirely — a repo_deps row that contradicts
#       scan_items must not change the counts
#   C12 a non-running scan is a no-op (already 'done' stays 'done')
import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory, now_iso
from kit_spine.db import metadata
from npmguard.panel import tables
from npmguard.panel.scan.repo_scan import compute_rollup

_ = tables


# --------------------------------------------------------------------------
# compute_rollup — pure matrix
# --------------------------------------------------------------------------


def test_rollup_empty() -> None:
    """C1: no deps -> verdict None, zeroed buckets."""
    r = compute_rollup([])
    assert r.verdict is None
    assert (r.dangerous, r.suspect, r.unknown, r.safe) == (0, 0, 0, 0)


def test_rollup_all_safe() -> None:
    """C2: every dep SAFE -> SAFE."""
    r = compute_rollup(["SAFE", "SAFE", "SAFE"])
    assert r.verdict == "SAFE"
    assert r.safe == 3


def test_rollup_any_dangerous_wins() -> None:
    """C3: one DANGEROUS among SAFE -> DANGEROUS."""
    r = compute_rollup(["SAFE", "DANGEROUS", "SAFE"])
    assert r.verdict == "DANGEROUS"
    assert r.dangerous == 1
    assert r.safe == 2


def test_rollup_null_is_unknown() -> None:
    """C4: a null (pending) dep counts as unknown -> verdict UNKNOWN."""
    r = compute_rollup([None, None])
    assert r.verdict == "UNKNOWN"
    assert r.unknown == 2


def test_rollup_never_safe_with_pending() -> None:
    """C5: SAFE deps + one pending dep must NOT roll up to SAFE."""
    r = compute_rollup(["SAFE", "SAFE", None])
    assert r.verdict == "UNKNOWN"
    assert r.safe == 2
    assert r.unknown == 1


def test_rollup_dangerous_beats_pending() -> None:
    """C6: DANGEROUS outranks a pending NULL."""
    r = compute_rollup(["DANGEROUS", None, "SAFE"])
    assert r.verdict == "DANGEROUS"


def test_rollup_suspect_always_zero_accepts_mappings() -> None:
    """C7: dev never emits SUSPECT (bucket stays 0); rollup accepts dep mappings
    with a 'verdict' key, counting NULLs as unknown."""
    r = compute_rollup(
        [{"verdict": "SAFE"}, {"verdict": None}, {"verdict": "DANGEROUS"}]
    )
    assert r.suspect == 0
    assert r.unknown == 1
    assert r.verdict == "DANGEROUS"
    assert r.as_wire() == {
        "verdict": "DANGEROUS",
        "dangerous": 1,
        "suspect": 0,
        "unknown": 1,
        "safe": 1,
    }


# --------------------------------------------------------------------------
# refresh_scan_progress — DB-backed, counts from scan_items
# --------------------------------------------------------------------------


def _engine_for(factory):
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
    )


@pytest.fixture
async def scan_engine(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'scan.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)

    # A repo the scans FK onto.
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
    yield _engine_for(factory), factory
    await engine.dispose()


async def _new_scan(factory, *, status="running") -> int:
    async with factory() as session, session.begin():
        result = await session.execute(
            tables.scans.insert().values(
                repo_id=10, trigger_kind="manual", status=status, started_at=now_iso()
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
    """C8/C10: a scan with a still-active job keeps status 'running'; a cached
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
    """C9/C10: no active job left -> status 'done', finished_at set; an item
    with no verdict and no active job is counted as failed."""
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
    """C11: progress reads scan_items only. A repo_deps index that disagrees
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
    """C12: a scan that is already 'done' is not re-touched."""
    engine, factory = scan_engine
    scan_id = await _new_scan(factory, status="done")
    await _add_item(factory, scan_id, "x", "1.0.0", cached=False)

    await engine.refresh_scan_progress(scan_id)

    row = await _scan_row(factory, scan_id)
    assert row["status"] == "done"
    assert row["total"] == 0  # untouched — the seeded item was never counted
