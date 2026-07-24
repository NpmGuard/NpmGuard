# CLASS MAP — panel auth + orgs/repos (e2e: real engine, real GitHub stub behind HTTP)
# Axes: App configured? × session present? × OAuth token usable? × repo auditable?
#   S-panel-1  configured engine, full OAuth web flow (login → stub authorize → callback):
#              - callback 302 → {panel_base}/dashboard, ng_session cookie set [C1]
#              - gh_users + gh_sessions rows written; OAuth tokens stored ENCRYPTED,
#                never plaintext (the 3-part AES-GCM blob, "user_tok" absent) [C2]
#              - GET /me returns the SessionUser projection {id,login,name,email,avatarUrl} [C3]
#              - GET /panel/orgs mirrors the stub installations + installUrl (App slug) [C4]
#              - GET /panel/repos lists the auditable repo, FILTERS the lockfile-less one [C5]
#   S-panel-2  no session → /me 401, /panel/orgs 401 "Not signed in" [C6]
#   S-panel-3  App NOT configured (no NPMGUARD_GITHUB_* env): engine boots + /health ok,
#              every panel route 503 {"error":"GitHub App is not configured on this server"} [C7]
# Adversarial pass: "does a happy-path OAuth leave the raw token on disk?" — answered by
#   the C2 plaintext-absence probe reading the sqlite file directly, not the API.
#
# Blackbox: engine HTTP API (cookies, redirects, JSON) + the sqlite file on disk.

from __future__ import annotations

import sqlite3
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

pytestmark = pytest.mark.e2e

HTTP_TIMEOUT_SECONDS = 30.0

# A minimal but present root lockfile — find_root_lockfile only checks the root
# listing for the filename, so the content need only exist.
LOCKFILE_CONTENT = '{"lockfileVersion": 3, "packages": {}}'

ENCRYPTION_KEY = "00" * 32  # 32-byte hex; value is irrelevant, only the shape.
OAUTH_CODE = "stub_code"  # the code GitHubStub.authorize emits by default.
USER_TOKEN = "user_tok"  # the OAuth access token the stub hands back.


@pytest.fixture
def app_private_key(tmp_path: Path) -> str:
    """A throwaway RSA private key on disk for the App-JWT signing path.

    The stub trusts any Bearer, so the key only has to be a valid PEM githubkit
    can sign an App JWT with — it is never verified.
    """
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


def _sqlite_path(db_url: str) -> str:
    return db_url.split("///", 1)[1]


def test_s_panel_1_oauth_flow_orgs_repos(engine_factory, github_stub, app_private_key):
    """S-panel-1: full sign-in, encrypted tokens, /me, orgs mirror, repos filter."""
    # Seed the GitHub stub: OAuth code → token → user identity, one org install
    # with an auditable repo (root lockfile) and a non-auditable one (no lockfile).
    github_stub.set_oauth_code(OAUTH_CODE, USER_TOKEN)
    github_stub.set_user(
        USER_TOKEN,
        id=42,
        login="octocat",
        name="Mona Octocat",
        email="mona@example.com",
    )
    github_stub.add_installation(500, account_login="acme", account_type="Organization")
    github_stub.add_repo("acme", "web", id=1001, installation_id=500)
    github_stub.set_lockfile("acme", "web", "package-lock.json", LOCKFILE_CONTENT)
    github_stub.add_repo("acme", "docs", id=1002, installation_id=500)  # no lockfile

    # PANEL_BASE_URL points at the engine itself so the whole OAuth redirect
    # chain (login → stub authorize → callback → /dashboard) resolves back here.
    harness = engine_factory(start=False)
    harness.extra_env = _github_env(
        api_base=github_stub.base_url,
        private_key_path=app_private_key,
        panel_base_url=harness.base_url,
    )
    harness.start()
    base = harness.base_url

    with httpx.Client(follow_redirects=False, timeout=HTTP_TIMEOUT_SECONDS) as client:
        # 1. login → 302 to the stub's authorize URL, ng_oauth_state cookie set.
        login = client.get(f"{base}/api/auth/github/login")
        assert login.status_code == 302, login.text
        authorize_url = login.headers["location"]
        assert authorize_url.startswith(github_stub.base_url)
        assert "ng_oauth_state" in client.cookies

        # 2. stub authorize → 302 back to the engine callback with code + state.
        authorized = client.get(authorize_url)
        assert authorized.status_code == 302
        callback_url = authorized.headers["location"]
        assert "/api/auth/github/callback" in callback_url

        # 3. callback → upsert + session, 302 to /dashboard, ng_session cookie set.
        callback = client.get(callback_url)
        assert callback.status_code == 302, callback.text
        assert callback.headers["location"].endswith("/dashboard")
        assert "ng_session" in client.cookies

        # C3: /me returns the SessionUser projection.
        me = client.get(f"{base}/api/me")
        assert me.status_code == 200, me.text
        user = me.json()["user"]
        assert user == {
            "id": 42,
            "login": "octocat",
            "name": "Mona Octocat",
            "email": "mona@example.com",
            "avatarUrl": "https://avatars.example/octocat.png",
        }

        # C4: /panel/orgs mirrors the stub installations + the App install URL.
        orgs = client.get(f"{base}/api/panel/orgs")
        assert orgs.status_code == 200, orgs.text
        orgs_body = orgs.json()
        assert orgs_body["installations"] == [
            {
                "id": 500,
                "accountLogin": "acme",
                "accountType": "Organization",
                "suspended": False,
            }
        ]
        assert orgs_body["installUrl"].endswith("/apps/npmguard/installations/new")

        # C5: /panel/repos lists the auditable repo and filters the lockfile-less one.
        repos = client.get(f"{base}/api/panel/repos")
        assert repos.status_code == 200, repos.text
        repos_body = repos.json()["repos"]
        full_names = {r["fullName"] for r in repos_body}
        assert full_names == {"acme/web"}
        web = next(r for r in repos_body if r["fullName"] == "acme/web")
        assert web["installationId"] == 500
        assert web["defaultBranch"] == "main"
        assert web["protected"] is False
        assert web["lastScan"] is None

    # C2: tokens are encrypted at rest — the plaintext token is nowhere on disk,
    # the stored blob is the 3-part AES-GCM format, and both rows exist.
    db_path = _sqlite_path(harness.db_url)
    connection = sqlite3.connect(db_path)
    try:
        access_enc, refresh_enc = connection.execute(
            "SELECT access_token_enc, refresh_token_enc FROM gh_users WHERE id = 42"
        ).fetchone()
        session_count = connection.execute(
            "SELECT COUNT(*) FROM gh_sessions"
        ).fetchone()[0]
    finally:
        connection.close()

    assert session_count == 1
    assert USER_TOKEN not in (access_enc or "")
    assert access_enc.count(".") == 2  # base64(iv).base64(tag).base64(ct)
    assert refresh_enc is None  # this App issues non-expiring tokens (no refresh)

    # Raw plaintext token must not appear anywhere in the sqlite file bytes.
    assert USER_TOKEN.encode() not in Path(db_path).read_bytes()


def test_s_panel_2_unauthenticated(engine_factory, github_stub, app_private_key):
    """S-panel-2: a configured engine with no session → 401 on /me and /panel/orgs."""
    harness = engine_factory(start=False)
    harness.extra_env = _github_env(
        api_base=github_stub.base_url,
        private_key_path=app_private_key,
        panel_base_url=harness.base_url,
    )
    harness.start()

    me = httpx.get(f"{harness.base_url}/api/me", timeout=HTTP_TIMEOUT_SECONDS)
    assert me.status_code == 401
    assert me.json() == {"error": "Not signed in"}

    orgs = httpx.get(f"{harness.base_url}/api/panel/orgs", timeout=HTTP_TIMEOUT_SECONDS)
    assert orgs.status_code == 401
    assert orgs.json()["error"] == "Not signed in"


def test_s_panel_3_app_not_configured(engine_factory):
    """S-panel-3: without the GitHub App env the engine boots and every panel
    route 503s — the engine is otherwise unaffected."""
    harness = engine_factory()  # no github env → github_app_enabled is False

    health = httpx.get(f"{harness.base_url}/health", timeout=HTTP_TIMEOUT_SECONDS)
    assert health.status_code == 200

    disabled_body = {"error": "GitHub App is not configured on this server"}
    for path in ("/api/panel/orgs", "/api/panel/repos", "/api/me"):
        response = httpx.get(f"{harness.base_url}{path}", timeout=HTTP_TIMEOUT_SECONDS)
        assert response.status_code == 503, f"{path}: {response.text}"
        assert response.json() == disabled_body
