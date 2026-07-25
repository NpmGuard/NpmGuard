# CLASS MAP — the repo list's independence from the orgs route (e2e: real engine,
# real GitHub stub behind HTTP).
#   R1  a session that has NEVER called /panel/orgs still gets its repos from
#       /panel/repos. The route reads the user's installations from GitHub, not
#       from the `user_installations` mirror, which only /panel/orgs writes.
#
# WHY THIS EXISTS AS ITS OWN TEST: the dashboard fires /panel/orgs and
# /panel/repos CONCURRENTLY, so on a first sign-in /panel/repos could win the
# race, find an empty mirror, and answer `{"repos": []}` — a confident empty that
# is indistinguishable on the wire from "you have no auditable repositories", and
# that healed on reload so it read as a UI glitch rather than a lie. Every
# pre-existing Python test called the two routes in sequence (see
# `test_panel_scans._sign_in`), which is exactly why the sequence was never the
# thing under test. The browser tier found it; this pins it where a panel change
# is actually run.
#
# Blackbox: engine HTTP API.

from __future__ import annotations

import json

import httpx
import pytest

from tests.support.panel import github_env

pytestmark = pytest.mark.e2e

HTTP_TIMEOUT_SECONDS = 30.0
OAUTH_CODE = "stub_code"
USER_TOKEN = "user_tok"

LOCKFILE_CONTENT = json.dumps(
    {
        "lockfileVersion": 3,
        "packages": {"": {"dependencies": {"safe-dep": "^1.0.0"}}, "node_modules/safe-dep": {"version": "1.0.0"}},
    }
)


def test_r1_repos_route_does_not_depend_on_the_orgs_route(
    engine_factory, github_stub, app_private_key
):
    """R1: sign in, then call /panel/repos as the FIRST panel read of the
    session. The repo must be there — the assertion is the ORDER, so calling
    /panel/orgs anywhere before it would destroy the test."""
    github_stub.set_oauth_code(OAUTH_CODE, USER_TOKEN)
    github_stub.set_user(USER_TOKEN, id=42, login="octocat", email="mona@example.com")
    github_stub.add_installation(500, account_login="acme", account_type="Organization")
    github_stub.add_repo("acme", "web", id=1001, installation_id=500)
    github_stub.set_lockfile("acme", "web", "package-lock.json", LOCKFILE_CONTENT)

    harness = engine_factory(start=False)
    harness.extra_env = github_env(
        api_base=github_stub.base_url,
        private_key_path=app_private_key,
        panel_base_url=harness.base_url,
    )
    harness.start()
    base = harness.base_url

    with httpx.Client(follow_redirects=False, timeout=HTTP_TIMEOUT_SECONDS) as client:
        login = client.get(f"{base}/api/auth/github/login")
        authorized = client.get(login.headers["location"])
        callback = client.get(authorized.headers["location"])
        assert callback.status_code == 302, callback.text
        assert "ng_session" in client.cookies

        repos = client.get(f"{base}/api/panel/repos")
        assert repos.status_code == 200, repos.text
        listed = repos.json()["repos"]
        assert [repo["fullName"] for repo in listed] == ["acme/web"], listed
