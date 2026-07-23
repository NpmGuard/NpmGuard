"""E2e wiring: stub servers (session-scoped, state reset per test) + engine harness.

Gates (loud skip reasons, never silent): ``docker`` marker needs a daemon + the
sandbox image (NPMGUARD_TEST_DOCKER=0 forces off); ``postgres`` needs
NPMGUARD_TEST_PG_DSN or docker; ``cli`` needs cli/dist. The unit-level autouse
``_stub_dry_run_load`` in tests/conftest.py patches only THIS pytest process —
the e2e engine runs out-of-process, so it is unaffected.
"""

from __future__ import annotations

import pytest

from tests.e2e.llm_mock import MockLlmClient, create_mock_app
from tests.support.harness import (
    ENGINE_ROOT,
    EngineHarness,
    PostgresProvisioner,
    cli_dist_available,
    postgres_available,
    sandbox_image_available,
    sqlite_url,
)
from tests.support.stubs import FakeChainRpc, RegistryStub, StripeStub, StubServer

REGISTRY_FIXTURES_DIR = ENGINE_ROOT / "tests" / "fixtures" / "registry"


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    docker_ok, docker_reason = sandbox_image_available()
    pg_ok, pg_reason = postgres_available()
    cli_ok, cli_reason = cli_dist_available()
    for item in items:
        if item.get_closest_marker("docker") and not docker_ok:
            item.add_marker(pytest.mark.skip(reason=f"docker gate: {docker_reason}"))
        if item.get_closest_marker("postgres") and not pg_ok:
            item.add_marker(pytest.mark.skip(reason=pg_reason))
        if item.get_closest_marker("cli") and not cli_ok:
            item.add_marker(pytest.mark.skip(reason=cli_reason))


# ---- mock LLM ----------------------------------------------------------


@pytest.fixture(scope="session")
def mock_llm_server(tmp_path_factory: pytest.TempPathFactory) -> StubServer:
    spool = tmp_path_factory.mktemp("llm-mock-spool")
    with StubServer(create_mock_app(spool)) as server:
        yield server


@pytest.fixture
def mock_llm(mock_llm_server: StubServer) -> MockLlmClient:
    """Per-test mock handle: state fully cleared before, fail-loud checks after.

    Teardown asserts zero unmatched requests and all required exchanges
    consumed; set ``mock_llm.teardown_checks = False`` in a scenario that
    deliberately leaves either (and assert your own expectations instead).
    """
    client = MockLlmClient(mock_llm_server.base_url)
    client.load()  # empty load == clear all bundles/scripted state + counters
    yield client
    if client.teardown_checks:
        client.assert_clean()


# ---- stub servers (session process, per-test state) --------------------


@pytest.fixture(scope="session")
def _registry_session() -> RegistryStub:
    with RegistryStub() as stub:
        yield stub


@pytest.fixture
def registry_stub(_registry_session: RegistryStub) -> RegistryStub:
    """Registry stub preloaded with committed fixtures (tests/fixtures/registry)."""
    _registry_session.clear()
    if REGISTRY_FIXTURES_DIR.is_dir():
        _registry_session.load_dir(REGISTRY_FIXTURES_DIR)
    return _registry_session


@pytest.fixture(scope="session")
def _fake_chain_session() -> FakeChainRpc:
    with FakeChainRpc() as stub:
        yield stub


@pytest.fixture
def fake_chain(_fake_chain_session: FakeChainRpc) -> FakeChainRpc:
    _fake_chain_session.clear()
    return _fake_chain_session


@pytest.fixture(scope="session")
def _stripe_session() -> StripeStub:
    with StripeStub() as stub:
        yield stub


@pytest.fixture
def stripe_stub(_stripe_session: StripeStub) -> StripeStub:
    _stripe_session.clear()
    return _stripe_session


# ---- engine ------------------------------------------------------------


@pytest.fixture
def engine_factory(tmp_path):
    """Callable building started EngineHarness instances; all closed at teardown.

    ``engine_factory(**EngineHarness kwargs, start=True, wait_ready=True)``.
    Pass ``start=False`` (or ``wait_ready=False``) for boot-failure scenarios.
    """
    created: list[EngineHarness] = []

    def factory(*, start: bool = True, wait_ready: bool = True, **kwargs) -> EngineHarness:
        kwargs.setdefault("workdir", tmp_path / f"engine-{len(created)}")
        harness = EngineHarness(**kwargs)
        created.append(harness)
        if start:
            harness.start(wait_ready=wait_ready)
        return harness

    yield factory
    for harness in created:
        harness.close()


@pytest.fixture
def engine(engine_factory, mock_llm: MockLlmClient) -> EngineHarness:
    """Default engine: sqlite, payment off, LLM → mock, registry/chain hermetic-dead."""
    return engine_factory(llm_url=mock_llm.v1_url)


# ---- database axis -----------------------------------------------------


@pytest.fixture(scope="session")
def pg_provisioner():
    ok, reason = postgres_available()
    if not ok:
        pytest.skip(reason)
    provisioner = PostgresProvisioner.start()
    yield provisioner
    provisioner.stop()


@pytest.fixture(
    params=[pytest.param("sqlite"), pytest.param("postgres", marks=pytest.mark.postgres)]
)
def db_backend(request: pytest.FixtureRequest) -> str:
    """Parametrized DB axis. The postgres param carries the postgres MARKER so
    its variants run in the gate's `e2e and postgres` tier (and are excluded
    from the `not postgres` sqlite tier) — same shape as test_stream S14."""
    if request.param == "postgres":
        ok, reason = postgres_available()
        if not ok:
            pytest.skip(reason)
    return request.param


@pytest.fixture
def db_url(db_backend: str, tmp_path, request: pytest.FixtureRequest) -> str:
    """Fresh NPMGUARD_DATABASE_URL for the selected backend."""
    if db_backend == "sqlite":
        return sqlite_url(tmp_path / "axis-db.sqlite3")
    provisioner: PostgresProvisioner = request.getfixturevalue("pg_provisioner")
    return provisioner.fresh_database()
