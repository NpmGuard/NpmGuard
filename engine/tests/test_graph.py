from pathlib import Path

import pytest

from npmguard.contract.models import Claim, EvidenceRef, FocusRange, Hypothesis
from npmguard.graph import (
    HypothesisGraph,
    HypothesisGraphError,
    derive_graph_verdict,
    next_open,
)


def hypothesis(hypothesis_id: str = "hyp-1", **changes) -> Hypothesis:
    values = {
        "hypId": hypothesis_id,
        "description": "reads NPM_TOKEN and sends it to attacker.example",
        "claim": Claim(kind="env_exfil"),
        "focusFiles": ["index.js"],
        "focusLines": [FocusRange(file="index.js", range="4-8")],
        "experiment": [],
        "severity": "high",
        "parentHypId": None,
        "childHypIds": [],
        "state": "OPEN",
        "createdBy": "hypothesize",
        "evidenceRefs": [],
        "createdAt": "2026-07-20T00:00:00Z",
        "resolvedAt": None,
        "resolution": None,
    }
    values.update(changes)
    return Hypothesis(**values)


def evidence(identifier: str = "run-1") -> EvidenceRef:
    return EvidenceRef(kind="run", id=identifier, hash="abc123")


def test_transitions_require_evidence_and_terminal_states_are_sticky() -> None:
    graph = HypothesisGraph("audit-1")
    graph.add(hypothesis())
    graph.transition("hyp-1", "IN_PROGRESS", by="orchestrator")
    with pytest.raises(HypothesisGraphError, match="evidenceRef"):
        graph.transition("hyp-1", "CONFIRMED", by="judge")
    resolved = graph.transition("hyp-1", "CONFIRMED", by="judge", evidence_refs=[evidence()])
    assert resolved.resolution and resolved.resolution.by == "judge"
    with pytest.raises(HypothesisGraphError, match="terminal"):
        graph.transition("hyp-1", "REFUTED", by="judge", evidence_refs=[evidence()])


def test_deferred_is_not_a_safe_verdict() -> None:
    graph = HypothesisGraph("audit-1")
    graph.add(hypothesis())
    graph.transition("hyp-1", "DEFERRED", by="orchestrator", reason="sensor failed")
    with pytest.raises(AssertionError, match="SAFE"):
        derive_graph_verdict(graph)


def test_confirmed_always_wins_and_priority_is_severity_first() -> None:
    graph = HypothesisGraph("audit-1")
    graph.add(hypothesis("low", severity="low", createdAt="2020-01-01T00:00:00Z"))
    graph.add(hypothesis("critical", severity="critical", createdAt="2026-01-01T00:00:00Z"))
    assert next_open(graph).hypId == "critical"
    graph.transition("critical", "CONFIRMED", by="judge", evidence_refs=[evidence()])
    graph.transition("low", "REFUTED", by="judge", evidence_refs=[evidence("run-2")])
    verdict = derive_graph_verdict(graph)
    assert verdict.verdict == "DANGEROUS"
    assert verdict.confirmed_hyp_ids == ["critical"]


def test_merge_and_persistence_round_trip(tmp_path: Path) -> None:
    graph = HypothesisGraph("audit-1")
    graph.add(hypothesis("original"))
    merged, was_merged = graph.add_or_merge(
        hypothesis(
            "duplicate",
            focusFiles=["setup.js"],
            focusLines=[FocusRange(file="setup.js", range="1-2")],
        )
    )
    assert was_merged is True
    assert graph.size == 1
    assert merged.focusFiles == ["index.js", "setup.js"]
    path = tmp_path / "graph.json"
    graph.save_to(path)
    restored = HypothesisGraph.load_from(path)
    assert restored.serialize() == graph.serialize()
