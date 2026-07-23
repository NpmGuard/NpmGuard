# CLASS MAP — API routes over create_app (in-process TestClient; NPMGUARD_MOCK_LLM
# benign stub — reaches intent+flag, zero flags → SAFE; sandbox/judge not exercised here)
# Axes: entry path (free stream / CRE key / payment gate), payload validity,
#       base url ("" vs the /api mirror), audit lifecycle (report read, SSE replay)
#   C1 free stream audit end-to-end   — completes SAFE; report 200; SSE replay carries
#      verdict_reached + auditId (replay-only path; live follow is e2e-tier)
#   C2 /api mirror                    — same routes reachable under "" and "/api"
#      (parametrized across C1 and the validation matrix)
#   C3 payment gate                   — no proof + PAYMENT_REQUIRED → 402, no launch
#   C4 CRE 202                        — x-api-key → {status:accepted, auditId, queuePosition}
#   C5 wrong CRE key                  — falls through to the 402 gate
#   C6 invalid JSON body              → 400 {"error": "Invalid JSON body"}
#   C7 invalid AuditRequest matrix    — traversal/uppercase/empty/overlong names,
#      bad semver → 400 "Invalid request" (pydantic details, no launch)
#   C8 unknown audit id               → 404 report
# Residue: conftest pins NPMGUARD_DATA_DIR/NPMGUARD_AUDIT_LOG_DIR to a temp dir at
# import; this file re-points both knobs to tmp_path per test (report_store's is an
# import-time constant, so its module value is re-pointed to the same tmp target).
# Adversarial pass: 2026-07-23/W6 — sleep-poll replaced with a deadline-bounded
# condition wait; background CRE audit no longer races repo data/ writes.
import contextlib
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient

from npmguard.api import create_app
from npmguard.config import get_settings

REPORT_DEADLINE_SECONDS = 30.0
BASES = ["", "/api"]


def _session_count(tmp_path) -> int:
    """Observable launch probe: audit_sessions rows in the app's sqlite DB —
    every launch path (free/CRE/paid) creates a session row first, so 'no
    launch' claims get a state assertion, not just a response-shape one."""
    # contextlib.closing: sqlite3's own context manager commits but never closes
    with contextlib.closing(sqlite3.connect(tmp_path / "api.sqlite3")) as connection:
        return connection.execute("SELECT COUNT(*) FROM audit_sessions").fetchone()[0]

BAD_AUDIT_PAYLOADS = [
    pytest.param({"packageName": "../evil"}, id="traversal-name"),
    pytest.param({"packageName": "UPPER-case"}, id="uppercase-name"),
    pytest.param({"packageName": ""}, id="empty-name"),
    pytest.param({"packageName": "a" * 215}, id="overlong-name"),
    pytest.param({"packageName": "has space"}, id="space-in-name"),
    pytest.param({"packageName": "is-number", "version": "not-semver"}, id="bad-semver"),
    pytest.param({"packageName": "is-number", "version": "1.2"}, id="short-semver"),
]


@pytest.fixture
def make_app(monkeypatch, tmp_path):
    """create_app with fully explicit env, all state under tmp_path."""

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
        # report_store resolves its knob at import; keep the module constant in
        # lockstep with the env value above so no write can land in the repo.
        monkeypatch.setattr(
            "npmguard.report_store.DATA_DIR", (tmp_path / "data" / "reports").resolve()
        )
        get_settings.cache_clear()
        return create_app()

    yield build
    get_settings.cache_clear()


def _wait_report(client: TestClient, base: str, audit_id: str):
    """Bounded condition wait: poll until the report leaves 202 or the deadline."""
    deadline = time.monotonic() + REPORT_DEADLINE_SECONDS
    while time.monotonic() < deadline:
        report = client.get(f"{base}/audit/{audit_id}/report")
        if report.status_code != 202:
            return report
        time.sleep(0.02)
    raise AssertionError(f"audit {audit_id} produced no report within {REPORT_DEADLINE_SECONDS}s")


@pytest.mark.parametrize("base", BASES)
def test_free_stream_audit_completes_and_replays(make_app, base) -> None:
    """C1+C2: free stream audit reaches SAFE; report and SSE replay agree; the
    whole flow works identically under the /api mirror."""
    with TestClient(make_app()) as client:
        assert client.get(f"{base}/health").json() == {"status": "ok"}
        started = client.post(
            f"{base}/audit/stream", json={"packageName": "test-pkg-child-success"}
        )
        assert started.status_code == 200
        audit_id = started.json()["auditId"]
        report = _wait_report(client, base, audit_id)
        assert report.status_code == 200
        assert report.json()["verdict"] == "SAFE"
        event_stream = client.get(f"{base}/audit/{audit_id}/events")
        assert "event: verdict_reached" in event_stream.text
        assert f'"auditId":"{audit_id}"' in event_stream.text


def test_payment_gate_and_cre_paths(make_app, tmp_path) -> None:
    """C3+C4+C5+C8: the gate 402s without proof or with a wrong CRE key — and
    NO session row exists after the refusals (state probe, not just the wire
    shape); the right key gets a 202 with an auditId and a queuePosition."""
    with TestClient(
        make_app(NPMGUARD_PAYMENT_REQUIRED="true", NPMGUARD_CRE_API_KEY="test-cre-key")
    ) as client:
        denied = client.post("/audit/stream", json={"packageName": "is-number"})
        assert denied.status_code == 402
        assert denied.json()["error"].startswith("Payment required")

        wrong_key = client.post(
            "/audit",
            headers={"x-api-key": "not-the-key"},
            json={"packageName": "test-pkg-child-success"},
        )
        assert wrong_key.status_code == 402

        # 'no launch' made falsifiable: zero session rows after both refusals
        assert _session_count(tmp_path) == 0

        missing = client.get("/audit/not-real/report")
        assert missing.status_code == 404

        accepted = client.post(
            "/audit",
            headers={"x-api-key": "test-cre-key"},
            json={"packageName": "test-pkg-child-success"},
        )
        assert accepted.status_code == 202
        body = accepted.json()
        assert body["status"] == "accepted"
        assert isinstance(body["auditId"], str) and body["auditId"]
        assert isinstance(body["queuePosition"], int) and body["queuePosition"] >= 0
        assert _session_count(tmp_path) == 1  # positive pair: the CRE launch DID land
        # The accepted audit runs in the background; lifespan shutdown awaits it,
        # and every write lands under tmp_path (see fixture) — no repo residue.


@pytest.mark.parametrize("base", BASES)
def test_invalid_json_body_is_a_400(make_app, base) -> None:
    """C6+C2: malformed JSON is rejected uniformly on both bases."""
    with TestClient(make_app()) as client:
        invalid = client.post(f"{base}/audit", content="not-json")
        assert invalid.status_code == 400
        assert invalid.json() == {"error": "Invalid JSON body"}


@pytest.mark.parametrize("payload", BAD_AUDIT_PAYLOADS)
@pytest.mark.parametrize("base", BASES)
def test_invalid_audit_request_matrix(make_app, tmp_path, base, payload) -> None:
    """C7+C2: bad package names and versions 400 with pydantic details on both
    /audit and /audit/stream, and no audit is launched — proven by zero session
    rows in the DB, not just the absence of an auditId in the response."""
    with TestClient(make_app()) as client:
        for route in ("/audit", "/audit/stream"):
            response = client.post(f"{base}{route}", json=payload)
            assert response.status_code == 400, (route, payload, response.text)
            assert response.json()["error"] == "Invalid request"
            assert "auditId" not in response.json()
        assert _session_count(tmp_path) == 0  # a launch-despite-400 would fail here
