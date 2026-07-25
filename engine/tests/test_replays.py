# CLASS MAP — GET /replays, the replay gallery over the durable audit log
# Axes: row lifecycle (done / error / still-running), row origin (real / demo /
#       fixture-named), report content (verdict domain, resolvable version),
#       base url ("" vs the /api mirror)
#   C1 a finished public audit is listed, every field read off the row + report
#   C2 newest first (created_at desc)
#   C3 a listed row's auditId is a REAL permalink — /audit/{id}/report answers 200
#      and /audit/{id}/events replays the durable log
#   C4 non-terminal and errored audits are absent (a card promises a conclusion)
#   C5 demo rows (package_path == '__demo__') are absent — committed-recording lineage
#   C6 fixture package names are absent, matching what /packages hides
#   C7 a report outside the contract's READABLE domain is dropped, not handed out —
#      both halves: a foreign verdict, and an in-domain verdict on an off-version body
#   C8 version: report inventory version wins; falls back to the requested version;
#      null when neither exists (an audit that never resolved one)
#   C9 the body validates against the generated contract; /api mirror is identical
# Residue: rows are inserted straight into the app's sqlite so the projection is
# tested without running audits; NPMGUARD_DATA_DIR is pinned to tmp_path as in
# test_api.py.
import contextlib
import json
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from npmguard.api import create_app
from npmguard.config import get_settings
from npmguard.contract import models as contract

BASES = ["", "/api"]
REPORT_DEADLINE_SECONDS = 30.0

SAFE_REPORT = {
    "schemaVersion": 2,
    "verdict": "SAFE",
    "trace": [{"phase": "inventory", "output": {"metadata": {"version": "4.0.1"}}}],
}


def _report(
    verdict: str = "SAFE", version: str | None = "4.0.1", schema_version: int = 2
) -> dict:
    trace = [{"phase": "inventory", "output": {"metadata": {"version": version}}}] if version else []
    return {"schemaVersion": schema_version, "verdict": verdict, "trace": trace}


@pytest.fixture
def make_app(monkeypatch, tmp_path):
    def build(**env: str):
        settings = {
            "NPMGUARD_ENV": "test",
            "NPMGUARD_MOCK_LLM": "true",
            "NPMGUARD_PAYMENT_REQUIRED": "false",
            "NPMGUARD_DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'api.sqlite3'}",
            "NPMGUARD_DATA_DIR": str(tmp_path / "data"),
            "NPMGUARD_AUDIT_LOG_DIR": str(tmp_path / "audit-logs"),
            **env,
        }
        for name, value in settings.items():
            monkeypatch.setenv(name, value)
        monkeypatch.setattr(
            "npmguard.report_store.DATA_DIR", (tmp_path / "data" / "reports").resolve()
        )
        get_settings.cache_clear()
        return create_app()

    yield build
    get_settings.cache_clear()


def _insert(
    tmp_path,
    audit_id: str,
    package_name: str,
    *,
    status: str = "done",
    report: dict | None = None,
    requested_version: str | None = None,
    package_path: str | None = None,
    created_at: str = "2026-07-20T12:00:00.000Z",
    updated_at: str = "2026-07-20T12:00:03.500Z",
) -> None:
    """One audit_sessions row, written the way the engine would have left it."""
    with contextlib.closing(sqlite3.connect(tmp_path / "api.sqlite3")) as connection:
        connection.execute(
            "INSERT INTO audit_sessions "
            "(audit_id, package_name, requested_version, status, package_path, report,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (
                audit_id,
                package_name,
                requested_version,
                status,
                package_path,
                json.dumps(report) if report is not None else None,
                created_at,
                updated_at,
            ),
        )
        connection.commit()


def _replays(client: TestClient, base: str = "") -> list[dict]:
    response = client.get(f"{base}/replays")
    assert response.status_code == 200
    return response.json()["replays"]


def test_finished_audit_is_a_replay(make_app, tmp_path) -> None:
    """C1: every field comes off the row and its stored report — nothing authored."""
    with TestClient(make_app()) as client:
        _insert(tmp_path, "aud-1", "chalk", report=_report(), requested_version="latest")
        assert _replays(client) == [
            {
                "auditId": "aud-1",
                "packageName": "chalk",
                "version": "4.0.1",
                "verdict": "SAFE",
                "durationMs": 3500,
                "recordedAt": "2026-07-20T12:00:00.000Z",
            }
        ]


def test_newest_first(make_app, tmp_path) -> None:
    """C2: the gallery is ordered by when the audit ran, not by insertion order."""
    with TestClient(make_app()) as client:
        _insert(
            tmp_path,
            "old",
            "chalk",
            report=_report(),
            created_at="2026-07-01T00:00:00.000Z",
            updated_at="2026-07-01T00:00:01.000Z",
        )
        _insert(
            tmp_path,
            "new",
            "lodash",
            report=_report(verdict="DANGEROUS"),
            created_at="2026-07-24T00:00:00.000Z",
            updated_at="2026-07-24T00:00:01.000Z",
        )
        assert [row["auditId"] for row in _replays(client)] == ["new", "old"]


def test_listed_audit_id_is_a_working_permalink(make_app, tmp_path) -> None:
    """C3: the gallery's whole promise, end to end on a REAL audit — the row it lists
    resolves to that audit's stored report and replays its durable event log. This is
    what makes /audit/{id} a permalink rather than a link that merely looks like one.

    The audited package is a local fixture, so it is renamed to a public name after
    the run: the only thing standing between a fixture audit and a gallery row is
    `public_package`, and renaming is how `e2e/global-setup.ts` already re-homes this
    same report for the registry."""
    with TestClient(make_app()) as client:
        started = client.post("/audit/stream", json={"packageName": "test-pkg-child-success"})
        audit_id = started.json()["auditId"]
        deadline = time.monotonic() + REPORT_DEADLINE_SECONDS
        while time.monotonic() < deadline:
            if client.get(f"/audit/{audit_id}/report").status_code != 202:
                break
            time.sleep(0.02)
        assert client.get(f"/audit/{audit_id}/report").status_code == 200

        with contextlib.closing(sqlite3.connect(tmp_path / "api.sqlite3")) as connection:
            connection.execute(
                "UPDATE audit_sessions SET package_name = ? WHERE audit_id = ?",
                ("npm-telemetry-helper", audit_id),
            )
            connection.commit()

        listed = _replays(client)
        assert [row["auditId"] for row in listed] == [audit_id]
        assert listed[0]["verdict"] == "SAFE"

        # Follow the permalink the gallery just handed out.
        assert client.get(f"/audit/{listed[0]['auditId']}/report").status_code == 200
        events = client.get(f"/audit/{listed[0]['auditId']}/events")
        assert events.status_code == 200
        assert "event: verdict_reached" in events.text
        assert f'"auditId":"{audit_id}"' in events.text


def test_unfinished_and_errored_audits_are_absent(make_app, tmp_path) -> None:
    """C4: a card claims a conclusion, so only audits that reached one are listed."""
    with TestClient(make_app()) as client:
        _insert(tmp_path, "queued", "chalk", status="queued")
        _insert(tmp_path, "running", "chalk", status="running")
        _insert(tmp_path, "failed", "chalk", status="error")
        # A 'done' row with no report cannot describe a verdict either.
        _insert(tmp_path, "reportless", "chalk", status="done", report=None)
        assert _replays(client) == []


def test_demo_rows_are_absent(make_app, tmp_path) -> None:
    """C5: committed recordings replay through /demo/*, and listing them here would
    show one exhibit twice under two different identities."""
    with TestClient(make_app()) as client:
        _insert(tmp_path, "demo", "chalk", report=_report(), package_path="__demo__")
        _insert(tmp_path, "real", "chalk", report=_report())
        assert [row["auditId"] for row in _replays(client)] == ["real"]


@pytest.mark.parametrize(
    "package_name",
    ["test-pkg-env-exfil", "test-package-thing", "npm-bench-dd-01"],
)
def test_fixture_names_are_absent(make_app, tmp_path, package_name) -> None:
    """C6: the same predicate /packages uses, so the two lists cannot disagree about
    what is a product exhibit."""
    with TestClient(make_app()) as client:
        _insert(tmp_path, "fixture", package_name, report=_report())
        assert _replays(client) == []


def test_unreadable_reports_are_dropped(make_app, tmp_path) -> None:
    """C7: both halves of the readable domain, screened here for a sharper reason
    than at the file store — a listed row is a LINK to /audit/{id}/report, which
    serves the stored report raw. A foreign verdict is a value the client has no
    branch for; an in-domain verdict on an off-version body is worse, because it
    passes a verdict check and then dies on the client's first missing v2 field, on
    the page this row sent them to."""
    with TestClient(make_app()) as client:
        _insert(tmp_path, "foreign-verdict", "chalk", report=_report(verdict="SUSPECT"))
        _insert(tmp_path, "off-version", "chalk", report=_report(schema_version=1))
        _insert(tmp_path, "no-version", "chalk", report={"verdict": "SAFE", "trace": []})
        _insert(tmp_path, "ours", "chalk", report=_report())
        assert [row["auditId"] for row in _replays(client)] == ["ours"]


def test_version_falls_back_then_goes_null(make_app, tmp_path) -> None:
    """C8: the report's resolved version is the truth; the requested version is the
    fallback; an audit that resolved neither says so instead of guessing. 'latest' is
    never a version — it is what was asked for, and the report already overrode it in
    C1."""
    with TestClient(make_app()) as client:
        _insert(
            tmp_path,
            "requested-only",
            "chalk",
            report=_report(version=None),
            requested_version="2.1.0",
            created_at="2026-07-02T00:00:00.000Z",
        )
        _insert(
            tmp_path,
            "neither",
            "lodash",
            report=_report(version=None),
            created_at="2026-07-01T00:00:00.000Z",
        )
        assert [(row["auditId"], row["version"]) for row in _replays(client)] == [
            ("requested-only", "2.1.0"),
            ("neither", None),
        ]


@pytest.mark.parametrize("base", BASES)
def test_body_matches_the_contract(make_app, tmp_path, base) -> None:
    """C9: validated against the generated model rather than hand-checked keys, and
    reachable identically under the /api mirror."""
    with TestClient(make_app()) as client:
        _insert(tmp_path, "aud-1", "chalk", report=SAFE_REPORT)
        response = client.get(f"{base}/replays")
        assert response.status_code == 200
        gallery = contract.ReplayGalleryResponse.model_validate(response.json())
        assert [entry.auditId for entry in gallery.replays] == ["aud-1"]


def test_empty_gallery_is_an_empty_list(make_app) -> None:
    """C9: no audits is a real answer with a real shape — never a 404 the client has
    to interpret as emptiness."""
    with TestClient(make_app()) as client:
        assert _replays(client) == []
