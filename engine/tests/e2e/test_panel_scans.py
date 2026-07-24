# CLASS MAP — panel repo scan + detail + scan-progress SSE (e2e: real engine,
# real GitHub stub behind HTTP, deterministic via cache hits).
# Axes: dep verdict class (SAFE / DANGEROUS / uncached-miss) × scan lifecycle ×
#       the 4->2-state rollup × the UNNAMED scan SSE.
#   S-scan-1  full sign-in → orgs/repos mirror → POST /panel/repo/:id/scan:
#             - deps pre-seeded as CACHE HITS via data/reports (one DANGEROUS,
#               one SAFE) land verdicts with no real audit/docker [C1]
#             - one uncached dep is a real cache-MISS: it fans a panel job into
#               AuditService, whose audit deterministically FAILS against the
#               hermetic-dead registry, so the dep settles verdict=null +
#               jobState='failed' (the 4->2 rule: a failed audit is NEVER SAFE
#               and NEVER a non-null UNKNOWN verdict) [C2]
#             - GET /panel/repo/:owner/:name rollup is worst-dep-wins DANGEROUS,
#               unknown counts the pending/failed dep, suspect always 0 [C3]
#             - GET /panel/scan/:id/events streams UNNAMED (data-only) frames:
#               a {type:'progress'} snapshot + a terminal {type:'done'} [C4]
# (The 409-already-running, 402-cap, and 422-no-lockfile branches are covered by
#  the route unit surface; this e2e proves the deterministic cache-hit happy path
#  end to end.)
#
# NOTE (determinism): the happy-path per-dep verdicts come from CACHE HITS, so no
# Docker/LLM/registry is exercised for them. The real cache-MISS fan-out through
# AuditService.admit -> future -> verdict-index is unit-proven in
# tests/test_panel_jobs.py with a fake AuditService; here the single miss is
# steered into a fast, deterministic audit FAILURE (dead registry) so the scan
# still reaches a terminal state without real audit infrastructure.
#
# Blackbox: engine HTTP API (cookies, redirects, JSON, SSE stream).

from __future__ import annotations

import json
import time
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

pytestmark = pytest.mark.e2e

HTTP_TIMEOUT_SECONDS = 30.0
SCAN_DONE_TIMEOUT_SECONDS = 90.0
SSE_READ_TIMEOUT_SECONDS = 30.0

ENCRYPTION_KEY = "00" * 32
OAUTH_CODE = "stub_code"
USER_TOKEN = "user_tok"

# A package-lock.json v3 with two direct deps (both pre-seeded cache hits) and
# one transitive dep with NO report — a real cache miss that fans out a job.
LOCKFILE_CONTENT = json.dumps(
    {
        "lockfileVersion": 3,
        "packages": {
            "": {"dependencies": {"safe-dep": "^1.0.0", "danger-dep": "^2.0.0"}},
            "node_modules/safe-dep": {"version": "1.0.0"},
            "node_modules/danger-dep": {"version": "2.0.0"},
            "node_modules/pending-dep": {"version": "3.0.0"},
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


def _github_env(*, api_base: str, private_key_path: str, panel_base_url: str) -> dict[str, str]:
    return {
        "NPMGUARD_GITHUB_APP_ID": "12345",
        "NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH": private_key_path,
        "NPMGUARD_GITHUB_CLIENT_ID": "Iv1.testclient",
        "NPMGUARD_GITHUB_CLIENT_SECRET": "test-client-secret",
        "NPMGUARD_ENCRYPTION_KEY": ENCRYPTION_KEY,
        "NPMGUARD_GITHUB_API_BASE": api_base,
        "NPMGUARD_PANEL_BASE_URL": panel_base_url,
    }


def _seed_report(reports_dir: Path, name: str, version: str, report: dict) -> None:
    """Write a report file the boot-time verdict-index rebuild turns into a
    package_verdicts cache hit (so the dep needs no real audit)."""
    directory = reports_dir / name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{version}.json").write_text(
        json.dumps(report) + "\n", encoding="utf-8"
    )


def _sign_in(client: httpx.Client, base: str, github_stub) -> None:
    """Drive the full OAuth web flow so the ng_session cookie + gh_users row
    exist, then mirror orgs + repos into the DB (installations, user_installations,
    repos — everything the scan authorization + caps read)."""
    login = client.get(f"{base}/api/auth/github/login")
    assert login.status_code == 302, login.text
    authorized = client.get(login.headers["location"])
    assert authorized.status_code == 302
    callback = client.get(authorized.headers["location"])
    assert callback.status_code == 302, callback.text
    assert "ng_session" in client.cookies

    orgs = client.get(f"{base}/api/panel/orgs")
    assert orgs.status_code == 200, orgs.text
    repos = client.get(f"{base}/api/panel/repos")
    assert repos.status_code == 200, repos.text


def _poll_scan_done(client: httpx.Client, base: str) -> dict:
    deadline = time.monotonic() + SCAN_DONE_TIMEOUT_SECONDS
    last: dict = {}
    while time.monotonic() < deadline:
        detail = client.get(f"{base}/api/panel/repo/acme/web")
        assert detail.status_code == 200, detail.text
        last = detail.json()
        scan = last.get("scan")
        if scan and scan["status"] == "done":
            return last
        time.sleep(0.5)
    raise AssertionError(f"scan did not reach 'done' in time; last detail: {last}")


def _read_sse_frames(client: httpx.Client, base: str, scan_id: int) -> list[dict]:
    """Read the UNNAMED scan SSE until the terminal {type:'done'} frame."""
    frames: list[dict] = []
    with client.stream(
        "GET",
        f"{base}/api/panel/scan/{scan_id}/events",
        timeout=SSE_READ_TIMEOUT_SECONDS,
    ) as response:
        assert response.status_code == 200, response.read()
        assert "text/event-stream" in response.headers["content-type"]
        for line in response.iter_lines():
            if not line.startswith("data:"):
                continue  # unnamed frames only: there is NO `event:` line
            payload = json.loads(line[len("data:") :].strip())
            frames.append(payload)
            if payload.get("type") == "done":
                break
    return frames


def test_s_scan_1_cache_hit_scan_rollup_and_sse(engine_factory, github_stub, app_private_key):
    """S-scan-1 [C1-C4]: pre-seeded cache-hit deps + one failing miss → scan
    reaches done, rollup is worst-dep-wins DANGEROUS, the pending dep is
    verdict=null+jobState, and the UNNAMED SSE emits progress + done."""
    github_stub.set_oauth_code(OAUTH_CODE, USER_TOKEN)
    github_stub.set_user(USER_TOKEN, id=42, login="octocat", email="mona@example.com")
    github_stub.add_installation(500, account_login="acme", account_type="Organization")
    github_stub.add_repo("acme", "web", id=1001, installation_id=500)
    github_stub.set_lockfile("acme", "web", "package-lock.json", LOCKFILE_CONTENT)

    harness = engine_factory(start=False)
    reports = harness.data_dir / "reports"
    _seed_report(
        reports, "safe-dep", "1.0.0", {"verdict": "SAFE", "rationale": "clean", "confirmedHypIds": []}
    )
    _seed_report(
        reports,
        "danger-dep",
        "2.0.0",
        {"verdict": "DANGEROUS", "rationale": "exfiltrates env", "confirmedHypIds": ["h1", "h2"]},
    )
    harness.extra_env = _github_env(
        api_base=github_stub.base_url,
        private_key_path=app_private_key,
        panel_base_url=harness.base_url,
    )
    harness.start()
    base = harness.base_url

    with httpx.Client(follow_redirects=False, timeout=HTTP_TIMEOUT_SECONDS) as client:
        _sign_in(client, base, github_stub)

        # POST scan → 200 {scanId}; the cache-hit deps need no audit, the single
        # miss (pending-dep) fans a job that fails fast against the dead registry.
        scan_resp = client.post(f"{base}/api/panel/repo/1001/scan")
        assert scan_resp.status_code == 200, scan_resp.text
        scan_id = scan_resp.json()["scanId"]
        assert isinstance(scan_id, int)

        detail = _poll_scan_done(client, base)

        # C3: rollup is worst-dep-wins DANGEROUS; unknown counts the failed/pending
        # dep; suspect is always 0 (never produced by the dev 2-state engine).
        rollup = detail["rollup"]
        assert rollup["verdict"] == "DANGEROUS", rollup
        assert rollup["dangerous"] == 1
        assert rollup["safe"] == 1
        assert rollup["unknown"] == 1
        assert rollup["suspect"] == 0

        deps = {d["name"]: d for d in detail["deps"]}
        # C1: cache-hit verdicts.
        assert deps["danger-dep"]["verdict"] == "DANGEROUS"
        assert deps["danger-dep"]["evidenceCount"] == 2
        assert deps["danger-dep"]["direct"] is True
        assert deps["safe-dep"]["verdict"] == "SAFE"
        assert deps["safe-dep"]["direct"] is True
        # C2: the uncached dep is verdict=null with a jobState — NEVER SAFE and
        # never a non-null verdict. A failed audit resolves jobState to 'failed'.
        pending = deps["pending-dep"]
        assert pending["verdict"] is None, pending
        assert pending["jobState"] == "failed", pending
        assert pending["direct"] is False

        # The finished scan carries the rollup verdict.
        assert detail["scan"]["status"] == "done"
        assert detail["scan"]["verdict"] == "DANGEROUS"

        # C4: the UNNAMED SSE emits a progress snapshot + a terminal done frame.
        frames = _read_sse_frames(client, base, scan_id)
        types = [f["type"] for f in frames]
        assert "progress" in types, frames
        assert frames[-1] == {"type": "done"}, frames
        progress = next(f for f in frames if f["type"] == "progress")
        assert progress["status"] == "done"
        assert progress["total"] == 3
        # dep frames carry the verdict + jobState the detail view shows.
        dep_frames = {f["name"]: f for f in frames if f["type"] == "dep"}
        assert dep_frames["danger-dep"]["verdict"] == "DANGEROUS"
        assert dep_frames["pending-dep"]["verdict"] is None
