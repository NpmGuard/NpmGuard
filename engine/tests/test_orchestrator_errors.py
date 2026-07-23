# CLASS MAP — run_orchestrator per-hypothesis error split (seam: monkeypatched
# module-level orchestrator.run_experiment — the same seam the slice tier's
# RecordedSandbox replay uses; artifact store and audit log are the real things
# over tmp dirs, and the llm is a fail-loud sentinel since no error path may
# reach the judge)
# Axes: exception type raised by the experiment runner
#   C1 known infra failure (RunUnderObservationError) → DEFERRED with the
#      captured cause surfaced in resolution.reason
#   C2 unexpected exception (a bug) → DEFERRED as "Internal error (<Type>)" —
#      never laundered into SAFE, never aborts sibling hypotheses
#   C3 per-hypothesis timeout → DEFERRED as incomplete observation
# Success/judge/budget classes (design map 3.2 C1–C12) are the slice tier's:
# they replay recorded runartifacts + real judge traffic (tests/slice/).
# Adversarial pass: 2026-07-23/W6 — Mock() collaborators replaced with real
# ArtifactStore/AuditLog + a sentinel llm so an error path that unexpectedly
# touches them fails loud instead of vanishing into a Mock.
from typing import Any, cast

from npmguard import orchestrator
from npmguard.audit_log import AuditLog
from npmguard.config import Settings
from npmguard.contract.models import Claim, FocusRange, Hypothesis, ToolCall
from npmguard.evidence import ArtifactStore
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


async def _run_with_failing_experiment(monkeypatch, tmp_path, exc):
    async def boom(*args, **kwargs):
        raise exc

    monkeypatch.setattr(orchestrator, "run_experiment", boom)
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "audit-logs"))
    graph = HypothesisGraph("audit-1")
    graph.add(_armed_hyp())
    summary = await orchestrator.run_orchestrator(
        graph,
        package_path=tmp_path,
        artifact_store=ArtifactStore(tmp_path / "artifacts"),
        log=AuditLog("test-orchestrator-errors"),
        emitter=None,
        stated_purpose="test",
        global_budget_ms=60_000,
        settings=Settings(_env_file=None),
        # No error path may consult the judge; a bare object fails loud if one does.
        llm=cast(Any, object()),
    )
    return graph.get("hyp-1"), summary


async def test_known_infra_failure_defers_with_captured_cause(monkeypatch, tmp_path) -> None:
    """C1: infra failure → DEFERRED, cause + detail surfaced in the reason."""
    node, summary = await _run_with_failing_experiment(
        monkeypatch,
        tmp_path,
        RunUnderObservationError("failed to start sandbox container", detail="docker boom"),
    )
    assert node.state == "DEFERRED"
    assert summary.deferred == 1
    assert "Sandbox unavailable" in node.resolution.reason
    assert "docker boom" in node.resolution.reason  # the detail is surfaced


async def test_unexpected_bug_defers_as_internal_error(monkeypatch, tmp_path) -> None:
    """C2: a programming bug (here a ValueError) must not become an opaque worker
    error; it is deferred as an Internal error naming the type, and logged loud."""
    node, summary = await _run_with_failing_experiment(
        monkeypatch, tmp_path, ValueError("surprise bug")
    )
    assert node.state == "DEFERRED"
    assert summary.deferred == 1
    assert "Internal error (ValueError)" in node.resolution.reason
    assert "surprise bug" in node.resolution.reason


async def test_per_hypothesis_timeout_defers_as_incomplete(monkeypatch, tmp_path) -> None:
    """C3: the per-hypothesis cap fired mid-experiment → DEFERRED, not REFUTED."""
    node, summary = await _run_with_failing_experiment(monkeypatch, tmp_path, TimeoutError())
    assert node.state == "DEFERRED"
    assert summary.deferred == 1
    assert "per-hypothesis timeout" in node.resolution.reason
