from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from .contract.models import (
    EvidenceRef,
    Hypothesis,
    HypothesisCounts,
    HypothesisGraphSnapshot,
    HypothesisResolution,
)

TERMINAL_STATES = frozenset({"CONFIRMED", "REFUTED", "DEFERRED"})
DEFAULT_MERGE_THRESHOLD = 0.88
SEVERITY_ORDER = {"critical": 4, "high": 3, "medium": 2, "low": 1}


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


class HypothesisGraphError(ValueError):
    pass


def jaro_winkler(left: str, right: str) -> float:
    if not left and not right:
        return 1
    if not left or not right:
        return 0
    if left == right:
        return 1
    window = max(0, max(len(left), len(right)) // 2 - 1)
    left_matches = [False] * len(left)
    right_matches = [False] * len(right)
    matches = 0
    for i, char in enumerate(left):
        for j in range(max(0, i - window), min(len(right), i + window + 1)):
            if right_matches[j] or char != right[j]:
                continue
            left_matches[i] = True
            right_matches[j] = True
            matches += 1
            break
    if matches == 0:
        return 0
    matched_right = [char for char, matched in zip(right, right_matches, strict=True) if matched]
    matched_left = [char for char, matched in zip(left, left_matches, strict=True) if matched]
    transpositions = sum(a != b for a, b in zip(matched_left, matched_right, strict=True)) // 2
    jaro = (matches / len(left) + matches / len(right) + (matches - transpositions) / matches) / 3
    prefix = 0
    for a, b in zip(left[:4], right[:4], strict=False):
        if a != b:
            break
        prefix += 1
    return jaro + prefix * 0.1 * (1 - jaro)


def similar_description(left: str, right: str, threshold: float = DEFAULT_MERGE_THRESHOLD) -> bool:
    def normalize(value: str) -> str:
        return re.sub(r"\s+", " ", value.lower()).strip()

    return jaro_winkler(normalize(left), normalize(right)) >= threshold


class HypothesisGraph:
    def __init__(self, audit_id: str, *, clock=now_iso) -> None:
        self.audit_id = audit_id
        self._clock = clock
        self.created_at = clock()
        self.updated_at = self.created_at
        self._nodes: dict[str, Hypothesis] = {}

    @property
    def size(self) -> int:
        return len(self._nodes)

    def add(self, hypothesis: Hypothesis) -> Hypothesis:
        parsed = Hypothesis.model_validate(hypothesis)
        if parsed.state == "OPEN" and not parsed.experiment:
            # INVARIANT: every OPEN node admitted to the graph carries a
            # non-empty compiled experiment — the generators return an armed,
            # dry-run-verified Hypothesis or raise, so dispatch can trust any
            # node it picks without re-checking.
            raise AssertionError(f"graph: unarmed hypothesis {parsed.hypId} admitted as OPEN")
        if parsed.hypId in self._nodes:
            raise HypothesisGraphError(f"duplicate hypId: {parsed.hypId}")
        if parsed.parentHypId is not None:
            parent = self._nodes.get(parsed.parentHypId)
            if parent is None:
                raise HypothesisGraphError(f"parent not found: {parsed.parentHypId}")
            children = list(parent.childHypIds or [])
            if parsed.hypId not in children:
                self._nodes[parent.hypId] = parent.model_copy(
                    update={"childHypIds": [*children, parsed.hypId]}
                )
        self._nodes[parsed.hypId] = parsed
        self.updated_at = self._clock()
        return parsed

    def get(self, hypothesis_id: str) -> Hypothesis:
        try:
            return self._nodes[hypothesis_id]
        except KeyError as error:
            raise HypothesisGraphError(f"hypothesis not found: {hypothesis_id}") from error

    def all(self) -> list[Hypothesis]:
        return list(self._nodes.values())

    def filter_by_state(self, state: str) -> list[Hypothesis]:
        return [hypothesis for hypothesis in self._nodes.values() if hypothesis.state == state]

    def add_or_merge(
        self, hypothesis: Hypothesis, threshold: float = DEFAULT_MERGE_THRESHOLD
    ) -> tuple[Hypothesis, bool]:
        parsed = Hypothesis.model_validate(hypothesis)
        duplicate = next(
            (
                node
                for node in self._nodes.values()
                if similar_description(parsed.description, node.description, threshold)
            ),
            None,
        )
        if duplicate is None:
            return self.add(parsed), False
        files = list(dict.fromkeys([*(duplicate.focusFiles or []), *(parsed.focusFiles or [])]))
        lines = list(duplicate.focusLines or [])
        seen = {(line.file, line.range) for line in lines}
        for line in parsed.focusLines or []:
            if (line.file, line.range) not in seen:
                lines.append(line)
                seen.add((line.file, line.range))
        merged = Hypothesis.model_validate(
            duplicate.model_copy(update={"focusFiles": files, "focusLines": lines})
        )
        self._nodes[duplicate.hypId] = merged
        self.updated_at = self._clock()
        return merged, True

    def add_evidence(self, hypothesis_id: str, refs: list[EvidenceRef]) -> Hypothesis:
        current = self.get(hypothesis_id)
        updated = Hypothesis.model_validate(
            current.model_copy(update={"evidenceRefs": [*(current.evidenceRefs or []), *refs]})
        )
        self._nodes[hypothesis_id] = updated
        self.updated_at = self._clock()
        return updated

    def transition(
        self,
        hypothesis_id: str,
        to: Literal["OPEN", "IN_PROGRESS", "CONFIRMED", "REFUTED", "DEFERRED"],
        *,
        by: str,
        reason: str | None = None,
        evidence_refs: list[EvidenceRef] | None = None,
        resolved_at: str | None = None,
    ) -> Hypothesis:
        current = self.get(hypothesis_id)
        if current.state in TERMINAL_STATES:
            raise HypothesisGraphError(
                f"cannot transition {hypothesis_id} out of terminal state {current.state}"
            )
        refs = [*(current.evidenceRefs or []), *(evidence_refs or [])]
        if to in {"CONFIRMED", "REFUTED"} and not refs:
            raise HypothesisGraphError(
                f"transition to {to} requires at least one evidenceRef (got 0)"
            )
        if to == "DEFERRED" and not reason:
            raise HypothesisGraphError("transition to DEFERRED requires resolution.reason")
        terminal = to in TERMINAL_STATES
        now = self._clock()
        updated = current.model_copy(
            update={
                "state": to,
                "evidenceRefs": refs,
                "resolvedAt": (resolved_at or now) if terminal else None,
                "resolution": HypothesisResolution(reason=reason or "", by=by)
                if terminal
                else None,
            }
        )
        parsed = Hypothesis.model_validate(updated)
        self._nodes[hypothesis_id] = parsed
        self.updated_at = now
        return parsed

    def serialize(self) -> HypothesisGraphSnapshot:
        return HypothesisGraphSnapshot(
            version=1,
            auditId=self.audit_id,
            nodes=self.all(),
            createdAt=self.created_at,
            updatedAt=self.updated_at,
        )

    def save_to(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.serialize().model_dump_json(indent=2), encoding="utf-8")

    @classmethod
    def load(cls, snapshot: HypothesisGraphSnapshot, *, clock=now_iso) -> HypothesisGraph:
        parsed = HypothesisGraphSnapshot.model_validate(snapshot)
        graph = cls(parsed.auditId, clock=clock)
        graph.created_at = parsed.createdAt
        graph.updated_at = parsed.updatedAt
        graph._nodes = {node.hypId: node for node in parsed.nodes}
        return graph

    @classmethod
    def load_from(cls, path: Path, *, clock=now_iso) -> HypothesisGraph:
        return cls.load(
            HypothesisGraphSnapshot.model_validate_json(path.read_text(encoding="utf-8")),
            clock=clock,
        )


def build_graph(audit_id: str, hypotheses: list[Hypothesis]) -> tuple[HypothesisGraph, int, int]:
    graph = HypothesisGraph(audit_id)
    merged = added = 0
    for hypothesis in hypotheses:
        _, did_merge = graph.add_or_merge(hypothesis)
        merged += int(did_merge)
        added += int(not did_merge)
    return graph, merged, added


def next_open(graph: HypothesisGraph) -> Hypothesis | None:
    nodes = graph.filter_by_state("OPEN")
    return (
        min(nodes, key=lambda node: (-SEVERITY_ORDER[node.severity or "medium"], node.createdAt))
        if nodes
        else None
    )


@dataclass(frozen=True)
class GraphVerdict:
    verdict: Literal["SAFE", "DANGEROUS"]
    rationale: str
    counts: HypothesisCounts
    confirmed_hyp_ids: list[str]


def derive_graph_verdict(graph: HypothesisGraph) -> GraphVerdict:
    nodes = graph.all()
    values = {
        state: len(graph.filter_by_state(state))
        for state in ("OPEN", "IN_PROGRESS", "CONFIRMED", "REFUTED", "DEFERRED")
    }
    counts = HypothesisCounts(
        total=len(nodes),
        open=values["OPEN"],
        inProgress=values["IN_PROGRESS"],
        confirmed=values["CONFIRMED"],
        refuted=values["REFUTED"],
        deferred=values["DEFERRED"],
    )
    if counts.open or counts.inProgress:
        raise AssertionError(
            f"derive_graph_verdict: {counts.open + counts.inProgress} unresolved node(s)"
        )
    confirmed_ids = [node.hypId for node in nodes if node.state == "CONFIRMED"]
    if counts.confirmed:
        suffix = "is" if counts.confirmed == 1 else "eses"
        return GraphVerdict(
            "DANGEROUS",
            f"{counts.confirmed} confirmed hypoth{suffix} with cited dynamic evidence.",
            counts,
            confirmed_ids,
        )
    if counts.deferred:
        raise AssertionError(
            f"derive_graph_verdict: SAFE with {counts.deferred} unevaluated node(s)"
        )
    rationale = (
        "No suspicions were raised."
        if counts.total == 0
        else f"All {counts.total} suspicion{'s' if counts.total != 1 else ''} ran and showed no malice."
    )
    return GraphVerdict("SAFE", rationale, counts, confirmed_ids)
