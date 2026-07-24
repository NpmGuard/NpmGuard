# CLASS MAP — panel protect + GitHub webhooks + registry-watch/alert wiring
# (e2e: real uvicorn engine, real GitHub stub behind HTTP, deterministic via
#  pre-seeded cache-hit verdicts — NO real audit/docker/registry).
# Axes: protect toggle × watched-packages sync × the protect cap (402) × a
#       signed vs forged push webhook × the GitHub check-run conclusion × the
#       DANGEROUS-exposure alert row.
#
#   S-pw-1  protect a repo whose deps are pre-seeded cache hits → the background
#           full scan indexes repo_deps and sync_watched_packages populates
#           watched_packages with exactly the protected repo's dep set [C1];
#           a SECOND protect over a FREE cap of 1 → 402 {cap:true,
#           resource:'protected_repos'} [C2]; the DANGEROUS dep, fanned out via
#           the WIRED handle_dangerous_verdict over the engine's real persisted
#           exposure, writes an alert row surfaced by GET /panel/repo/:o/:n [C3].
#           (The worker->on_dangerous binding itself is unit-proven in
#           tests/test_panel_jobs.py; a fresh DANGEROUS verdict needs docker —
#           confirm requires running experiments — so it is un-mintable here, and
#           the fan-out is driven over the engine's real DB state instead.)
#
#   S-pw-2  a FORGED-signature push → 401 and ZERO work (no check run, no scan)
#           [C4]; a correctly HMAC-signed push that MODIFIES the root lockfile on
#           a protected repo → 202, then the delta scan opens an in_progress
#           check run (POST) and — the new dep being a SAFE cache hit — concludes
#           it 'success' (PATCH) on the stub [C5]. This proves the create+
#           conclude check-run seam is wired end to end (conclusion is the seam
#           the wire stage had to close: conclude_check_run was defined but
#           never called until finalize_check bound it into refresh_scan_progress).
#
# NOTE (determinism): every per-dep verdict is a pre-seeded cache HIT, so no
# Docker/LLM/registry runs. The registry-watch + reconcile POLL LOOP timing is
# covered by the unit tests (tests/test_panel_watch.py), not wall-clock here — a
# 30s first-run delay means those loops never fire inside this test's window.
#
# Blackbox: engine HTTP API (cookies, redirects, JSON, webhook 202/401) + the
# GitHub stub's recorded check_runs + a direct read of the engine's sqlite DB.

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from pathlib import Path

import httpx
import pytest
import sqlalchemy as sa
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from kit_spine import make_engine, make_session_factory
from npmguard.panel.alerts.notify import handle_dangerous_verdict
from npmguard.panel.tables import watched_packages

pytestmark = pytest.mark.e2e

HTTP_TIMEOUT_SECONDS = 30.0
SCAN_DONE_TIMEOUT_SECONDS = 90.0
CHECK_RUN_TIMEOUT_SECONDS = 60.0

ENCRYPTION_KEY = "00" * 32
WEBHOOK_SECRET = "test-webhook-secret"
OAUTH_CODE = "stub_code"
USER_TOKEN = "user_tok"
HEAD_SHA = "a" * 40

# acme/web: two direct deps, both pre-seeded cache hits (one SAFE, one DANGEROUS).
WEB_LOCKFILE = json.dumps(
    {
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"safe-a": "^1.0.0", "danger-dep": "^2.0.0"}},
            "node_modules/safe-a": {"version": "1.0.0"},
            "node_modules/danger-dep": {"version": "2.0.0"},
        },
    }
)
# acme/api: one direct dep — a second auditable, protectable repo (for the cap).
API_LOCKFILE = json.dumps(
    {
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"safe-a": "^1.0.0"}},
            "node_modules/safe-a": {"version": "1.0.0"},
        },
    }
)
# The lockfile acme/web has AFTER a push that adds a new (SAFE cache-hit) dep.
WEB_LOCKFILE_PLUS_NEW = json.dumps(
    {
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"safe-a": "^1.0.0", "new-dep": "^1.0.0"}},
            "node_modules/safe-a": {"version": "1.0.0"},
            "node_modules/new-dep": {"version": "1.0.0"},
        },
    }
)


@pytest.fixture
def app_private_key(tmp_path: Path) -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    path = tmp_path / "app-key.pem"
    path.write_bytes(pem)
    return str(path)


def _github_env(
    *,
    api_base: str,
    private_key_path: str,
    panel_base_url: str,
    extra: dict[str, str] | None = None,
) -> dict[str, str]:
    env = {
        "NPMGUARD_GITHUB_APP_ID": "12345",
        "NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH": private_key_path,
        "NPMGUARD_GITHUB_CLIENT_ID": "Iv1.testclient",
        "NPMGUARD_GITHUB_CLIENT_SECRET": "test-client-secret",
        "NPMGUARD_ENCRYPTION_KEY": ENCRYPTION_KEY,
        "NPMGUARD_GITHUB_API_BASE": api_base,
        "NPMGUARD_PANEL_BASE_URL": panel_base_url,
    }
    if extra:
        env.update(extra)
    return env


def _seed_report(reports_dir: Path, name: str, version: str, report: dict) -> None:
    directory = reports_dir / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{version}.json").write_text(
        json.dumps(report) + "\n", encoding="utf-8"
    )


def _safe(name: str) -> dict:
    return {"verdict": "SAFE", "rationale": "clean", "confirmedHypIds": []}


def _dangerous() -> dict:
    return {"verdict": "DANGEROUS", "rationale": "exfiltrates env", "confirmedHypIds": ["h1"]}


def _sign_in(client: httpx.Client, base: str) -> None:
    login = client.get(f"{base}/api/auth/github/login")
    assert login.status_code == 302, login.text
    authorized = client.get(login.headers["location"])
    assert authorized.status_code == 302
    callback = client.get(authorized.headers["location"])
    assert callback.status_code == 302, callback.text
    assert "ng_session" in client.cookies
    assert client.get(f"{base}/api/panel/orgs").status_code == 200
    assert client.get(f"{base}/api/panel/repos").status_code == 200


def _wait_scan_done(client: httpx.Client, base: str, full_name: str) -> dict:
    deadline = time.monotonic() + SCAN_DONE_TIMEOUT_SECONDS
    last: dict = {}
    while time.monotonic() < deadline:
        detail = client.get(f"{base}/api/panel/repo/{full_name}")
        assert detail.status_code == 200, detail.text
        last = detail.json()
        scan = last.get("scan")
        if scan and scan["status"] == "done":
            return last
        time.sleep(0.5)
    raise AssertionError(f"scan did not reach 'done' in time; last detail: {last}")


def _session_factory(db_url: str):
    engine = make_engine(db_url)
    return engine, make_session_factory(engine)


def test_s_pw_1_protect_syncs_watch_cap_and_alert(
    engine_factory, github_stub, app_private_key
):
    """S-pw-1 [C1-C3]: protect → watched_packages synced to the repo's deps; a
    second protect over a free cap of 1 → 402; the DANGEROUS dep's fan-out writes
    an alert row surfaced by the repo-detail route."""
    github_stub.set_oauth_code(OAUTH_CODE, USER_TOKEN)
    github_stub.set_user(USER_TOKEN, id=42, login="octocat", email="mona@example.com")
    github_stub.add_installation(500, account_login="acme", account_type="Organization")
    github_stub.add_repo("acme", "web", id=1001, installation_id=500)
    github_stub.add_repo("acme", "api", id=1002, installation_id=500)
    github_stub.set_lockfile("acme", "web", "package-lock.json", WEB_LOCKFILE)
    github_stub.set_lockfile("acme", "api", "package-lock.json", API_LOCKFILE)

    harness = engine_factory(start=False)
    reports = harness.data_dir / "reports"
    _seed_report(reports, "safe-a", "1.0.0", _safe("safe-a"))
    _seed_report(reports, "danger-dep", "2.0.0", _dangerous())
    harness.extra_env = _github_env(
        api_base=github_stub.base_url,
        private_key_path=app_private_key,
        panel_base_url=harness.base_url,
        # Free plan capped at ONE protected repo so the 2nd protect trips 402.
        extra={"NPMGUARD_FREE_MAX_PROTECTED_REPOS": "1"},
    )
    harness.start()
    base = harness.base_url

    with httpx.Client(follow_redirects=False, timeout=HTTP_TIMEOUT_SECONDS) as client:
        _sign_in(client, base)

        # C1: protect acme/web → 200; the background full scan (cache hits, no
        # audit) indexes repo_deps and watch-syncs.
        protect = client.post(f"{base}/api/panel/repo/1001/protect")
        assert protect.status_code == 200, protect.text
        assert protect.json() == {"ok": True}
        _wait_scan_done(client, base, "acme/web")

        # C2: a second protect over the free cap of 1 → 402 with the cap body the
        # frontend keys on (field, not message).
        over_cap = client.post(f"{base}/api/panel/repo/1002/protect")
        assert over_cap.status_code == 402, over_cap.text
        body = over_cap.json()
        assert body["cap"] is True
        assert body["resource"] == "protected_repos"
        assert body["installationId"] == 500

        # C3: the DANGEROUS dep's fan-out (the same handle_dangerous_verdict the
        # worker fires) writes an alert over the engine's real persisted exposure.
        db_engine, sessions = _session_factory(harness.db_url)

        async def _drive() -> tuple[int, set[str]]:
            try:
                inserted = await handle_dangerous_verdict(
                    sessions, "danger-dep", "2.0.0", source="scan", settings=None
                )
                async with sessions() as session:
                    watched = set(
                        (
                            await session.execute(sa.select(watched_packages.c.name))
                        ).scalars().all()
                    )
                return inserted, watched
            finally:
                await db_engine.dispose()

        inserted, watched = asyncio.run(_drive())

        # C1: watched_packages is exactly the protected repo's dep set.
        assert watched == {"safe-a", "danger-dep"}, watched
        # C3: one alert row inserted for the exposed protected repo.
        assert inserted == 1, inserted

        detail = client.get(f"{base}/api/panel/repo/acme/web").json()
        alerts = detail["alerts"]
        assert len(alerts) == 1, alerts
        alert = alerts[0]
        assert alert["packageName"] == "danger-dep"
        assert alert["version"] == "2.0.0"
        assert alert["verdict"] == "DANGEROUS"
        assert alert["kind"] == "scan"
        assert alert["org"] == "acme"


def _post_webhook(
    client: httpx.Client, base: str, body: bytes, *, signature: str
) -> httpx.Response:
    return client.post(
        f"{base}/webhooks/github",
        content=body,
        headers={
            "content-type": "application/json",
            "x-github-event": "push",
            "x-hub-signature-256": signature,
        },
    )


def _sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def test_s_pw_2_push_webhook_delta_check_and_forged_signature(
    engine_factory, github_stub, app_private_key
):
    """S-pw-2 [C4-C5]: a forged-signature push → 401 + no work; a signed push
    modifying the root lockfile on a protected repo → 202 → delta scan opens +
    concludes a GitHub check run on the stub."""
    github_stub.set_oauth_code(OAUTH_CODE, USER_TOKEN)
    github_stub.set_user(USER_TOKEN, id=42, login="octocat", email="mona@example.com")
    github_stub.add_installation(500, account_login="acme", account_type="Organization")
    github_stub.add_repo("acme", "web", id=1001, installation_id=500)
    github_stub.set_lockfile("acme", "web", "package-lock.json", API_LOCKFILE)

    harness = engine_factory(start=False)
    reports = harness.data_dir / "reports"
    _seed_report(reports, "safe-a", "1.0.0", _safe("safe-a"))
    _seed_report(reports, "new-dep", "1.0.0", _safe("new-dep"))
    harness.extra_env = _github_env(
        api_base=github_stub.base_url,
        private_key_path=app_private_key,
        panel_base_url=harness.base_url,
        extra={"NPMGUARD_GITHUB_WEBHOOK_SECRET": WEBHOOK_SECRET},
    )
    harness.start()
    base = harness.base_url

    push_payload = {
        "ref": "refs/heads/main",
        "after": HEAD_SHA,
        "repository": {"id": 1001, "full_name": "acme/web"},
        "head_commit": {"modified": ["package-lock.json"], "added": [], "removed": []},
    }
    body = json.dumps(push_payload).encode()

    with httpx.Client(follow_redirects=False, timeout=HTTP_TIMEOUT_SECONDS) as client:
        _sign_in(client, base)
        protect = client.post(f"{base}/api/panel/repo/1001/protect")
        assert protect.status_code == 200, protect.text
        _wait_scan_done(client, base, "acme/web")

        # C4: a FORGED signature → 401, and NO webhook work is scheduled.
        forged = _post_webhook(client, base, body, signature=_sign("wrong-secret", body))
        assert forged.status_code == 401, forged.text
        assert github_stub.check_runs == [], github_stub.check_runs

        # The push adds a new (SAFE cache-hit) dep to the root lockfile.
        github_stub.set_lockfile("acme", "web", "package-lock.json", WEB_LOCKFILE_PLUS_NEW)

        # C5: a correctly signed push → 202 fast; the delta scan runs in the
        # background, opening + concluding a check run on the stub.
        signed = _post_webhook(client, base, body, signature=_sign(WEBHOOK_SECRET, body))
        assert signed.status_code == 202, signed.text
        assert signed.json() == {"ok": True}

        deadline = time.monotonic() + CHECK_RUN_TIMEOUT_SECONDS
        while time.monotonic() < deadline:
            methods = [c["method"] for c in github_stub.check_runs]
            if "POST" in methods and "PATCH" in methods:
                break
            time.sleep(0.5)
        methods = [c["method"] for c in github_stub.check_runs]
        assert "POST" in methods, github_stub.check_runs
        assert "PATCH" in methods, github_stub.check_runs

        created = next(c for c in github_stub.check_runs if c["method"] == "POST")
        assert created["body"]["status"] == "in_progress"
        assert created["body"]["head_sha"] == HEAD_SHA
        concluded = next(c for c in github_stub.check_runs if c["method"] == "PATCH")
        # The one new dep is a SAFE cache hit → the delta rollup is SAFE → the
        # check is concluded 'success' (fail-only-on-DANGEROUS trust contract).
        assert concluded["body"]["status"] == "completed"
        assert concluded["body"]["conclusion"] == "success"
