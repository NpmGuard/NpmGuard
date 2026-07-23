# CLASS MAP — e2e failure paths: every infrastructure failure is an ERROR event,
#   never a SAFE verdict, never a persisted report (C3/C14 at the HTTP seam)
# Axes: failing dependency (LLM provider / sandbox / registry) × failure mode
#   (down / malformed output / timeout / missing image / 404)
#   S16a provider down    — every LLM request 500s; the model fallback chain is
#                           attempted (distinct models recorded by the mock) and
#                           the audit ends in audit_error with no report file
#   S16b malformed output — truncated completions on every model → audit_error
#   S16c provider timeout — scripted delay > NPMGUARD_LLM_TIMEOUT_SECONDS → audit_error
#   S17  sandbox broken   — nonexistent sandbox image: hypotheses DEFER (never
#                           REFUTE) → AuditIncompleteError NPMGUARD-0031 retryable
#   S18  package missing  — registry 404 (plain name) and absent local test-pkg
#                           fixture both surface NPMGUARD-0001 on the stream
# Adversarial pass: W4a — "can a failure leak a stale SAFE?" Negative report-file
#   assertions here are paired with the positive probes in test_verdicts (S1/S2
#   assert the file IS written on success via the same path helper).

from __future__ import annotations

from pathlib import Path

import pytest

from tests.e2e.llm_mock import SAFE_FLAG_BODY, SAFE_INTENT_BODY, MockLlmClient
from tests.support.sse import collect_frames, event_types, terminal_frame

pytestmark = pytest.mark.e2e

FAILURE_DEADLINE_SECONDS = 180.0
# The scripted delay must exceed the engine's per-call timeout below.
LLM_TIMEOUT_SECONDS = 2
LLM_DELAY_MS = 3000
BROKEN_SANDBOX_IMAGE = "npmguard-missing-image:v0"


def _reports_dir(engine, package_name: str) -> Path:
    return engine.data_dir / "reports" / package_name


async def _expect_audit_error(engine, package_name: str) -> tuple[dict, list]:
    """Start an audit and collect until the terminal frame; assert the failure
    contract: audit_error terminal, no verdict, no persisted report."""
    started = engine.start_audit(package_name)
    frames = await collect_frames(
        engine.base_url, started["auditId"], deadline=FAILURE_DEADLINE_SECONDS
    )
    terminal = terminal_frame(frames)
    assert terminal is not None and terminal.type == "audit_error", event_types(frames)
    assert "verdict_reached" not in event_types(frames)
    # save_report only runs on the success path, strictly before the terminal
    # audit_error we already received — no wait needed for this negative.
    assert not _reports_dir(engine, package_name).exists()
    return terminal.data, frames


async def test_s16a_provider_down_error_never_safe(engine_factory, mock_llm: MockLlmClient):
    """S16 [C3,C14]: LLM provider answers 500 to everything → the audit ends in
    audit_error (never SAFE), writes no report, and the mock's unmatched log
    records fallback-chain attempts across distinct models."""
    mock_llm.load()  # nothing scripted, nothing recorded: every request 500s
    mock_llm.teardown_checks = False  # unmatched requests are the point here
    engine = engine_factory(llm_url=mock_llm.v1_url)

    await _expect_audit_error(engine, "test-pkg-child-success")

    entries = mock_llm.unmatched()["entries"]
    assert entries, "provider-down audit must have hit the mock"
    models_attempted = {entry["model"] for entry in entries}
    assert "mock-triage" in models_attempted
    # The chain advanced to at least one DIFFERENT model before erroring.
    assert len(models_attempted) >= 2, models_attempted


async def test_s16b_malformed_output_error(engine_factory, mock_llm: MockLlmClient):
    """S16 [C3,C14]: every model returns a truncated (finish_reason=length,
    invalid JSON) completion → audit_error, never SAFE, no report file."""
    mock_llm.load(
        scripted_roles={
            "intent": {"kind": "truncated"},
            "flag": {"kind": "truncated"},
        }
    )
    engine = engine_factory(llm_url=mock_llm.v1_url)
    await _expect_audit_error(engine, "test-pkg-child-success")


async def test_s16c_provider_timeout_error(engine_factory, mock_llm: MockLlmClient):
    """S16 [C3,C14]: provider responses delayed past NPMGUARD_LLM_TIMEOUT_SECONDS
    on every model → audit_error, never SAFE, no report file."""
    delayed_intent = {
        "kind": "delay",
        "delay_ms": LLM_DELAY_MS,
        "then": {"kind": "static", "body": SAFE_INTENT_BODY},
    }
    delayed_flag = {
        "kind": "delay",
        "delay_ms": LLM_DELAY_MS,
        "then": {"kind": "static", "body": SAFE_FLAG_BODY},
    }
    mock_llm.load(scripted_roles={"intent": delayed_intent, "flag": delayed_flag})
    engine = engine_factory(llm_url=mock_llm.v1_url, llm_timeout_seconds=LLM_TIMEOUT_SECONDS)
    await _expect_audit_error(engine, "test-pkg-child-success")


@pytest.mark.docker
async def test_s17_sandbox_broken_defers_to_incomplete(engine_factory, mock_llm: MockLlmClient):
    """S17 [C3,C14,C15]: with a nonexistent sandbox image every experiment DEFERs
    (never REFUTEs) → AuditIncompleteError → audit_error NPMGUARD-0031 retryable,
    no SAFE verdict, no report file."""
    mock_llm.load(
        scripted_roles={
            "intent": {"kind": "static", "body": SAFE_INTENT_BODY},
            "flag": {
                "kind": "static",
                "body": {
                    "summary": "Reads environment variables and sends data over the network.",
                    "capabilities": ["ENV_VARS", "NETWORK"],
                    "flags": [
                        {
                            "lines": ["1-1"],
                            "why": "Scripted flag: force the sandbox route for this file.",
                        }
                    ],
                },
            },
            "hypothesis": {"kind": "hypothesis", "claim_kind": "env_exfil"},
            "judge": {"kind": "judge", "malicious": False},  # unreachable: no run succeeds
        }
    )
    engine = engine_factory(
        llm_url=mock_llm.v1_url,
        env={"NPMGUARD_SANDBOX_IMAGE": BROKEN_SANDBOX_IMAGE},
    )

    data, _ = await _expect_audit_error(engine, "test-pkg-child-success")
    assert data["code"] == "NPMGUARD-0031", data
    assert data["retryable"] is True


@pytest.mark.parametrize(
    "package_name",
    [
        pytest.param("ghost-package-npmguard-e2e", id="registry-404"),
        pytest.param("test-pkg-does-not-exist", id="missing-local-fixture"),
    ],
)
async def test_s18_package_not_found(
    engine_factory, mock_llm: MockLlmClient, registry_stub, package_name: str
):
    """S18 [C3]: an unknown package (registry-stub 404; a test-pkg-* name with no
    local fixture also falls through to the registry) surfaces NPMGUARD-0001 on
    the stream — an error, never a verdict, and no LLM traffic at all."""
    engine = engine_factory(llm_url=mock_llm.v1_url, registry_url=registry_stub.base_url)

    data, _ = await _expect_audit_error(engine, package_name)
    assert data["code"] == "NPMGUARD-0001", data
    assert data["retryable"] is False
    # mock_llm teardown asserts the resolve failure never reached the LLM.
