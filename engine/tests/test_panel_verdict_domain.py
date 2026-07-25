# CLASS MAP — the verdict domain as a DURABLE constraint, not a compiled-away assert
# (seam: the real `create_app` over a TestClient with NPMGUARD_DATA_DIR on a tmpdir,
#  plus one `python -O` subprocess. Nothing is mocked: the routes read the real
#  `report_store`, and the DB constraint is the one `metadata.create_all` emits.)
#
# This file covers a PUBLIC route (`/packages`) even though it is named for the
# panel, because the value being kept off the wire is the panel's outcome domain and
# the leak crosses the two: `data/reports/` is the panel verdict index's source of
# truth AND the public registry routes' source of truth, so one screening rule has
# to hold for both.
#
# The write side had a `LANDABLE_VERDICTS` filter long before the read side did, and
# that filter never covered the report READERS — which is the gap this file pins.
#
# Progress axis (the -O half):
#   C1  `item_outcome`'s stored-domain guard still fires under `python -O` — it is a
#       `raise`, so the deletion licence it backs is not conditionally compiled
#   C2  the DB CHECK still rejects an out-of-domain verdict under `python -O`, which
#       is the half no Python-level guard can provide
# Outcome axis (the wire half):
#   C3  `/packages` omits a report whose verdict is outside the contract domain, and
#       still lists the in-domain ones — so this is the domain, not a blanket refusal
#   C4  `/package/{name}/report` does not serve one either (the SECOND public reader,
#       which the audit that found this did not name)
#   C5  the screening lives at the STORE, so both of the module's read entry points
#       carry it and a future route inherits it without knowing it exists
#   C6  the domain is DERIVED from the generated contract, so it cannot drift from
#       `AuditReport.verdict` and a legitimate widening needs no second edit here
#       (a DRIFT GUARD, not a regression test — see its docstring)
#   C7  the SHAPE half of the same leak: an unversioned body with an IN-DOMAIN
#       verdict, which the verdict rule passes and the client then fails to parse.
#       Screened at the same boundary, so the routes 404 it rather than serving a
#       page-bricking body
#
# N-7: C1-C5 were each checked against their reverted production hunk in an isolated
# worktree and all five go red. C6 does not, by construction, and says so.
#
import json
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from npmguard import report_store
from npmguard.api import create_app
from npmguard.config import get_settings

# A verdict outside the contract's domain.
FOREIGN_VERDICT = "SUSPECT"

ENGINE_ROOT = Path(__file__).resolve().parents[1]


def _report(verdict: str, *, legacy: bool = False) -> dict:
    """A minimal report body carrying `verdict`.

    `legacy=True` drops `schemaVersion`, the off-version shape. It is a separate
    axis from the verdict on purpose: the store screens BOTH, so a fixture that is
    legacy AND foreign-verdict would pass C3-C5 without the verdict rule existing.
    """
    body = {
        "verdict": verdict,
        "findings": [],
        "proofs": [],
        "trace": [],
        "capabilities": [],
        "runtimeEvidence": None,
    }
    return body if legacy else {"schemaVersion": 2, **body}


@pytest.fixture
def reports_app(monkeypatch, tmp_path):
    """`create_app` with a throwaway reports directory, and a writer into it."""
    reports = (tmp_path / "data" / "reports").resolve()
    for name, value in {
        "NPMGUARD_ENV": "test",
        "NPMGUARD_MOCK_LLM": "true",
        "NPMGUARD_PAYMENT_REQUIRED": "false",
        "NPMGUARD_DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'domain.sqlite3'}",
        "NPMGUARD_DATA_DIR": str(tmp_path / "data"),
        "NPMGUARD_AUDIT_LOG_DIR": str(tmp_path / "audit-logs"),
    }.items():
        monkeypatch.setenv(name, value)
    # report_store resolves its knob at import, so the module constant is re-pointed
    # in lockstep — otherwise a write lands in the repo's own data/ (conftest K1/K2).
    monkeypatch.setattr(report_store, "DATA_DIR", reports)
    get_settings.cache_clear()

    def write(package: str, version: str, verdict: str, *, legacy: bool = False) -> None:
        directory = reports / package
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{version}.json").write_text(
            json.dumps(_report(verdict, legacy=legacy)), encoding="utf-8"
        )

    yield create_app(), write
    get_settings.cache_clear()


# --- progress axis: the enforcement survives -O -----------------------------------


def test_stored_domain_guard_survives_python_dash_o() -> None:
    """C1: under `python -O`, `item_outcome` still refuses a stored 'UNKNOWN'.

    This is the exact probe that showed the collapse's enforcement layer was
    conditionally compiled: with a bare `assert` it returned 'UNKNOWN' under -O, so
    the wider domain flowed again and every branch the commit deleted was licensed
    by a check that was not running. A subprocess because -O is a flag on
    the interpreter, and this suite does not run under it.
    """
    probe = (
        "from npmguard.panel.verdict_index import item_outcome\n"
        "try:\n"
        "    print('LEAKED', item_outcome('UNKNOWN', pending=False))\n"
        "except AssertionError:\n"
        "    print('REFUSED')\n"
    )
    result = subprocess.run(
        [sys.executable, "-O", "-c", probe],
        cwd=ENGINE_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "REFUSED", result.stdout


def test_db_check_constraint_survives_python_dash_o(tmp_path) -> None:
    """C2: under `python -O`, the DATABASE still rejects an out-of-domain verdict.

    The distinct claim from C1: this holds with no guard of ours in the call path at
    all, so it covers a writer that never runs this Python — a migration, a repair
    script, a psql session.
    """
    probe = (
        "import sqlalchemy as sa\n"
        "from kit_spine.db import metadata\n"
        "import npmguard.panel.tables as t\n"
        f"engine = sa.create_engine('sqlite:///{tmp_path / 'o.sqlite3'}')\n"
        "metadata.create_all(engine)\n"
        "try:\n"
        "    with engine.begin() as c:\n"
        "        c.execute(t.package_verdicts.insert().values(\n"
        f"            name='p', version='1.0.0', verdict='{FOREIGN_VERDICT}',\n"
        "            reason='', evidence_count=0, audited_at='2026-07-25T00:00:00Z'))\n"
        "    print('LEAKED')\n"
        "except Exception as err:\n"
        "    print('REFUSED' if 'verdict_domain' in str(err) else f'OTHER {err}')\n"
    )
    result = subprocess.run(
        [sys.executable, "-O", "-c", probe],
        cwd=ENGINE_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "REFUSED", result.stdout


# --- outcome axis: no route puts it on a wire -------------------------------------


def test_packages_route_omits_an_out_of_domain_verdict(reports_app) -> None:
    """C3: `/packages` lists the in-domain reports and omits the foreign one.

    The route is `JSONResponse({"packages": list_reports()})` with no model, so
    nothing validated `report["verdict"]` against
    `AuditReport.verdict: Literal['SAFE','DANGEROUS']` before it crossed. Both halves
    are asserted: the foreign verdict is gone AND the real ones survive, so a test
    that passed by breaking the route would fail.
    """
    app, write = reports_app
    write("leftpad", "1.0.0", "SAFE")
    write("evilpkg", "2.0.0", "DANGEROUS")
    write("hazypkg", "3.0.0", FOREIGN_VERDICT)

    with TestClient(app) as client:
        packages = client.get("/packages").json()["packages"]

    assert {(p["packageName"], p["verdict"]) for p in packages} == {
        ("leftpad", "SAFE"),
        ("evilpkg", "DANGEROUS"),
    }
    assert FOREIGN_VERDICT not in {p["verdict"] for p in packages}


def test_package_report_route_does_not_serve_an_out_of_domain_verdict(
    reports_app,
) -> None:
    """C4: `/package/{name}/report` refuses it too — the second public reader.

    It returns the whole report dict, `verdict` included, so it leaked the retired
    value more directly than `/packages` did. 404 is the honest answer: there is no
    `AuditReport` for that pair, only a file written in a vocabulary this contract
    does not have. The in-domain neighbour still resolves, so the route works.
    """
    app, write = reports_app
    write("leftpad", "1.0.0", "SAFE")
    write("hazypkg", "3.0.0", FOREIGN_VERDICT)

    with TestClient(app) as client:
        good = client.get("/package/leftpad/report", params={"version": "1.0.0"})
        assert good.status_code == 200
        assert good.json()["report"]["verdict"] == "SAFE"

        for params in ({"version": "3.0.0"}, {}):
            leaked = client.get("/package/hazypkg/report", params=params)
            assert leaked.status_code == 404, leaked.text
            assert FOREIGN_VERDICT not in leaked.text


def test_the_store_screens_both_of_its_read_entry_points(reports_app) -> None:
    """C5: the rule lives at the store, so every reader inherits it.

    `list_reports` and `load_report` are the module's only two ways out of
    `data/reports/`, and both are exercised here directly rather than through a
    route. That is the structural claim the routes above only sample: a future
    route, and `panel/jobs.py`'s worker which already calls `load_report`, cannot
    forget a filter they never had to write.
    """
    _app, write = reports_app
    write("hazypkg", "3.0.0", FOREIGN_VERDICT)
    write("leftpad", "1.0.0", "SAFE")

    assert [row["packageName"] for row in report_store.list_reports()] == ["leftpad"]
    assert report_store.load_report("hazypkg", "3.0.0") is None
    assert report_store.load_report("hazypkg") is None
    loaded = report_store.load_report("leftpad", "1.0.0")
    assert loaded is not None and loaded[0]["verdict"] == "SAFE"


def test_a_legacy_shaped_report_is_refused_by_both_public_routes(reports_app) -> None:
    """C7: an in-domain verdict on a schemaVersion-1 body is still not servable.

    This is the half the verdict rule cannot catch, and the one that actually bit: a
    pre-v2 file carries `"verdict": "SAFE"`, passes every verdict check, and then
    dies in the client on `counts: Required` — permanently, because the store
    re-serves the same file on every request. A 404 makes it a package with no
    report instead of a package whose page cannot render.
    """
    app, write = reports_app
    write("leftpad", "1.0.0", "SAFE")
    write("event-stream", "4.0.1", "SAFE", legacy=True)

    with TestClient(app) as client:
        assert client.get("/package/event-stream/report", params={"version": "4.0.1"}).status_code == 404
        packages = client.get("/packages").json()["packages"]

    assert [p["packageName"] for p in packages] == ["leftpad"]


def test_the_domain_is_derived_from_the_generated_contract() -> None:
    """C6: `REPORT_VERDICTS` comes from `AuditReport.verdict`, not a second literal.

    A DRIFT GUARD, not a regression test, and labelled as one: the two sides are
    equal today, so this passes against a hardcoded `frozenset({'SAFE',
    'DANGEROUS'})` too, and reverting the derivation does not turn it red. What it
    does catch is the day the contract widens and a hand-mirrored copy at the store
    does not — the same failure mode as the SQL severity ladder that carries
    different numbers from `OUTCOME_SEVERITY`. Kept for that, claimed as nothing
    more.

    It also records why a constraint on THIS column is a safeguard and not the
    liability a constraint on an open domain would be: a legitimate widening of the
    contract widens the store here with no edit, and needs exactly one deliberate
    migration for the DB.
    """
    from typing import get_args

    from npmguard.contract import models as contract

    derived = frozenset(get_args(contract.AuditReport.model_fields["verdict"].annotation))
    assert derived == report_store.REPORT_VERDICTS
    assert {"SAFE", "DANGEROUS"} == report_store.REPORT_VERDICTS
