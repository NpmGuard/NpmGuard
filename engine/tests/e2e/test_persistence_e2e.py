# CLASS MAP — report persistence + retrieval (e2e: real engine, real files on disk)
# Axes: requested version (concrete / omitted / "latest" / unknown) × report shape
#       (flat /audit/:id/report vs wrapped /package/:name/report) × reader (HTTP / CLI)
#   S22a audit with a concrete version → data/reports/<pkg>/<real-version>.json; NO
#        latest.json (F1) and no .tmp residue anywhere [C1]
#   S22b audit with version OMITTED → real version extracted from the tarball inventory,
#        still a concrete filename, still no latest.json [C1]
#   S22c re-fetch + version resolution: exact ?version hit, unknown version → 404,
#        ?version=latest → 400 (route-level semver gate; pinned current behavior)
#   S22d both wire shapes: /audit/:id/report is FLAT, /package/:name/report is WRAPPED
#        {report, version, packageName} [C1, CLI tolerates both]
#   S23  CLI short-circuit: an existing report makes `npmguard audit` exit 0 without
#        starting a new audit session [C12-adjacent; real CLI subprocess]
# Adversarial pass: W4b — "can a versionless request still mint a latest.json alias?"
#   answered by S22b's rglob probe over the whole data dir.
#
# Blackbox: engine HTTP + report files + sessions row count + a real `node cli/dist`.

from __future__ import annotations

import json
import os
import shutil
import subprocess

import httpx
import pytest
import sqlalchemy as sa

from tests.e2e.llm_mock import scripted_safe_roles
from tests.support.harness import REPO_ROOT
from tests.support.sse import collect_frames, terminal_frame
from tests.support.waits import wait_report_file

pytestmark = pytest.mark.e2e

ENV_EXFIL_PKG = "test-pkg-env-exfil"
ENV_EXFIL_VERSION = "2.0.1"

AUDIT_DEADLINE_SECONDS = 90.0
HTTP_TIMEOUT_SECONDS = 30.0
CLI_TIMEOUT_SECONDS = 120.0


async def _get(url: str, **kwargs) -> httpx.Response:
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        return await client.get(url, **kwargs)


def _row_count(db_url: str, table: str) -> int:
    sync_url = db_url.replace("+aiosqlite", "").replace("+asyncpg", "")
    engine = sa.create_engine(sync_url)
    try:
        with engine.connect() as connection:
            return connection.execute(
                sa.text(f"SELECT COUNT(*) FROM {table}")  # noqa: S608 — fixed table names
            ).scalar_one()
    finally:
        engine.dispose()


async def _run_safe_audit(engine, package: str, version: str | None) -> str:
    """Run one SAFE audit to its terminal frame AND its persisted report file.

    The terminal SSE frame precedes finalize+save_report (tests/support/waits.py),
    so this waits (bounded) for the report file too — every caller probes
    post-terminal persistence right after this returns.
    """
    started = engine.start_audit(package, version)
    frames = await collect_frames(
        engine.base_url, started["auditId"], deadline=AUDIT_DEADLINE_SECONDS
    )
    terminal = terminal_frame(frames)
    assert terminal is not None and terminal.type == "verdict_reached"
    assert terminal.data["verdict"] == "SAFE"
    wait_report_file(
        engine.data_dir / "reports" / ENV_EXFIL_PKG / f"{ENV_EXFIL_VERSION}.json"
    )
    return started["auditId"]


def run_cli(engine, *args: str, timeout: float = CLI_TIMEOUT_SECONDS):
    """Run the real built CLI against the harness engine (NPMGUARD_API_URL)."""
    node = shutil.which("node")
    assert node is not None, "cli tests need node on PATH"
    env = {
        **os.environ,
        "NPMGUARD_API_URL": engine.base_url,
        "FORCE_COLOR": "0",
        "NO_COLOR": "1",
    }
    return subprocess.run(
        [node, str(REPO_ROOT / "cli" / "dist" / "index.js"), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )


async def test_report_persisted_under_real_version_never_latest(engine_factory, mock_llm):
    """S22a/S22b [C1]: concrete AND omitted requested versions persist as
    <real-version>.json; no latest.json alias, no .tmp residue."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url)

    await _run_safe_audit(engine, ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    await _run_safe_audit(engine, ENV_EXFIL_PKG, None)  # S22b: version omitted

    report_dir = engine.data_dir / "reports" / ENV_EXFIL_PKG
    assert sorted(file.name for file in report_dir.glob("*.json")) == [
        f"{ENV_EXFIL_VERSION}.json"
    ]
    assert list(engine.data_dir.rglob("latest.json")) == []
    assert list(engine.data_dir.rglob("*.tmp")) == []
    assert json.loads((report_dir / f"{ENV_EXFIL_VERSION}.json").read_text())["verdict"] == "SAFE"


async def test_report_refetch_and_version_resolution(engine_factory, mock_llm):
    """S22c/S22d [C1]: exact-version re-fetch works; unknown version → 404;
    ?version=latest → 400 (semver route gate — legal store input, rejected at the API);
    /audit/:id/report is FLAT while /package/:name/report is WRAPPED."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url)
    audit_id = await _run_safe_audit(engine, ENV_EXFIL_PKG, ENV_EXFIL_VERSION)

    flat = await _get(f"{engine.base_url}/audit/{audit_id}/report")
    assert flat.status_code == 200
    assert flat.json()["verdict"] == "SAFE"
    assert "report" not in flat.json()  # flat shape: the report IS the body

    for params in (None, {"version": ENV_EXFIL_VERSION}):
        wrapped = await _get(
            f"{engine.base_url}/package/{ENV_EXFIL_PKG}/report", params=params
        )
        assert wrapped.status_code == 200, wrapped.text
        body = wrapped.json()
        assert body["packageName"] == ENV_EXFIL_PKG
        assert body["version"] == ENV_EXFIL_VERSION
        assert body["report"]["verdict"] == "SAFE"
        assert body["report"] == flat.json()

    unknown = await _get(
        f"{engine.base_url}/package/{ENV_EXFIL_PKG}/report", params={"version": "9.9.9"}
    )
    assert unknown.status_code == 404

    # pinned: "latest" is legal input for the STORE, but the route's semver gate
    # rejects it before the store is consulted
    latest = await _get(
        f"{engine.base_url}/package/{ENV_EXFIL_PKG}/report", params={"version": "latest"}
    )
    assert latest.status_code == 400

    # /api mirror spot-check on the representative read (C7 cross-cut)
    mirrored = await _get(f"{engine.base_url}/api/package/{ENV_EXFIL_PKG}/report")
    assert mirrored.status_code == 200
    assert mirrored.json()["report"]["verdict"] == "SAFE"


@pytest.mark.cli
@pytest.mark.skipif(shutil.which("node") is None, reason="cli gate: node not on PATH")
async def test_cli_short_circuits_on_existing_report(engine_factory, mock_llm):
    """S23 [C12]: with a persisted report, `npmguard audit` reports the existing verdict,
    exits 0 for SAFE, and starts NO new audit session."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url)
    await _run_safe_audit(engine, ENV_EXFIL_PKG, ENV_EXFIL_VERSION)
    sessions_before = _row_count(engine.db_url, "audit_sessions")

    result = run_cli(engine, "audit", f"{ENV_EXFIL_PKG}@{ENV_EXFIL_VERSION}")
    assert result.returncode == 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert "already been audited" in result.stdout
    assert "SAFE" in result.stdout
    assert _row_count(engine.db_url, "audit_sessions") == sessions_before
