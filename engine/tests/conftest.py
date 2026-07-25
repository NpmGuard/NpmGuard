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

# INVARIANT: a test process never reads a developer's .env file.
#
# Settings declares `env_file=(REPO_ROOT/.env, cwd/.env)` and pytest runs from
# engine/, so `engine/.env` was loaded into every in-process test. That silently
# handed them real GitHub App credentials, the panel BOOTED inside unit tests (a
# worker pool, a registry watcher, aiosqlite connections outliving teardown),
# and the leaked handles surfaced as PytestUnraisableExceptionWarning under
# `filterwarnings = ["error"]` — 14 failures + 1 collection error on a developer
# machine, all green on a clean checkout.
#
# Disabling the dotenv SOURCE is the fix, not blanking the individual knobs:
# a knob list silently rots the moment a new panel setting is added, and it
# cannot express "off" for every field anyway (encryption_key is regex-
# constrained, so "" is a hard ValidationError rather than absent).
#
# Tests that WANT the panel set the credentials explicitly (monkeypatch.setenv,
# or EngineHarness(env=...) out of process); real env vars outrank a dotenv in
# pydantic-settings, so opting in still works and is visible at the opt-in site.
#
# Class-level mutation, before any Settings() is constructed — get_settings()
# is lru_cached and takes no arguments, so there is no per-call seam.
#
# Imported here rather than at the top of the file so the residue guard above
# still means what it says: it must run before ANY npmguard import, and keeping
# this one below it makes that ordering impossible to break by accident.
from npmguard.config import Settings  # noqa: E402

Settings.model_config["env_file"] = None
assert not Settings().github_app_enabled, (
    "the panel is enabled inside the test process — NPMGUARD_GITHUB_* / "
    "NPMGUARD_ENCRYPTION_KEY are exported in your shell. Unset them: tests must "
    "not inherit real GitHub App credentials."
)


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
