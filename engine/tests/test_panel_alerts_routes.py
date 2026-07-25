# CLASS MAP — the alerts feed routes (GET /panel/alerts, POST /panel/alerts/seen)
# (seam: the REAL FastAPI app in-process via TestClient with the panel enabled,
#  over a real throwaway sqlite seeded through the sqlite file itself. No GitHub
#  and no network: the App API base and the npm registry both point at a dead
#  port, and the registry watcher's first cycle is 30s out while these finish in
#  milliseconds. The routes are pure DB reads/writes, so this exercises the real
#  handler and the real SQL — the scoping join is the whole point.)
#
# Axes: App configured? × session present? × alert's org reachable by the user?
#       × seen state
#
# GET /panel/alerts
#   C1  signed in → the alerts of every org the user's installations cover
#   C2  ISOLATION: an alert in an org the user cannot reach is never returned
#   C3  ordering is created_at DESC, id DESC as the tie-break
#   C4  at most ALERTS_FEED_LIMIT rows, and it keeps the NEWEST ones
#   C5  wire shape is the camelCase projection; seen coerces to bool; a watch
#       alert with no repo carries repoId: null
#   C6  a user with no installations → 200 {"alerts": []}, never an error
#   C7  no session → 401 {"error": "Not signed in"}
#   C8  App not configured → 503 (route registered, panel dark)
# POST /panel/alerts/seen
#   C9  marks the user's unseen alerts seen and reports how many
#   C10 idempotent — a second call updates 0 and still returns ok
#   C11 ISOLATION: another org's unseen alert is left untouched
#   C12 no session → 401
#   C13 App not configured → 503
#

from __future__ import annotations

import contextlib
import sqlite3

import pytest
from fastapi.testclient import TestClient

from npmguard.api import create_app
from npmguard.config import get_settings
from npmguard.panel.routes.panel import ALERTS_FEED_LIMIT
from npmguard.panel.sessions import SESSION_COOKIE
from tests.support.harness import DEAD_URL
from tests.support.panel import github_env, write_app_private_key

BASES = ["", "/api"]

USER_ID = 42
SESSION_TOKEN = "a" * 64  # String(64); the store only looks it up verbatim.
FAR_FUTURE = "2099-01-01T00:00:00.000Z"
NOW = "2026-07-24T12:00:00.000Z"

MINE = "acme"  # org the user's installation covers
THEIRS = "initech"  # org the user must never see


@pytest.fixture
def panel_app(monkeypatch, tmp_path):
    """The real app with the panel ENABLED, all state under tmp_path.

    The suite-wide conftest disables the dotenv source, so the panel is off
    unless a test asks for it — this fixture is that ask, and it supplies test
    credentials only (never a developer's).
    """
    db_path = tmp_path / "panel.sqlite3"
    env = {
        "NPMGUARD_ENV": "test",
        "NPMGUARD_MOCK_LLM": "true",
        "NPMGUARD_PAYMENT_REQUIRED": "false",
        "NPMGUARD_DATABASE_URL": f"sqlite+aiosqlite:///{db_path}",
        "NPMGUARD_DATA_DIR": str(tmp_path / "data"),
        "NPMGUARD_AUDIT_LOG_DIR": str(tmp_path / "audit-logs"),
        # Nothing here should reach the network; if a background loop ever fires
        # early, it hits a closed port rather than the real registry/GitHub.
        "NPMGUARD_NPM_REGISTRY": DEAD_URL,
        **github_env(
            api_base=DEAD_URL,
            private_key_path=write_app_private_key(tmp_path),
            panel_base_url="http://localhost:3000",
        ),
    }
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    monkeypatch.setattr("npmguard.report_store.DATA_DIR", (tmp_path / "data" / "reports").resolve())
    get_settings.cache_clear()
    yield create_app(), db_path
    get_settings.cache_clear()


@pytest.fixture
def unconfigured_app(monkeypatch, tmp_path):
    """The same app with the panel OFF — the default posture."""
    monkeypatch.setenv("NPMGUARD_ENV", "test")
    monkeypatch.setenv("NPMGUARD_MOCK_LLM", "true")
    monkeypatch.setenv("NPMGUARD_PAYMENT_REQUIRED", "false")
    monkeypatch.setenv("NPMGUARD_DATABASE_URL", f"sqlite+aiosqlite:///{tmp_path / 'dark.sqlite3'}")
    monkeypatch.setenv("NPMGUARD_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "audit-logs"))
    monkeypatch.setattr("npmguard.report_store.DATA_DIR", (tmp_path / "data" / "reports").resolve())
    get_settings.cache_clear()
    yield create_app()
    get_settings.cache_clear()


def _seed(db_path, alerts: list[dict], *, join_user_to=(MINE,)) -> None:
    """Write identity + installations + alerts straight into the app's sqlite.

    Called INSIDE the TestClient context so the tables already exist (the
    lifespan runs metadata.create_all on startup).

    ``join_user_to`` is the set of orgs the user's ``user_installations`` cache
    covers — the authorization edge the routes join through. Orgs outside it
    still get their installation row, so "the org exists but is not mine" is a
    real reachable state rather than a missing row.
    """
    orgs = {alert["org"] for alert in alerts} | set(join_user_to)
    with contextlib.closing(sqlite3.connect(db_path)) as db:
        db.execute(
            "INSERT INTO gh_users (id, login, name, email, avatar_url, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (USER_ID, "octocat", "Mona", "mona@example.com", None, NOW, NOW),
        )
        db.execute(
            "INSERT INTO gh_sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)",
            (SESSION_TOKEN, USER_ID, NOW, FAR_FUTURE),
        )
        for index, org in enumerate(sorted(orgs), start=1):
            installation_id = 500 + index
            db.execute(
                "INSERT INTO installations"
                " (id, account_login, account_type, suspended, created_at, updated_at)"
                " VALUES (?,?,?,0,?,?)",
                (installation_id, org, "Organization", NOW, NOW),
            )
            if org in join_user_to:
                db.execute(
                    "INSERT INTO user_installations (user_id, installation_id, refreshed_at)"
                    " VALUES (?,?,?)",
                    (USER_ID, installation_id, NOW),
                )
        for alert in alerts:
            db.execute(
                "INSERT INTO alerts"
                " (id, org, repo_id, package_name, version, outcome, origin, message, seen,"
                "  created_at)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    alert["id"],
                    alert["org"],
                    alert.get("repo_id"),
                    alert.get("package_name", "left-pad"),
                    alert.get("version", "1.0.0"),
                    alert.get("outcome", "DANGEROUS"),
                    alert.get("origin", "repo_scan"),
                    alert.get("message", ""),
                    1 if alert.get("seen") else 0,
                    alert["created_at"],
                ),
            )
        db.commit()


def _seen_by_id(db_path) -> dict[int, int]:
    with contextlib.closing(sqlite3.connect(db_path)) as db:
        return dict(db.execute("SELECT id, seen FROM alerts").fetchall())


def _signed_in(client: TestClient) -> TestClient:
    client.cookies.set(SESSION_COOKIE, SESSION_TOKEN)
    return client


# ---------------------------------------------------------------------------
# GET /panel/alerts
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("base", BASES)
def test_feed_returns_only_the_users_orgs(panel_app, base) -> None:
    """C1+C2+C3: the user's orgs only, newest first — another org is invisible."""
    app, db_path = panel_app
    with TestClient(app) as client:
        _seed(
            db_path,
            [
                {"id": 1, "org": MINE, "created_at": "2026-07-01T00:00:00.000Z"},
                {"id": 2, "org": MINE, "created_at": "2026-07-03T00:00:00.000Z"},
                {"id": 3, "org": THEIRS, "created_at": "2026-07-09T00:00:00.000Z"},
            ],
        )
        response = _signed_in(client).get(f"{base}/panel/alerts")

    assert response.status_code == 200, response.text
    alerts = response.json()["alerts"]
    # C3: newest first. C2: the THEIRS alert is absent despite being the newest,
    # which is what makes this an isolation assertion and not just an ordering one.
    assert [alert["id"] for alert in alerts] == [2, 1]
    assert all(alert["org"] == MINE for alert in alerts)


def test_feed_tie_breaks_equal_timestamps_by_id(panel_app) -> None:
    """C3: same created_at → higher id first, so a same-instant burst is stable."""
    app, db_path = panel_app
    stamp = "2026-07-05T00:00:00.000Z"
    with TestClient(app) as client:
        _seed(
            db_path,
            [
                {"id": 7, "org": MINE, "created_at": stamp},
                {"id": 8, "org": MINE, "created_at": stamp},
                {"id": 9, "org": MINE, "created_at": stamp},
            ],
        )
        response = _signed_in(client).get("/panel/alerts")

    assert [alert["id"] for alert in response.json()["alerts"]] == [9, 8, 7]


def test_feed_caps_at_the_limit_and_keeps_the_newest(panel_app) -> None:
    """C4: over-limit feeds truncate to the NEWEST rows, not an arbitrary page."""
    app, db_path = panel_app
    overflow = ALERTS_FEED_LIMIT + 10
    with TestClient(app) as client:
        _seed(
            db_path,
            [
                # id ascending with created_at ascending, so the newest ids are
                # the ones the limit must keep.
                {
                    "id": index,
                    "org": MINE,
                    "created_at": f"2026-07-01T00:00:{index:02d}.000Z",
                }
                for index in range(1, overflow + 1)
            ],
        )
        response = _signed_in(client).get("/panel/alerts")

    alerts = response.json()["alerts"]
    assert len(alerts) == ALERTS_FEED_LIMIT
    assert alerts[0]["id"] == overflow
    assert alerts[-1]["id"] == overflow - ALERTS_FEED_LIMIT + 1


def test_feed_wire_shape(panel_app) -> None:
    """C5: the camelCase projection, bool-coerced seen, null repoId for watch."""
    app, db_path = panel_app
    with TestClient(app) as client:
        _seed(
            db_path,
            [
                {
                    "id": 11,
                    "org": MINE,
                    "repo_id": None,  # registry-watch alert: no owning repo
                    "package_name": "chalk",
                    "version": "5.3.1",
                    "outcome": "DANGEROUS",
                    "origin": "watchlist",
                    "message": "newly published 5.3.1 is DANGEROUS",
                    "seen": False,
                    "created_at": "2026-07-04T00:00:00.000Z",
                }
            ],
        )
        response = _signed_in(client).get("/panel/alerts")

    assert response.json()["alerts"] == [
        {
            "id": 11,
            "org": MINE,
            "repoId": None,
            "packageName": "chalk",
            "version": "5.3.1",
            "outcome": "DANGEROUS",
            "origin": "watchlist",
            "message": "newly published 5.3.1 is DANGEROUS",
            "seen": False,
            "createdAt": "2026-07-04T00:00:00.000Z",
        }
    ]


def test_feed_is_empty_not_an_error_without_installations(panel_app) -> None:
    """C6: no installations → an honest empty feed, never a 4xx/5xx."""
    app, db_path = panel_app
    with TestClient(app) as client:
        _seed(
            db_path,
            [{"id": 1, "org": THEIRS, "created_at": NOW}],
            join_user_to=(),
        )
        response = _signed_in(client).get("/panel/alerts")

    assert response.status_code == 200
    assert response.json() == {"alerts": []}


@pytest.mark.parametrize("base", BASES)
def test_feed_requires_a_session(panel_app, base) -> None:
    """C7: no cookie → 401 with the field the frontend branches on."""
    app, db_path = panel_app
    with TestClient(app) as client:
        _seed(db_path, [{"id": 1, "org": MINE, "created_at": NOW}])
        response = client.get(f"{base}/panel/alerts")

    assert response.status_code == 401
    assert response.json() == {"error": "Not signed in"}


def test_feed_503s_when_the_app_is_not_configured(unconfigured_app) -> None:
    """C8: the route exists on an unconfigured engine and reports the panel dark."""
    with TestClient(unconfigured_app) as client:
        response = client.get("/panel/alerts")

    assert response.status_code == 503
    assert response.json() == {"error": "GitHub App is not configured on this server"}


# ---------------------------------------------------------------------------
# POST /panel/alerts/seen
# ---------------------------------------------------------------------------


def test_seen_acks_the_users_unseen_alerts(panel_app) -> None:
    """C9+C11: acks mine, reports the count, and never touches another org's."""
    app, db_path = panel_app
    with TestClient(app) as client:
        _seed(
            db_path,
            [
                {"id": 1, "org": MINE, "seen": False, "created_at": NOW},
                {"id": 2, "org": MINE, "seen": True, "created_at": NOW},
                {"id": 3, "org": THEIRS, "seen": False, "created_at": NOW},
            ],
        )
        response = _signed_in(client).post("/panel/alerts/seen")

    assert response.status_code == 200
    # Only the one unseen alert in MINE was updated — the already-seen one is not
    # re-counted and THEIRS is out of scope.
    assert response.json() == {"ok": True, "updated": 1}
    # Asserted against the DB, not the response: an isolation claim that only
    # reads the body would pass even if the UPDATE had over-reached.
    assert _seen_by_id(db_path) == {1: 1, 2: 1, 3: 0}


def test_seen_is_idempotent(panel_app) -> None:
    """C10: a second ack matches nothing, still 200 — a double-click can't 500."""
    app, db_path = panel_app
    with TestClient(app) as client:
        _seed(db_path, [{"id": 1, "org": MINE, "seen": False, "created_at": NOW}])
        first = _signed_in(client).post("/panel/alerts/seen")
        second = client.post("/panel/alerts/seen")

    assert first.json() == {"ok": True, "updated": 1}
    assert second.status_code == 200
    assert second.json() == {"ok": True, "updated": 0}


@pytest.mark.parametrize("base", BASES)
def test_seen_requires_a_session(panel_app, base) -> None:
    """C12: no cookie → 401, and nothing is acknowledged."""
    app, db_path = panel_app
    with TestClient(app) as client:
        _seed(db_path, [{"id": 1, "org": MINE, "seen": False, "created_at": NOW}])
        response = client.post(f"{base}/panel/alerts/seen")

    assert response.status_code == 401
    assert _seen_by_id(db_path) == {1: 0}


def test_seen_503s_when_the_app_is_not_configured(unconfigured_app) -> None:
    """C13: unconfigured engine → 503, same body as every other panel route."""
    with TestClient(unconfigured_app) as client:
        response = client.post("/panel/alerts/seen")

    assert response.status_code == 503
    assert response.json() == {"error": "GitHub App is not configured on this server"}
