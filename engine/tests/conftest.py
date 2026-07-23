"""Shared test scope: repo-residue guard + the unit-tier sandbox default.

Both concerns are deliberate suite-wide policy; anything test-specific
belongs in the test files, not here.
"""

import os
import sys
import tempfile
from pathlib import Path

import pytest

# Residue guard (K1/K2). report_store resolves NPMGUARD_DATA_DIR into a module
# constant at import time, so the knob MUST be set before any test module
# imports npmguard — a fixture would be too late. With this in place every
# report/audit-log write from an in-process test (including background audits
# still finishing at lifespan shutdown) lands in a session-scoped temp dir,
# never in the repo's data/ or audit-logs/. Tests that assert on file locations
# re-point the same knobs per-test (audit_log reads its env per call;
# report_store needs its import-time DATA_DIR constant re-pointed too).
assert "npmguard.report_store" not in sys.modules, (
    "conftest residue guard ran after npmguard.report_store was imported — "
    "the NPMGUARD_DATA_DIR knob no longer takes effect"
)
_SESSION_STATE = Path(tempfile.mkdtemp(prefix="npmguard-tests-"))
os.environ["NPMGUARD_DATA_DIR"] = str(_SESSION_STATE / "data")
os.environ["NPMGUARD_AUDIT_LOG_DIR"] = str(_SESSION_STATE / "audit-logs")


@pytest.fixture(autouse=True)
def _stub_dry_run_load(monkeypatch):
    """Unit-tier default: the hypothesis dry-run gate is a no-op (payload loads).

    The real gate starts a sandbox container; unit tests exercise generation
    logic, not the sandbox, and must stay clone-and-run (no docker). Tests that
    assert the gate's behavior re-patch it with a stub returning a load failure
    (see test_hypothesis_generation / test_hypothesis_agent).

    Scope and limits, explicitly:
    - Patched at BOTH current import sites (phases, hypothesis_agent). setattr
      raises if either name disappears, so a refactor fails loud rather than
      silently un-stubbing. A NEW import site would not be covered — if one is
      added, extend this list, or the first docker-less run of the suite will
      fail on the missing sandbox (loud, not silent).
    - e2e tests run the engine out-of-process and are unaffected by this patch.
    """

    async def _loads(*_args, **_kwargs):
        return None

    monkeypatch.setattr("npmguard.phases.dry_run_load", _loads)
    monkeypatch.setattr("npmguard.hypothesis_agent.dry_run_load", _loads)
