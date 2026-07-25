# CLASS MAP — the /attest HTTP surface + AttestStore, over create_app
# (in-process TestClient; npm + GitHub + World are stubbed at their seams).
# Gating:   R1 world unconfigured → every route 503, engine otherwise unchanged
#           R2 configured but not signed in → 401 on the ownership step
# Session:  R3 open a session → resolves the REAL version + integrity from npm,
#              never from what the caller claims
#           R4 unknown package → 404; unknown session → 404
# Ownership:R5 no push access → 403 and the session does not advance
#           R6 push access → session 'owned' and the signal is FROZEN server-side
# Request:  R7 /request refuses before ownership (nothing to bind a proof to)
#           R8 /request advertises the environment so the UI can flag staging
# Proof:    R9 a proof for another artifact is refused (the replay defence)
#           R10 happy path → recorded, tier surfaced, session 'verified'
#           R11 a second attestation of the same release → 409, never overwrite
# Store:    R12 attestations for a package come back oldest-first (continuity read)
#
# Blackbox: drives HTTP only, except R12 which drives the store directly.

import pytest
from fastapi.testclient import TestClient

from npmguard.attest_store import AttestationConflict, AttestStore
from npmguard.config import get_settings

PKG = "left-pad"
VERSION = "1.3.0"
INTEGRITY = "sha512-testintegrity"
NULLIFIER = "0xnull1f1er"

WORLD_ENV = {
    "NPMGUARD_WORLD_APP_ID": "app_test",
    "NPMGUARD_WORLD_RP_ID": "rp_test",
    "NPMGUARD_WORLD_SIGNING_KEY": "0f" * 32,
    "NPMGUARD_WORLD_ENVIRONMENT": "staging",
}

# github_app_enabled requires ALL five credentials — ownership is a hard
# dependency of attestation, so a half-configured panel must not half-enable it.
GITHUB_ENV = {
    "NPMGUARD_GITHUB_APP_ID": "12345",
    "NPMGUARD_GITHUB_APP_PRIVATE_KEY_PATH": "/dev/null",
    "NPMGUARD_GITHUB_CLIENT_ID": "Iv1.test",
    "NPMGUARD_GITHUB_CLIENT_SECRET": "shh",
    "NPMGUARD_ENCRYPTION_KEY": "ab" * 32,
}


@pytest.fixture
def make_app(monkeypatch, tmp_path):
    from npmguard.api import create_app

    def build(**env: str):
        settings = {
            "NPMGUARD_ENV": "test",
            "NPMGUARD_MOCK_LLM": "true",
            "NPMGUARD_PAYMENT_REQUIRED": "false",
            "NPMGUARD_DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'attest.sqlite3'}",
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


@pytest.fixture
def npm(monkeypatch):
    """Stub npm resolution — the engine resolves the artifact itself, so this is
    the seam that decides what gets bound."""

    async def resolve_release(package_name, version="latest"):
        if package_name == "no-such-pkg":
            from npmguard.resolve import PackageNotFoundError

            raise PackageNotFoundError(package_name)
        return VERSION, f"https://registry.npmjs.org/{package_name}.tgz", INTEGRITY

    monkeypatch.setattr("npmguard.attest_routes.resolve_release", resolve_release)


def _sign_in(
    monkeypatch, app, *, can_push: bool = True, user_id: int = 4242, login: str = "maintainer"
):
    """Put an authenticated GitHub user + ownership answer behind the routes.

    Patched via monkeypatch so nothing leaks into the next test — these are
    module-level names the handlers resolve at call time.
    """
    runtime = app.state.runtime

    async def current_user(request, rt):
        return {"id": user_id, "login": login}

    async def verify_ownership(package_name, octokit, **kwargs):
        from npmguard.attest_ownership import OwnershipError, RepoRef

        if not can_push:
            raise OwnershipError(f"you do not have push access to acme/{package_name}")
        return RepoRef(owner="acme", repo=package_name)

    monkeypatch.setattr("npmguard.attest_routes.current_user", current_user)
    monkeypatch.setattr("npmguard.attest_routes.verify_ownership", verify_ownership)

    class _Client:
        def user_octokit(self, token):
            return object()

        async def get_user_access_token(self, uid, sessions):
            return "gho_test"

    object.__setattr__(runtime, "gh_client", _Client())
    return runtime


def _stub_world(app, *, verified=None, error=None):
    runtime = app.state.runtime

    class _World:
        enabled = True

        async def verify(self, proof, *, expected_signal, require_user_presence=True):
            from npmguard.attestations import AttestationError, VerifiedAttestation

            if error is not None:
                raise AttestationError(error)
            return verified or VerifiedAttestation(
                nullifier=NULLIFIER,
                tier=1,
                identity_attested=False,
                user_presence=True,
                environment="staging",
                action="attest-npm-release",
            )

    object.__setattr__(runtime, "world", _World())
    return runtime


# --- R1/R2: gating ----------------------------------------------------------


def test_without_world_configured_every_route_is_503(make_app, npm) -> None:
    """The feature is invisible unless deliberately turned on — same discipline
    as the GitHub panel."""
    with TestClient(make_app()) as client:
        opened = client.post("/attest/session", json={"packageName": PKG, "version": VERSION})
        assert opened.status_code == 503
        assert client.get("/attest/session/whatever").status_code == 503
        # and the rest of the engine is untouched
        assert client.get("/health").status_code == 200


def test_ownership_requires_a_signed_in_github_user(make_app, npm) -> None:
    """World ID proves a human is present, not which packages they may speak
    for. Without GitHub there is no ownership claim at all."""
    with TestClient(make_app(**WORLD_ENV)) as client:
        opened = client.post("/attest/session", json={"packageName": PKG, "version": VERSION})
        assert opened.status_code == 201
        session_id = opened.json()["sessionId"]
        # github_app_enabled is false in this env → 503 rather than a silent pass
        assert client.post(f"/attest/session/{session_id}/own").status_code == 503


# --- R3/R4: sessions --------------------------------------------------------


def test_opening_a_session_resolves_the_artifact_from_npm(make_app, npm) -> None:
    """The integrity binding must come from the registry, never from what the
    caller claims it is publishing."""
    with TestClient(make_app(**WORLD_ENV)) as client:
        opened = client.post(
            "/attest/session", json={"packageName": PKG, "version": "9.9.9-lie"}
        )
        assert opened.status_code == 201
        body = opened.json()
        assert body["version"] == VERSION, "the engine must use npm's resolved version"
        assert body["integrity"] == INTEGRITY
        assert body["status"] == "created"
        assert body["url"].endswith(f"/attest/{body['sessionId']}")


def test_unknown_package_and_session_are_404(make_app, npm) -> None:
    with TestClient(make_app(**WORLD_ENV)) as client:
        missing = client.post(
            "/attest/session", json={"packageName": "no-such-pkg", "version": VERSION}
        )
        assert missing.status_code == 404
        assert client.get("/attest/session/does-not-exist").status_code == 404


def test_a_malformed_body_is_refused(make_app, npm) -> None:
    with TestClient(make_app(**WORLD_ENV)) as client:
        assert client.post("/attest/session", json={"packageName": PKG}).status_code == 400
        assert (
            client.post(
                "/attest/session", json={"packageName": "NOT VALID", "version": VERSION}
            ).status_code
            == 400
        )


# --- R5-R8: ownership + request ---------------------------------------------


def _open(client) -> str:
    return client.post("/attest/session", json={"packageName": PKG, "version": VERSION}).json()[
        "sessionId"
    ]


def test_without_push_access_the_session_does_not_advance(make_app, npm, monkeypatch) -> None:
    """Read access is not enough — anyone can read a public repo, so accepting
    it would let any GitHub user attest any public package."""
    app = make_app(**WORLD_ENV, **GITHUB_ENV)
    with TestClient(app) as client:
        session_id = _open(client)
        _sign_in(monkeypatch, app, can_push=False)
        refused = client.post(f"/attest/session/{session_id}/own")
        assert refused.status_code == 403
        assert "push access" in refused.json()["error"]
        assert client.get(f"/attest/session/{session_id}").json()["status"] == "created"
        # and no proof can be submitted while unowned
        assert client.post(f"/attest/session/{session_id}/proof", json={}).status_code == 409


def test_the_request_config_refuses_before_ownership(make_app, npm) -> None:
    """A proof needs a signal to bind to, and the signal only exists once we
    know which GitHub identity is attesting."""
    app = make_app(**WORLD_ENV, **GITHUB_ENV)
    with TestClient(app) as client:
        session_id = _open(client)
        assert client.get(f"/attest/session/{session_id}/request").status_code == 409


def test_the_request_config_flags_a_non_production_environment(make_app, npm, monkeypatch) -> None:
    """A staging proof carries no real-world assurance; the UI has to be able to
    say so, so the engine must tell it."""
    app = make_app(**WORLD_ENV, **GITHUB_ENV)
    with TestClient(app) as client:
        session_id = _open(client)
        _sign_in(monkeypatch, app)
        assert client.post(f"/attest/session/{session_id}/own").status_code == 200
        config = client.get(f"/attest/session/{session_id}/request").json()
        assert config["environment"] == "staging"
        assert config["isProduction"] is False
        assert config["action"] == "attest-npm-release"
        assert config["signal"].startswith("npmguard:v1:")
        assert INTEGRITY in config["signal"]


# --- R9-R11: proof ----------------------------------------------------------


def test_a_refused_proof_records_the_failure_and_does_not_attest(make_app, npm, monkeypatch) -> None:
    app = make_app(**WORLD_ENV, **GITHUB_ENV)
    with TestClient(app) as client:
        session_id = _open(client)
        _sign_in(monkeypatch, app)
        client.post(f"/attest/session/{session_id}/own")
        _stub_world(app, error="signal_hash does not match this release")

        refused = client.post(f"/attest/session/{session_id}/proof", json={"proof": "x"})
        assert refused.status_code == 422
        assert "does not match" in refused.json()["error"]
        after = client.get(f"/attest/session/{session_id}").json()
        assert after["status"] == "failed"
        assert "attestation" not in after


def test_a_failed_session_can_still_be_retried(make_app, npm, monkeypatch) -> None:
    """A rejected proof must not brick the session.

    Ownership is already proven and the signal already frozen; the maintainer
    simply produced the wrong proof. `/request` re-issues an RP signature for a
    failed session, so `/proof` has to accept one too — otherwise the retry path
    dead-ends at 409 and the only way out is opening a new session.
    """
    app = make_app(**WORLD_ENV, **GITHUB_ENV)
    with TestClient(app) as client:
        session_id = _open(client)
        _sign_in(monkeypatch, app)
        client.post(f"/attest/session/{session_id}/own")

        _stub_world(app, error="proof carries no signal_hash — it is not artifact-bound")
        assert client.post(f"/attest/session/{session_id}/proof", json={}).status_code == 422
        assert client.get(f"/attest/session/{session_id}").json()["status"] == "failed"

        # the retry: same session, a proof World now accepts
        assert client.get(f"/attest/session/{session_id}/request").status_code == 200
        _stub_world(app)
        retried = client.post(f"/attest/session/{session_id}/proof", json={})
        assert retried.status_code == 200
        assert retried.json()["status"] == "verified"


def test_a_verified_proof_is_recorded_and_surfaced(make_app, npm, monkeypatch) -> None:
    app = make_app(**WORLD_ENV, **GITHUB_ENV)
    with TestClient(app) as client:
        session_id = _open(client)
        _sign_in(monkeypatch, app)
        client.post(f"/attest/session/{session_id}/own")
        _stub_world(app)

        done = client.post(f"/attest/session/{session_id}/proof", json={"proof": "x"})
        assert done.status_code == 200
        body = done.json()
        assert body["status"] == "verified"
        assert body["attestation"]["tier"] == 1
        assert body["attestation"]["nullifier"] == NULLIFIER
        assert body["attestation"]["environment"] == "staging"
        # the public envelope carries booleans, never identity values
        envelope = body["envelope"]
        assert envelope["package"] == PKG and envelope["version"] == VERSION
        assert envelope["assertions"]["human_verified"] is True
        assert all(isinstance(v, bool) for v in envelope["assertions"].values())
        assert "full_name" not in repr(envelope)


def test_a_release_cannot_be_attested_twice(make_app, npm, monkeypatch) -> None:
    """Mirrors the on-chain registry's append-only rule: a second attestation is
    a conflict, never an overwrite. Rewritable history would let an attacker
    manufacture a clean publisher streak after the fact."""
    app = make_app(**WORLD_ENV, **GITHUB_ENV)
    with TestClient(app) as client:
        first = _open(client)
        _sign_in(monkeypatch, app)
        client.post(f"/attest/session/{first}/own")
        _stub_world(app)
        assert client.post(f"/attest/session/{first}/proof", json={}).status_code == 200

        second = _open(client)
        client.post(f"/attest/session/{second}/own")
        conflict = client.post(f"/attest/session/{second}/proof", json={})
        assert conflict.status_code == 409
        assert "already attested" in conflict.json()["error"]


# --- R12: the store's continuity read ---------------------------------------


async def test_attestations_for_a_package_come_back_oldest_first(tmp_path) -> None:
    from kit_spine import make_engine, make_session_factory
    from kit_spine.db import metadata

    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / 'store.sqlite3'}")
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    store = AttestStore(make_session_factory(engine))

    for index, version in enumerate(["1.0.0", "1.0.1", "1.0.2"]):
        await store.record(
            package_name=PKG,
            version=version,
            integrity=INTEGRITY,
            nullifier=NULLIFIER,
            tier=1,
            assertions={"human_verified": True},
            environment="staging",
            github_login="maintainer",
            attested_at=f"2026-07-25T00:0{index}:00Z",
        )

    rows = await store.for_package(PKG)
    assert [row.version for row in rows] == ["1.0.0", "1.0.1", "1.0.2"]
    assert await store.for_package("never-attested") == []
    assert (await store.for_release(PKG, "1.0.1")).nullifier == NULLIFIER
    assert await store.for_release(PKG, "9.9.9") is None

    with pytest.raises(AttestationConflict):
        await store.record(
            package_name=PKG,
            version="1.0.0",
            integrity=INTEGRITY,
            nullifier=NULLIFIER,
            tier=1,
            assertions={},
            environment="staging",
            github_login="maintainer",
            attested_at="2026-07-25T01:00:00Z",
        )
    await engine.dispose()


# --- R13: the dev ownership bypass -----------------------------------------


def test_the_dev_bypass_cannot_be_enabled_against_production_world() -> None:
    """A development affordance must be impossible to leave on against real
    credentials. Refused at construction, so a misconfigured engine does not
    boot rather than serving attestations nobody was entitled to make."""
    import pydantic

    from npmguard.config import Settings

    with pytest.raises(pydantic.ValidationError, match="cannot be enabled"):
        Settings(
            _env_file=None,
            attest_dev_trust_ownership=True,
            world_environment="production",
        )
    # staging is fine
    assert Settings(
        _env_file=None, attest_dev_trust_ownership=True, world_environment="staging"
    ).attest_dev_trust_ownership


def test_the_dev_bypass_records_that_ownership_was_not_proven(make_app, npm, monkeypatch) -> None:
    """The bypass lets the World half be exercised without a GitHub App, but the
    resulting record must never masquerade as a proven one."""
    app = make_app(**WORLD_ENV, NPMGUARD_ATTEST_DEV_TRUST_OWNERSHIP="true")
    with TestClient(app) as client:
        session_id = _open(client)
        owned = client.post(f"/attest/session/{session_id}/own")
        assert owned.status_code == 200
        assert owned.json()["ownershipProven"] is False

        _stub_world(app)
        done = client.post(f"/attest/session/{session_id}/proof", json={})
        assert done.status_code == 200
        assert done.json()["envelope"]["assertions"]["ownership_proven"] is False


def test_without_the_bypass_ownership_is_still_required(make_app, npm) -> None:
    """The default path is unchanged: no bypass, no GitHub App → refusal."""
    with TestClient(make_app(**WORLD_ENV)) as client:
        session_id = _open(client)
        assert client.post(f"/attest/session/{session_id}/own").status_code == 503
