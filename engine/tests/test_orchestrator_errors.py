"""The orchestrator's per-hypothesis error handling splits three ways instead of
one opaque 'Worker error': a per-hyp timeout, a known sandbox/infra failure (with
its captured cause), and any UNEXPECTED exception (logged loud + deferred as an
Internal error so a bug can never be laundered into SAFE nor abort its siblings)."""
from pathlib import Path
from unittest.mock import Mock

from npmguard import orchestrator
from npmguard.config import Settings
from npmguard.contract.models import Claim, FocusRange, Hypothesis, ToolCall
from npmguard.graph import HypothesisGraph
from npmguard.observation import RunUnderObservationError


def _armed_hyp(hyp_id: str = "hyp-1") -> Hypothesis:
    return Hypothesis(
        hypId=hyp_id,
        description="reads NPM_TOKEN and exfiltrates it",
        claim=Claim(kind="env_exfil"),
        focusFiles=["index.js"],
        focusLines=[FocusRange(file="index.js", range="1-2")],
        experiment=[ToolCall(tool="trigger", args={"kind": "entrypoint", "target": "index.js"})],
        severity="high",
        parentHypId=None,
        childHypIds=[],
        state="OPEN",
        createdBy="hypothesize",
        evidenceRefs=[],
        createdAt="2026-07-20T00:00:00Z",
        resolvedAt=None,
        resolution=None,
    )


async def _run_with_failing_experiment(monkeypatch, exc):
    async def boom(*args, **kwargs):
        raise exc

    monkeypatch.setattr(orchestrator, "run_experiment", boom)
    graph = HypothesisGraph("audit-1")
    graph.add(_armed_hyp())
    summary = await orchestrator.run_orchestrator(
        graph,
        package_path=Path("/tmp"),
        artifact_store=Mock(),
        log=Mock(),
        emitter=None,
        stated_purpose="test",
        global_budget_ms=60_000,
        settings=Settings(_env_file=None),
        llm=Mock(),
    )
    return graph.get("hyp-1"), summary


async def test_known_infra_failure_defers_with_captured_cause(monkeypatch) -> None:
    node, summary = await _run_with_failing_experiment(
        monkeypatch,
        RunUnderObservationError("failed to start sandbox container", detail="docker boom"),
    )
    assert node.state == "DEFERRED"
    assert summary.deferred == 1
    assert "Sandbox unavailable" in node.resolution.reason
    assert "docker boom" in node.resolution.reason  # the detail is surfaced


async def test_unexpected_bug_defers_as_internal_error(monkeypatch) -> None:
    # A programming bug (here a ValueError) must not become an opaque worker error;
    # it is deferred as an Internal error naming the type, and logged (loud) upstream.
    node, summary = await _run_with_failing_experiment(monkeypatch, ValueError("surprise bug"))
    assert node.state == "DEFERRED"
    assert summary.deferred == 1
    assert "Internal error (ValueError)" in node.resolution.reason
    assert "surprise bug" in node.resolution.reason


async def test_per_hypothesis_timeout_defers_as_incomplete(monkeypatch) -> None:
    node, summary = await _run_with_failing_experiment(monkeypatch, TimeoutError())
    assert node.state == "DEFERRED"
    assert summary.deferred == 1
    assert "per-hypothesis timeout" in node.resolution.reason
