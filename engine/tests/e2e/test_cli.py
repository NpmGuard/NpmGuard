# CLASS MAP — real CLI against a real engine (node cli/dist subprocess; marker: cli)
# Axes: payment configuration (stripe absent → 501 fallback) × audit outcome
#       (SAFE / audit_error / DANGEROUS-docker) × exit code contract
#   S10 checkout 501 (Stripe unconfigured) → CLI falls back to the free audit path and
#       streams the verdict [C13]
#   S19a SAFE verdict → exit 0, verdict rendered from live SSE [C12, C13]
#   S19b audit_error (unresolvable package) → exit 1, error rendered [C3-adjacent]
#   S19c DANGEROUS verdict (live docker experiment, scripted judge/hypothesis) →
#        exit 1 [C12, C15; markers cli+docker]
# Adversarial pass: W4b — "does the CLI ever exit 0 on a non-SAFE outcome via these
#   paths?" answered by S19b/S19c pairing against S19a. (The known es.onerror
#   CLOSED→exit-0 hazard needs a dead events URL — the audit flow here always has a
#   live session, so that class stays with the scenario map's exclusions.)
#
# Blackbox: CLI exit codes + stdout; engine observed only through its public HTTP API.

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from tests.e2e.llm_mock import FLAGGING_FLAG_BODY, SAFE_INTENT_BODY, scripted_safe_roles
from tests.support.harness import REPO_ROOT

pytestmark = [pytest.mark.e2e, pytest.mark.cli]

DNS_EXFIL_PKG = "test-pkg-dns-exfil"
ENV_EXFIL_PKG = "test-pkg-env-exfil"

CLI_TIMEOUT_SECONDS = 120.0
# The DANGEROUS path runs a real sandbox experiment (dry-run gate + full oracle).
CLI_DOCKER_TIMEOUT_SECONDS = 300.0

node_required = pytest.mark.skipif(
    shutil.which("node") is None, reason="cli gate: node not on PATH"
)


def run_cli(engine, *args: str, timeout: float = CLI_TIMEOUT_SECONDS):
    node = shutil.which("node")
    assert node is not None
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


@node_required
def test_checkout_501_falls_back_to_free_audit_safe_exit_0(engine_factory, mock_llm):
    """S10+S19a [C12,C13]: Stripe unconfigured → 501 → CLI runs the free audit, streams
    live events, renders SAFE, exits 0."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url)

    result = run_cli(engine, "audit", DNS_EXFIL_PKG)
    assert result.returncode == 0, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert "SAFE" in result.stdout
    # free fallback, not the payment flow
    assert "Pay to start" not in result.stdout
    assert "already been audited" not in result.stdout


@node_required
def test_audit_error_exits_1(engine_factory, mock_llm):
    """S19b [C3-adjacent]: an unresolvable package (dead registry) ends in audit_error
    and the CLI exits 1 — failure is an error, never a SAFE exit."""
    mock_llm.load(scripted_roles=scripted_safe_roles())
    engine = engine_factory(llm_url=mock_llm.v1_url)  # registry defaults to DEAD_URL

    result = run_cli(engine, "audit", "left-pad")
    assert result.returncode == 1, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    # ora renders the failed spinner (with the audit_error message) on stderr
    assert "Audit error" in result.stdout + result.stderr


@node_required
@pytest.mark.docker
def test_dangerous_verdict_exits_1(engine_factory, mock_llm):
    """S19c [C12,C15]: a live-docker experiment confirms the scripted env-exfil
    hypothesis (judge cites real timeline events) → DANGEROUS → CLI exits 1."""
    mock_llm.load(
        scripted_roles={
            "intent": {"kind": "static", "body": SAFE_INTENT_BODY},
            "flag": {"kind": "static", "body": FLAGGING_FLAG_BODY},
            "hypothesis": {"kind": "hypothesis", "claim_kind": "env_exfil"},
            "judge": {"kind": "judge", "malicious": True},
        }
    )
    engine = engine_factory(llm_url=mock_llm.v1_url)

    result = run_cli(engine, "audit", ENV_EXFIL_PKG, timeout=CLI_DOCKER_TIMEOUT_SECONDS)
    assert result.returncode == 1, f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert "DANGEROUS" in result.stdout
