# CLASS MAP — orchestrator.run_experiment + run_orchestrator success path
# (seams: run_under_observation substituted at the sandbox boundary with hand-built
#  sealed RunArtifacts; the judge runs the REAL kit chain over ScriptedLlm; DB is a
#  throwaway sqlite; emitter observed through a real StreamService)
# Judge:  C1  malicious=true, citedEvents ⊆ timeline → CONFIRMED + severity +
#             hypothesis_resolved emitted on the durable channel
#         C2  malicious=false, no citations → REFUTED with the evidence artifact
#             recorded and readable (claim C4: cleared only with evidence)
#         C3  cited unknown event id → validator rejects → ONE repair → valid → CONFIRMED
#         C4  repair exhausted (every attempt cites an unknown id) → judge_failed →
#             DEFERRED "Judge could not evaluate", never a crash, never REFUTED
#         C5  malicious=false WITH citations → rejected by the validator → DEFERRED
#         C6  empty timeline + malicious=true → nothing citable → DEFERRED
# Budget: C7  global budget exhausted before dispatch → all OPEN deferred with the
#             budget reason, dispatched == 0
#         C7b budget exhausted MID-RUN → the already-dispatched hypothesis keeps its
#             real resolution; only the remainder defers with the budget reason
#         C8  per-hypothesis timeout (PER_HYPOTHESIS_SECONDS boundary, shrunk via the
#             module seam — the constant is not constructor-injectable) → DEFERRED
#             "per-hypothesis timeout"
#         C9  EXPERIMENT_BUDGET / FULL_ORACLE are plumbed verbatim into the
#             observation call by run_experiment
# Aggregate: C10 all REFUTED → derive_graph_verdict SAFE (claim C15)
#            C11 any CONFIRMED in a mix → DANGEROUS wins, confirmed ids listed
#            C12 no CONFIRMED + any DEFERRED → SAFE refused (AssertionError seam);
#                the pipeline maps this exact state to AuditIncompleteError
#                NPMGUARD-0031 (pipeline.py:401-409; e2e S16/S17 pin the wire code)
# Errors: C13 infra DEFER / C14 unexpected DEFER / C15 timeout DEFER — covered in
#         tests/test_orchestrator_errors.py (W6-owned; kept there, renumbered here)
# Plumbing: C16 emitter=None → whole run completes without a crash
#           C17 the stored artifact round-trips: evidenceRef.hash is readable from
#               the ArtifactStore and verifies against its content hash
#           C18 unarmed hypothesis at dispatch — PINNED: the AssertionError is raised
#               OUTSIDE the try, so it aborts the WHOLE run (siblings never dispatch),
#               unlike every in-experiment bug which defers only its own hypothesis
#           C19 stored artifact hash != declared hash → RuntimeError inside the try →
#               generic except → DEFERRED "Internal error", never CONFIRMED/REFUTED
# Adversarial pass: W5 2026-07-23 — "can a judge failure ever launder into
#   REFUTED/SAFE?" → C4/C5/C6 pin every judge-side failure to DEFERRED, and C12
#   pins that DEFERRED can never aggregate to SAFE.
import asyncio

import pytest

from kit_llm import ScriptedLlm
from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from kit_spine.notify_polling import PollingNotifier
from kit_stream import StreamService
from npmguard import orchestrator as orchestrator_module
from npmguard.audit_log import AuditLog
from npmguard.config import Settings
from npmguard.contract.models import (
    Budget,
    Claim,
    EvidenceEvent,
    FocusRange,
    Hypothesis,
    ObserveFlags,
    RunArtifact,
    SetupApplied,
    ToolCall,
    Trigger,
)
from npmguard.events import AuditEmitter, audit_channel
from npmguard.evidence import ArtifactStore, compute_event_summary, seal_run_artifact
from npmguard.graph import HypothesisGraph, derive_graph_verdict
from npmguard.llm_runtime import build_npmguard_llm
from npmguard.orchestrator import (
    EXPERIMENT_BUDGET,
    FULL_ORACLE,
    run_experiment,
    run_orchestrator,
)
from npmguard.phases import JudgeVerdict

AUDIT_ID = "orch-1"
GENEROUS_BUDGET_MS = 60_000
SHRUNK_HYPOTHESIS_SECONDS = 0.05  # C8 boundary, reached via the module seam
STALL_SECONDS = 30  # far past the shrunken timeout; always cancelled, never slept out

CONFIRM = JudgeVerdict(malicious=True, reason="canary exfiltrated", citedEvents=["e1", "e2"])
REFUTE = JudgeVerdict(malicious=False, reason="no malicious behavior", citedEvents=[])
BAD_CITATION = JudgeVerdict(malicious=True, reason="made-up evidence", citedEvents=["e999"])


def _hyp(hyp_id: str = "hyp-1", *, severity: str = "high", created: str = "2026-07-20T00:00:00Z") -> Hypothesis:
    return Hypothesis(
        hypId=hyp_id,
        description=f"{hyp_id}: reads NPM_TOKEN and exfiltrates it",
        claim=Claim(kind="env_exfil"),
        focusFiles=["index.js"],
        focusLines=[FocusRange(file="index.js", range="1-2")],
        experiment=[ToolCall(tool="trigger", args={"kind": "entrypoint", "target": "index.js"})],
        severity=severity,
        parentHypId=None,
        childHypIds=[],
        state="OPEN",
        createdBy="hypothesize",
        evidenceRefs=[],
        createdAt=created,
        resolvedAt=None,
        resolution=None,
    )


def _events() -> list[EvidenceEvent]:
    return [
        EvidenceEvent(
            stream="L4:monkey",
            timestamp=0,
            pid=0,
            kind="env_access",
            raw={"type": "env", "key": "NPM_TOKEN"},
            normalized={"key": "NPM_TOKEN"},
        ),
        EvidenceEvent(
            stream="L4:monkey",
            timestamp=1,
            pid=0,
            kind="network",
            raw={"type": "network", "method": "POST", "url": "http://evil.example/collect"},
            normalized={"method": "POST", "url": "http://evil.example/collect"},
        ),
    ]


def _artifact(run_id: str = "run-1", *, events: list[EvidenceEvent] | None = None) -> RunArtifact:
    events = _events() if events is None else events
    return seal_run_artifact(
        {
            "runId": run_id,
            "triggerUsed": Trigger(kind="entrypoint", target="index.js"),
            "setupApplied": SetupApplied(env={"NPM_TOKEN": "canary"}),
            "observe": ObserveFlags(**FULL_ORACLE),
            "budget": Budget(wallMs=EXPERIMENT_BUDGET["wallMs"]),
            "wallMs": 1234.0,
            "exitCode": 0,
            "timedOut": False,
            "events": events,
            "eventSummary": compute_event_summary(events),
            "error": None,
            "createdAt": "2026-07-20T00:00:00Z",
        }
    )


class FakeObservation:
    """Substitutes run_under_observation at the sandbox boundary: serves sealed
    artifacts in dispatch order and records the exact call plumbing (C9)."""

    def __init__(self, artifacts: list[RunArtifact], *, stall_seconds: float = 0.0) -> None:
        self.artifacts = list(artifacts)
        self.stall_seconds = stall_seconds
        self.calls: list[dict] = []

    async def __call__(self, package_path, experiment, settings, *, observe, budget):
        self.calls.append({"experiment": experiment, "observe": observe, "budget": budget})
        if self.stall_seconds:
            await asyncio.sleep(self.stall_seconds)
        return self.artifacts.pop(0)


class Rig:
    def __init__(self, llm, engine, store, stream, log):
        self.llm = llm
        self.engine = engine
        self.store = store
        self.stream = stream
        self.log = log


@pytest.fixture
async def rig_factory(tmp_path, monkeypatch):
    monkeypatch.setenv("NPMGUARD_AUDIT_LOG_DIR", str(tmp_path / "audit-logs"))
    rigs: list[Rig] = []

    async def build(judge_steps: list) -> Rig:
        engine = make_engine(f"sqlite+aiosqlite:///{tmp_path / f'orch{len(rigs)}.sqlite3'}")
        async with engine.begin() as connection:
            await connection.run_sync(metadata.create_all)
        factory = make_session_factory(engine)
        llm = build_npmguard_llm(
            factory, Settings(_env_file=None), provider=ScriptedLlm({"judge": judge_steps})
        )
        log = AuditLog("orchestrator-unit")
        rig = Rig(llm, engine, ArtifactStore(log.run_dir), StreamService(factory, PollingNotifier()), log)
        rigs.append(rig)
        return rig

    yield build
    for rig in rigs:
        await rig.llm.aclose()
        await rig.engine.dispose()


async def _run(
    rig: Rig,
    monkeypatch,
    tmp_path,
    *,
    hypotheses: list[Hypothesis],
    observation: FakeObservation,
    emitter: AuditEmitter | None = None,
    budget_ms: float = GENEROUS_BUDGET_MS,
):
    monkeypatch.setattr(orchestrator_module, "run_under_observation", observation)
    graph = HypothesisGraph(AUDIT_ID)
    for hypothesis in hypotheses:
        graph.add(hypothesis)
    summary = await run_orchestrator(
        graph,
        package_path=tmp_path,
        artifact_store=rig.store,
        log=rig.log,
        emitter=emitter,
        stated_purpose="left-pad: pads strings",
        global_budget_ms=budget_ms,
        settings=Settings(_env_file=None),
        llm=rig.llm,
    )
    return graph, summary


async def test_confirmed_with_citations_and_resolved_event(rig_factory, monkeypatch, tmp_path) -> None:
    """C1: malicious=true citing real timeline ids → CONFIRMED with severity and
    a hypothesis_resolved event carrying state/severity/reason on the channel."""
    rig = await rig_factory([CONFIRM])
    emitter = AuditEmitter(AUDIT_ID, rig.stream)
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()]),
        emitter=emitter,
    )
    node = graph.get("hyp-1")
    assert node.state == "CONFIRMED"
    assert summary.confirmed == 1 and summary.dispatched == 1
    assert node.resolution is not None and node.resolution.by == "worker:experimenter"
    events = await rig.stream.read_after(audit_channel(AUDIT_ID), -1)
    resolved = [event for event in events if event["type"] == "hypothesis_resolved"]
    assert len(resolved) == 1
    assert resolved[0]["data"]["hypId"] == "hyp-1"
    assert resolved[0]["data"]["state"] == "CONFIRMED"
    assert resolved[0]["data"]["severity"] == "high"
    assert resolved[0]["data"]["reason"] == "canary exfiltrated"


async def test_refuted_records_evidence_artifact(rig_factory, monkeypatch, tmp_path) -> None:
    """C2 (claim C4): malicious=false with no citations → REFUTED, and the run
    artifact backing the refutation is stored and referenced — a suspicion is
    cleared only WITH evidence."""
    rig = await rig_factory([REFUTE])
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()]),
    )
    node = graph.get("hyp-1")
    assert node.state == "REFUTED"
    assert summary.refuted == 1
    assert node.evidenceRefs, "refutation must carry an evidenceRef"
    reference = node.evidenceRefs[-1]
    assert reference.kind == "run"
    stored = rig.store.read_artifact(reference.hash)
    assert stored.runId == "run-1"


async def test_unknown_citation_repaired_then_confirmed(rig_factory, monkeypatch, tmp_path) -> None:
    """C3: the first verdict cites an id absent from the timeline → the validator
    rejects it, one repair round returns a valid citation → CONFIRMED."""
    rig = await rig_factory([BAD_CITATION, CONFIRM])
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()]),
    )
    assert graph.get("hyp-1").state == "CONFIRMED"
    assert summary.confirmed == 1


async def test_repair_exhaustion_defers_never_refutes(rig_factory, monkeypatch, tmp_path) -> None:
    """C4: every attempt (repairs and model fallbacks alike) cites an unknown id →
    the judge fails closed and the hypothesis is DEFERRED — an unevaluated
    suspicion is never laundered into REFUTED/SAFE."""
    rig = await rig_factory([BAD_CITATION])  # ScriptedLlm repeats the last step forever
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()]),
    )
    node = graph.get("hyp-1")
    assert node.state == "DEFERRED"
    assert summary.deferred == 1 and summary.refuted == 0
    assert "Judge could not evaluate" in node.resolution.reason


async def test_refute_with_citations_rejected(rig_factory, monkeypatch, tmp_path) -> None:
    """C5: malicious=false MUST not cite events — a contradictory verdict is
    rejected every round and the hypothesis is DEFERRED, not refuted."""
    contradictory = JudgeVerdict(malicious=False, reason="benign but citing", citedEvents=["e1"])
    rig = await rig_factory([contradictory])
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()]),
    )
    assert graph.get("hyp-1").state == "DEFERRED"
    assert summary.refuted == 0


async def test_empty_timeline_cannot_confirm(rig_factory, monkeypatch, tmp_path) -> None:
    """C6: an artifact with zero events renders an empty timeline — malicious=true
    has nothing citable, so the verdict is rejected and the hypothesis DEFERRED."""
    uncited_confirm = JudgeVerdict(malicious=True, reason="gut feeling", citedEvents=[])
    rig = await rig_factory([uncited_confirm])
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact(events=[])]),
    )
    assert graph.get("hyp-1").state == "DEFERRED"
    assert summary.confirmed == 0


async def test_exhausted_global_budget_defers_undispatched(rig_factory, monkeypatch, tmp_path) -> None:
    """C7: a zero global budget expires before the first dispatch — every OPEN
    hypothesis is DEFERRED with the budget reason and nothing runs."""
    rig = await rig_factory([REFUTE])
    observation = FakeObservation([])
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp("hyp-1"), _hyp("hyp-2", created="2026-07-20T00:00:01Z")],
        observation=observation,
        budget_ms=0,
    )
    assert summary.dispatched == 0
    assert summary.deferred == 2
    assert observation.calls == []
    for hyp_id in ("hyp-1", "hyp-2"):
        node = graph.get(hyp_id)
        assert node.state == "DEFERRED"
        assert "budget" in node.resolution.reason


async def test_mid_run_budget_exhaustion_defers_only_the_rest(
    rig_factory, monkeypatch, tmp_path
) -> None:
    """C7b: the budget survives the first dispatch but is exhausted by the time the
    second is considered — the first hypothesis keeps its REAL resolution (REFUTED),
    only the remainder defers with the budget reason. (The stalled observation burns
    more wall time than the whole budget, so exhaustion-after-one is guaranteed.)"""
    budget_ms = 50
    rig = await rig_factory([REFUTE])
    observation = FakeObservation(
        [_artifact()], stall_seconds=(budget_ms / 1000) * 4
    )
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp("hyp-1"), _hyp("hyp-2", created="2026-07-20T00:00:01Z")],
        observation=observation,
        budget_ms=budget_ms,
    )
    assert summary.dispatched == 1
    assert len(observation.calls) == 1  # the second experiment never ran
    assert graph.get("hyp-1").state == "REFUTED"
    node = graph.get("hyp-2")
    assert node.state == "DEFERRED"
    assert "budget" in node.resolution.reason
    assert summary.refuted == 1 and summary.deferred == 1


async def test_unarmed_hypothesis_aborts_whole_run_pinned(
    rig_factory, monkeypatch, tmp_path
) -> None:
    """C18 — PINNED: an unarmed hypothesis reaching dispatch raises AssertionError
    OUTSIDE the try block, aborting the WHOLE run — the armed sibling is never
    dispatched. This is the one in-run bug that escapes the 'one bug must not
    abort siblings' except-clauses; flip this pin if it is ever moved inside."""
    rig = await rig_factory([REFUTE])
    unarmed = _hyp("hyp-unarmed").model_copy(update={"experiment": []})
    observation = FakeObservation([_artifact()])
    with pytest.raises(AssertionError, match="unarmed hypothesis"):
        await _run(
            rig,
            monkeypatch,
            tmp_path,
            hypotheses=[unarmed, _hyp("hyp-armed", created="2026-07-20T00:00:01Z")],
            observation=observation,
        )
    assert observation.calls == []  # the armed sibling never got its experiment


async def test_artifact_hash_mismatch_defers_with_internal_error(
    rig_factory, monkeypatch, tmp_path
) -> None:
    """C19: a store returning a hash different from the artifact's declared
    contentHash raises inside the try → the generic except defers the hypothesis
    as an Internal error — tampered/miswritten evidence never confirms or refutes."""
    rig = await rig_factory([REFUTE])
    monkeypatch.setattr(rig.store, "write_artifact", lambda _value: "not-the-declared-hash")
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()]),
    )
    node = graph.get("hyp-1")
    assert node.state == "DEFERRED"
    assert summary.deferred == 1 and summary.refuted == 0
    assert "Internal error" in node.resolution.reason
    assert "hash mismatch" in node.resolution.reason


async def test_per_hypothesis_timeout_boundary_defers(rig_factory, monkeypatch, tmp_path) -> None:
    """C8: with PER_HYPOTHESIS_SECONDS shrunk through the module seam (the
    constant is not constructor-injectable), a stalled observation is cancelled
    at the boundary and the hypothesis DEFERRED as a per-hypothesis timeout."""
    monkeypatch.setattr(orchestrator_module, "PER_HYPOTHESIS_SECONDS", SHRUNK_HYPOTHESIS_SECONDS)
    rig = await rig_factory([REFUTE])
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()], stall_seconds=STALL_SECONDS),
    )
    node = graph.get("hyp-1")
    assert node.state == "DEFERRED"
    assert summary.deferred == 1
    assert "per-hypothesis timeout" in node.resolution.reason


async def test_experiment_budget_plumbed_into_observation(rig_factory, monkeypatch, tmp_path) -> None:
    """C9: run_experiment forwards FULL_ORACLE and EXPERIMENT_BUDGET verbatim to
    the observation boundary, and returns the artifact's own evidence ref."""
    rig = await rig_factory([REFUTE])
    artifact = _artifact()
    observation = FakeObservation([artifact])
    monkeypatch.setattr(orchestrator_module, "run_under_observation", observation)
    hypothesis = _hyp()
    result = await run_experiment(
        hypothesis, tmp_path, "left-pad: pads strings", Settings(_env_file=None), rig.llm, AUDIT_ID
    )
    assert len(observation.calls) == 1
    call = observation.calls[0]
    assert call["observe"] is FULL_ORACLE
    assert call["budget"] is EXPERIMENT_BUDGET
    assert EXPERIMENT_BUDGET == {"wallMs": 20_000}
    assert call["experiment"] == list(hypothesis.experiment)
    assert result.confirmed is False
    assert result.evidence_ref.id == artifact.runId
    assert result.evidence_ref.hash == artifact.contentHash


async def test_all_refuted_aggregates_safe(rig_factory, monkeypatch, tmp_path) -> None:
    """C10 (claim C15): every hypothesis refuted → SAFE with full counts."""
    rig = await rig_factory([REFUTE])
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp("hyp-1"), _hyp("hyp-2", created="2026-07-20T00:00:01Z")],
        observation=FakeObservation([_artifact("run-1"), _artifact("run-2")]),
    )
    assert summary.refuted == 2
    verdict = derive_graph_verdict(graph)
    assert verdict.verdict == "SAFE"
    assert verdict.counts.refuted == 2 and verdict.counts.total == 2
    assert verdict.confirmed_hyp_ids == []


async def test_any_confirmed_aggregates_dangerous(rig_factory, monkeypatch, tmp_path) -> None:
    """C11 (claim C15): one confirmation among refutations → DANGEROUS wins and
    the confirmed hypothesis is listed."""
    rig = await rig_factory([CONFIRM, REFUTE])
    graph, _ = await _run(
        rig,
        monkeypatch,
        tmp_path,
        # critical dispatches first → the CONFIRM step matches it
        hypotheses=[_hyp("hyp-crit", severity="critical"), _hyp("hyp-low", severity="low")],
        observation=FakeObservation([_artifact("run-1"), _artifact("run-2")]),
    )
    verdict = derive_graph_verdict(graph)
    assert verdict.verdict == "DANGEROUS"
    assert verdict.confirmed_hyp_ids == ["hyp-crit"]
    assert verdict.counts.confirmed == 1 and verdict.counts.refuted == 1


async def test_deferred_never_aggregates_safe(rig_factory, monkeypatch, tmp_path) -> None:
    """C12 (claims C14/C15): DEFERRED with no confirmation cannot become SAFE —
    derive_graph_verdict refuses the state outright. The pipeline maps this exact
    state to AuditIncompleteError NPMGUARD-0031/retryable (pipeline.py:401-409;
    the wire code is pinned at the e2e tier, S16/S17)."""
    rig = await rig_factory([BAD_CITATION])  # judge exhaustion → DEFERRED
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()]),
    )
    assert summary.deferred == 1 and summary.confirmed == 0
    with pytest.raises(AssertionError, match="unevaluated"):
        derive_graph_verdict(graph)


async def test_emitter_none_completes_cleanly(rig_factory, monkeypatch, tmp_path) -> None:
    """C16: the whole orchestrator run (confirm path included) works with
    emitter=None — event emission is optional plumbing, not a dependency."""
    rig = await rig_factory([CONFIRM])
    graph, summary = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()]),
        emitter=None,
    )
    assert graph.get("hyp-1").state == "CONFIRMED"
    assert summary.confirmed == 1


async def test_stored_artifact_round_trips_and_verifies(rig_factory, monkeypatch, tmp_path) -> None:
    """C17: the evidenceRef hash written by the orchestrator is readable from the
    ArtifactStore and passes content-hash verification — evidence is durable and
    tamper-evident, observable purely through public store APIs."""
    rig = await rig_factory([CONFIRM])
    graph, _ = await _run(
        rig,
        monkeypatch,
        tmp_path,
        hypotheses=[_hyp()],
        observation=FakeObservation([_artifact()]),
    )
    reference = graph.get("hyp-1").evidenceRefs[-1]
    stored = rig.store.read_artifact(reference.hash)
    assert stored.runId == "run-1"
    assert len(stored.events) == 2
    assert rig.store.verify_artifact(reference.hash) is True
