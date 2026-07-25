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
#   C6 invalid JSON body              → 400 ValidationFailed with details == []
#   C7 invalid AuditRequest matrix    — traversal/uppercase/empty/overlong names,
#      bad semver → 400 ValidationFailed, every issue naming its field, no launch
#   C8 unknown audit id               → 404 report
#   C9 the 400 body is EXACTLY the declared shape — no undeclared key, and none of
#      pydantic's own error keys (`type`, `input`) inside an issue
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
from npmguard.contract import models as contract

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
    """C6+C2: malformed JSON is rejected uniformly on both bases, as the contract's
    ValidationFailed with an EMPTY issue list — the one reachable way `details` is
    empty, since pydantic never reports a validation failure with zero issues. That
    is what lets a client tell "your JSON is malformed" from "your fields are wrong"
    without reading the prose in `error`."""
    with TestClient(make_app()) as client:
        invalid = client.post(f"{base}/audit", content="not-json")
        assert invalid.status_code == 400
        body = invalid.json()
        assert body == {"error": "Invalid JSON body", "details": []}
        assert contract.ValidationFailed.model_validate(body).details == []


@pytest.mark.parametrize("payload", BAD_AUDIT_PAYLOADS)
@pytest.mark.parametrize("base", BASES)
def test_invalid_audit_request_matrix(make_app, tmp_path, base, payload) -> None:
    """C7+C2: bad package names and versions 400 with the contract's ValidationFailed
    on both /audit and /audit/stream, and no audit is launched — proven by zero
    session rows in the DB, not just the absence of an auditId in the response."""
    with TestClient(make_app()) as client:
        for route in ("/audit", "/audit/stream"):
            response = client.post(f"{base}{route}", json=payload)
            assert response.status_code == 400, (route, payload, response.text)
            body = response.json()
            assert body["error"] == "Invalid request"
            assert "auditId" not in body
            parsed = contract.ValidationFailed.model_validate(body)
            # Non-empty — the empty list is reserved for unparseable JSON — and each
            # issue carries a MESSAGE naming the rule that failed. That message is what
            # distinguishes "invalid npm package name" from "invalid semver" from
            # "invalid txHash", since `error` is the fixed string asserted above; a
            # client that had to tell them apart without `details` would have to sniff
            # prose, which this contract forbids.
            assert parsed.details
            assert all(issue.message for issue in parsed.details)
            # FINDING, pinned rather than blessed: `field` is `""` for most of this
            # matrix. `validation.py` enforces the package-name and semver rules in a
            # `model_validator(mode="after")`, which pydantic reports with an empty
            # `loc` because the rule is declared about the body rather than about a
            # key — so only the `Field(min_length/max_length)` rules name their field.
            # This was equally true of the raw pydantic `details` that used to be
            # emitted, so nothing was lost in declaring the shape; moving those two
            # rules to `field_validator`s would populate `field` for the whole matrix.
            assert {issue.field for issue in parsed.details} <= {"", "packageName", "version"}
        assert _session_count(tmp_path) == 0  # a launch-despite-400 would fail here


def test_a_field_level_rule_names_its_field(make_app) -> None:
    """C7: the half of `details` that already works — a bound declared with `Field`
    reports the key it is about, so `field` is a real path and not decoration."""
    with TestClient(make_app()) as client:
        body = client.post("/audit", json={"packageName": "a" * 215}).json()
        parsed = contract.ValidationFailed.model_validate(body)
        assert [issue.field for issue in parsed.details] == ["packageName"]


@pytest.mark.parametrize("base", BASES)
def test_the_400_body_carries_no_undeclared_key(make_app, base) -> None:
    """C9: the wire carries exactly what the contract declares. `_body` used to emit
    an undeclared `details` holding `PydanticValidationError.errors()` verbatim —
    invisible to a generated consumer, and available to be depended on by one
    hand-reading JSON. Asserted as key-set EQUALITY, because "no schema mentions it"
    is precisely the failure a key-membership check would let through again; and
    pydantic's own `type` / `input` keys must not reappear inside an issue, the
    latter because it echoes submitted values back out."""
    with TestClient(make_app()) as client:
        body = client.post(f"{base}/audit", json={"packageName": "../evil"}).json()
        assert set(body) == set(contract.ValidationFailed.model_fields)
        for issue in body["details"]:
            assert set(issue) == set(contract.ValidationIssue.model_fields)
