import time

from fastapi.testclient import TestClient

from npmguard.api import create_app
from npmguard.config import get_settings


def test_api_mirror_and_complete_mock_audit(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr("npmguard.report_store.DATA_DIR", tmp_path / "reports")
    monkeypatch.setenv("NPMGUARD_ENV", "test")
    monkeypatch.setenv("NPMGUARD_PAYMENT_REQUIRED", "false")
    monkeypatch.setenv("NPMGUARD_MOCK_LLM", "true")
    monkeypatch.setenv("NPMGUARD_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'api.sqlite3'}")
    get_settings.cache_clear()
    with TestClient(create_app()) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/api/health").json() == {"status": "ok"}
        started = client.post("/audit/stream", json={"packageName": "test-pkg-child-success"})
        assert started.status_code == 200
        audit_id = started.json()["auditId"]
        for _ in range(100):
            report = client.get(f"/audit/{audit_id}/report")
            if report.status_code != 202:
                break
            time.sleep(0.02)
        assert report.status_code == 200
        assert report.json()["verdict"] == "SAFE"
        event_stream = client.get(f"/audit/{audit_id}/events")
        assert "event: verdict_reached" in event_stream.text
        assert f'"auditId":"{audit_id}"' in event_stream.text
    get_settings.cache_clear()


def test_payment_gate_and_validation_shapes(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("NPMGUARD_ENV", "test")
    monkeypatch.setenv("NPMGUARD_PAYMENT_REQUIRED", "true")
    monkeypatch.setenv("NPMGUARD_MOCK_LLM", "true")
    monkeypatch.setenv("NPMGUARD_CRE_API_KEY", "test-cre-key")
    monkeypatch.setenv("NPMGUARD_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'gate.sqlite3'}")
    get_settings.cache_clear()
    with TestClient(create_app()) as client:
        denied = client.post("/audit/stream", json={"packageName": "is-number"})
        assert denied.status_code == 402
        assert denied.json()["error"].startswith("Payment required")
        invalid = client.post("/audit", content="not-json")
        assert invalid.status_code == 400
        assert invalid.json() == {"error": "Invalid JSON body"}
        missing = client.get("/audit/not-real/report")
        assert missing.status_code == 404
        accepted = client.post(
            "/audit",
            headers={"x-api-key": "test-cre-key"},
            json={"packageName": "test-pkg-child-success"},
        )
        assert accepted.status_code == 202
        assert accepted.json()["status"] == "accepted"
        assert isinstance(accepted.json()["auditId"], str)
    get_settings.cache_clear()
