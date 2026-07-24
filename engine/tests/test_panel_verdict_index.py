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
# Adversarial pass: the 2-state guard (C10) is the load-bearing invariant — a
#   SUSPECT/UNKNOWN report must never reach a dep row; the fake lister mixes a
#   SUSPECT report in to prove it is dropped, not stored.
import pytest

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.panel import tables
from npmguard.panel.verdict_index import SavedReport, VerdictIndex, assess_report

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
