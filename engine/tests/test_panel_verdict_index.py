# CLASS MAP — panel.verdict_index.VerdictIndex (port of TS verdict-index.ts)
# (seam: real throwaway sqlite over kit metadata.create_all; the report LISTER
#  is injected as a fake so rebuild is exercised without touching data/reports/)
# upsert / get:
#   C1 upsert a fresh pair -> get returns {verdict, reason, evidenceCount, auditedAt}
#   C2 upsert an existing pair REPLACES verdict/reason/evidence/auditedAt (PK name+version)
#   C3 get on an unaudited pair -> None
#   C4 the same name at a DIFFERENT version is a distinct row (PK is name+version)
# get_many:
#   C5 returns only the audited pairs, keyed by (name, version); absent pairs omitted
#   C6 a name audited at v1 is NOT returned for the (name, v2) request (exact pair)
#   C7 empty input -> {}
# assess_report / rebuild:
#   C8 assess_report pulls verdict, reason=rationale, evidenceCount=len(confirmedHypIds)
#   C9 rebuild upserts every landable report; returns the count written
#   C10 rebuild lands SAFE|DANGEROUS ONLY — a report with any other verdict is skipped
# item_outcome — the panel outcome domain (§4.4), PURE (verdict + progress in):
#   C11 a landed SAFE verdict IS the outcome, whatever progress says
#   C12 a landed DANGEROUS verdict IS the outcome
#   C13 nothing landed + an attempt still live -> None (not concluded; NOT unknown)
#   C14 nothing landed + nothing running -> ERROR ("we tried and failed")
#   C15 a STORED verdict outside {SAFE, DANGEROUS} (a legacy 4-state row) -> raises
# upsert / outcome_severity guards:
#   C16 upsert refuses a non-landable verdict and writes no row
#   C17 severity ranks DANGEROUS > ERROR > SAFE; a non-outcome raises (KeyError from
#       the total mapping — the dict lookup IS the check)
#   C18 the DATABASE refuses an out-of-domain verdict on an insert that BYPASSES
#       upsert (the 0007 CHECK), which is the only guard that also binds the
#       cross-lineage producer at origin/main
# Adversarial pass: the 2-state guard (C10/C15/C16/C18) is the load-bearing
#   invariant — a SUSPECT/UNKNOWN verdict must never reach a dep row, and if one
#   is already stored the read boundary must fail loud rather than render it. C15
#   and C16 are `raise`, not `assert`, so `python -O` cannot strip them; C18 is the
#   constraint that holds when no Python of ours runs at all.
import pytest
import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.panel import tables
from npmguard.panel.verdict_index import (
    SavedReport,
    VerdictIndex,
    assess_report,
    item_outcome,
    outcome_severity,
)

_ = tables  # ensure metadata.create_all sees the panel tables


@pytest.fixture
async def index_engine(tmp_path):
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'verdict.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    yield VerdictIndex(factory)
    await engine.dispose()


async def test_upsert_then_get(index_engine) -> None:
    """C1: a fresh upsert is read back with all four projected fields."""
    index = index_engine
    await index.upsert("left-pad", "1.3.0", "SAFE", "no exploit", 0, "2026-07-24T00:00:00.000Z")
    row = await index.get("left-pad", "1.3.0")
    assert row == {
        "verdict": "SAFE",
        "reason": "no exploit",
        "evidenceCount": 0,
        "auditedAt": "2026-07-24T00:00:00.000Z",
    }


async def test_upsert_replaces_existing(index_engine) -> None:
    """C2: a second upsert on the same pair overwrites the row in place."""
    index = index_engine
    await index.upsert("evil", "2.0.0", "SAFE", "clean", 0, "2026-07-01T00:00:00.000Z")
    await index.upsert("evil", "2.0.0", "DANGEROUS", "exfil", 3, "2026-07-24T00:00:00.000Z")
    row = await index.get("evil", "2.0.0")
    assert row["verdict"] == "DANGEROUS"
    assert row["reason"] == "exfil"
    assert row["evidenceCount"] == 3
    assert row["auditedAt"] == "2026-07-24T00:00:00.000Z"


async def test_get_unaudited_is_none(index_engine) -> None:
    """C3: an unknown pair resolves to None."""
    assert await index_engine.get("ghost", "9.9.9") is None


async def test_same_name_distinct_versions(index_engine) -> None:
    """C4: (name, v1) and (name, v2) are independent rows."""
    index = index_engine
    await index.upsert("pkg", "1.0.0", "SAFE")
    await index.upsert("pkg", "2.0.0", "DANGEROUS")
    assert (await index.get("pkg", "1.0.0"))["verdict"] == "SAFE"
    assert (await index.get("pkg", "2.0.0"))["verdict"] == "DANGEROUS"


async def test_get_many_returns_only_audited(index_engine) -> None:
    """C5/C6: get_many keys by exact (name, version) and omits absent pairs; a
    name audited at v1 is not returned for the v2 request."""
    index = index_engine
    await index.upsert("a", "1.0.0", "SAFE")
    await index.upsert("b", "2.0.0", "DANGEROUS")
    result = await index.get_many([("a", "1.0.0"), ("a", "9.9.9"), ("b", "2.0.0"), ("c", "1.0.0")])
    assert set(result.keys()) == {("a", "1.0.0"), ("b", "2.0.0")}
    assert result[("a", "1.0.0")]["verdict"] == "SAFE"
    assert result[("b", "2.0.0")]["verdict"] == "DANGEROUS"


async def test_get_many_empty(index_engine) -> None:
    """C7: no pairs requested -> empty map, no query fan-out."""
    assert await index_engine.get_many([]) == {}


def test_assess_report_extracts_fields() -> None:
    """C8: assess_report reads verdict, rationale, and confirmedHypIds length."""
    report = {
        "verdict": "DANGEROUS",
        "rationale": "reads env and POSTs it out",
        "confirmedHypIds": ["h1", "h2"],
    }
    assert assess_report(report) == ("DANGEROUS", "reads env and POSTs it out", 2)
    # Missing optional fields degrade to ('', 0), never raise.
    assert assess_report({"verdict": "SAFE"}) == ("SAFE", "", 0)


async def test_rebuild_from_fake_lister(index_engine) -> None:
    """C9/C10: rebuild lands every SAFE|DANGEROUS report and returns the count;
    a SUSPECT report (never legal in dev) is dropped, not stored."""
    index = index_engine

    def fake_list_reports():
        return [
            SavedReport(
                "safe-pkg",
                "1.0.0",
                {"verdict": "SAFE", "rationale": "clean", "confirmedHypIds": []},
                "2026-07-01T00:00:00.000Z",
            ),
            SavedReport(
                "bad-pkg",
                "3.1.4",
                {"verdict": "DANGEROUS", "rationale": "exfil", "confirmedHypIds": ["h1"]},
                "2026-07-02T00:00:00.000Z",
            ),
            SavedReport(
                "weird-pkg",
                "0.0.1",
                {"verdict": "SUSPECT", "rationale": "hmm", "confirmedHypIds": []},
                "2026-07-03T00:00:00.000Z",
            ),
        ]

    written = await index.rebuild(fake_list_reports)
    assert written == 2  # the SUSPECT report was skipped
    assert (await index.get("safe-pkg", "1.0.0"))["verdict"] == "SAFE"
    assert (await index.get("bad-pkg", "3.1.4"))["evidenceCount"] == 1
    assert await index.get("weird-pkg", "0.0.1") is None


# --------------------------------------------------------------------------
# item_outcome / severity — the panel outcome domain (§4.4), pure
# --------------------------------------------------------------------------


@pytest.mark.parametrize("pending", [True, False])
def test_item_outcome_landed_verdict_wins(pending) -> None:
    """C11/C12: a landed verdict IS the outcome; progress cannot override it (a
    stale queued job alongside a stored verdict must not read as pending)."""
    assert item_outcome("SAFE", pending=pending) == "SAFE"
    assert item_outcome("DANGEROUS", pending=pending) == "DANGEROUS"


def test_item_outcome_pending_is_not_an_outcome() -> None:
    """C13: nothing landed while an attempt is live -> None. Not concluded is a
    progress fact, never a verdict bucket."""
    assert item_outcome(None, pending=True) is None


def test_item_outcome_no_result_no_attempt_is_error() -> None:
    """C14: nothing landed and nothing running -> ERROR. The job failed, or it
    completed on a report with no landable verdict — either way no result is
    coming, and that is not SAFE and not 'not checked yet'."""
    assert item_outcome(None, pending=False) == "ERROR"


def test_item_outcome_rejects_legacy_stored_verdict() -> None:
    """C15: a row from the old 4-state vocabulary fails loud at the read
    boundary instead of being silently rendered."""
    for legacy in ("SUSPECT", "UNKNOWN"):
        with pytest.raises(AssertionError, match="panel outcome domain"):
            item_outcome(legacy, pending=False)


async def test_upsert_rejects_non_landable_verdict(index_engine) -> None:
    """C16: the write boundary refuses anything but SAFE|DANGEROUS, and the
    refusal leaves no row behind."""
    with pytest.raises(AssertionError, match="cannot index verdict"):
        await index_engine.upsert("weird", "1.0.0", "SUSPECT")
    assert await index_engine.get("weird", "1.0.0") is None


def test_outcome_severity_order() -> None:
    """C17: DANGEROUS > ERROR > SAFE, and a value outside the domain raises.

    The refusal is a ``KeyError`` from the total mapping rather than an assert: the
    dict lookup IS the check and names the offending value, and the domain arrives
    guaranteed from ``item_outcome`` upstream. Asserted as a KeyError on purpose —
    the class is "a non-outcome cannot be ranked", not "an assert exists".
    """
    assert (
        outcome_severity("DANGEROUS")
        > outcome_severity("ERROR")
        > outcome_severity("SAFE")
    )
    with pytest.raises(KeyError, match="UNKNOWN"):
        outcome_severity("UNKNOWN")


async def test_stored_verdict_domain_is_enforced_by_the_database(index_engine) -> None:
    """C18 (DB-level): the DATABASE refuses a verdict outside SAFE|DANGEROUS, on an
    INSERT that bypasses ``upsert`` entirely.

    This replaces a test that wrote SAFE and DANGEROUS through ``upsert`` and then
    asserted the column held SAFE and DANGEROUS — true of any writer that stores
    what it is given, and it passed with every one of the collapse's guards deleted.
    Its docstring claimed the N-9 style ("against the database, not the response")
    and that is the claim actually made here: the writer is stepped around, so what
    is proven is the CHECK constraint (alembic 0007) and nothing about Python.

    That distinction is the point of the constraint. The one producer this column
    has outside this codebase — ``origin/main``'s ``upsertVerdict``, writing an
    unfiltered 4-state classification into an identically-named table — never runs
    ``upsert``, so a guard inside it could not have stopped this insert either.
    """
    async with index_engine._sessions() as session:  # noqa: SLF001 - N-9 style DB assert
        with pytest.raises(IntegrityError, match="verdict_domain"):
            async with session.begin():
                await session.execute(
                    tables.package_verdicts.insert().values(
                        name="weird",
                        version="1.0.0",
                        verdict="SUSPECT",
                        reason="",
                        evidence_count=0,
                        audited_at="2026-07-25T00:00:00.000Z",
                    )
                )

    # Both in-domain values still insert, so the constraint is the domain and not a
    # blanket refusal.
    await index_engine.upsert("a", "1.0.0", "SAFE")
    await index_engine.upsert("b", "1.0.0", "DANGEROUS")
    async with index_engine._sessions() as session:  # noqa: SLF001 - N-9 style DB assert
        stored = set(
            (await session.execute(sa.select(tables.package_verdicts.c.verdict)))
            .scalars()
            .all()
        )
    assert stored == {"SAFE", "DANGEROUS"}
