import pytest


@pytest.fixture(autouse=True)
def _stub_dry_run_load(monkeypatch):
    """The hypothesis dry-run gate runs a real sandbox container. Unit tests exercise
    generation logic, not the sandbox, so default it to a no-op (payload loads). Tests
    that assert the gate's behavior re-patch it with a stub that returns a load failure."""

    async def _loads(*_args, **_kwargs):
        return None

    monkeypatch.setattr("npmguard.phases.dry_run_load", _loads)
    monkeypatch.setattr("npmguard.hypothesis_agent.dry_run_load", _loads)
