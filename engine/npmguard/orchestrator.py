from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from pathlib import Path

from kit_llm import CandidateRejected, LlmClient

from .audit_log import AuditLog
from .config import Settings
from .contract.models import EvidenceRef, Hypothesis, RunArtifact
from .events import AuditEmitter
from .evidence import ArtifactStore, RenderedTimeline, render_timeline
from .graph import HypothesisGraph, next_open
from .observation import is_unresolved_module, run_under_observation
from .phases import JudgeVerdict

FULL_ORACLE = {"kernel": True, "network": True, "node": True, "fsDiff": True, "inspector": True}
EXPERIMENT_BUDGET = {"wallMs": 20_000}
PER_HYPOTHESIS_SECONDS = 360


@dataclass(frozen=True)
class JudgeResult:
    confirmed: bool
    reason: str
    cited_events: list[str]
    judge_failed: bool
    verdict: JudgeVerdict


@dataclass(frozen=True)
class ExperimentResult:
    confirmed: bool
    reason: str
    cited_events: list[str]
    judge_failed: bool
    artifact: RunArtifact
    evidence_ref: EvidenceRef
    timeline: str


@dataclass
class OrchestratorSummary:
    dispatched: int = 0
    confirmed: int = 0
    refuted: int = 0
    deferred: int = 0


async def judge_evidence(
    hypothesis: Hypothesis,
    timeline: RenderedTimeline,
    stated_purpose: str,
    llm: LlmClient,
    audit_id: str,
) -> JudgeResult:
    focus = ", ".join(f"{line.file}:{line.range}" for line in hypothesis.focusLines or [])
    setup = json.dumps(
        [call.model_dump(mode="json") for call in hypothesis.experiment or []],
        separators=(",", ":"),
    )
    prompt = (
        f"## Stated purpose (benign baseline)\n{stated_purpose or '(unknown)'}\n\n"
        f"## Hypothesis {hypothesis.hypId}\n- claim: {hypothesis.claim.kind}"
        f"{f' (gated: {hypothesis.claim.gating})' if hypothesis.claim.gating else ''}\n"
        f"- severity: {hypothesis.severity}\n- description: {hypothesis.description}\n"
        f"- suspected code: {focus or ', '.join(hypothesis.focusFiles or []) or '(unspecified)'}\n\n"
        f"## Experiment setup\n{setup}\n"
        "Setup is test context, not proof. Use it to associate planted canary values with observed events; decide only from the timeline.\n\n"
        f"## Execution timeline\n{timeline.text}\n\n## Task\nDid the suspected behavior happen? Cite exact timeline ids for malicious=true."
    )

    def validate_verdict(candidate: JudgeVerdict) -> None:
        cited = set(candidate.citedEvents)
        if candidate.malicious and not cited:
            raise CandidateRejected("malicious=true requires at least one cited timeline event")
        unknown = cited - timeline.ids
        if unknown:
            raise CandidateRejected(f"unknown timeline event ids: {sorted(unknown)}")
        if not candidate.malicious and cited:
            raise CandidateRejected("malicious=false must not cite events")

    try:
        result = await llm.run(
            "judge",
            vars={},
            messages=[{"role": "user", "content": prompt}],
            validate=validate_verdict,
            context=("audit", audit_id),
        )
        verdict = JudgeVerdict.model_validate(result.output)
    except Exception as exc:
        reason = f"Judge model call failed: {exc}"
        verdict = JudgeVerdict(malicious=False, reason=reason, citedEvents=[])
        return JudgeResult(False, reason, [], True, verdict)
    cited = [identity for identity in verdict.citedEvents if identity in timeline.ids]
    return JudgeResult(verdict.malicious and bool(cited), verdict.reason, cited, False, verdict)


async def run_experiment(
    hypothesis: Hypothesis,
    package_path: Path,
    stated_purpose: str,
    settings: Settings,
    llm: LlmClient,
    audit_id: str,
) -> ExperimentResult:
    artifact = await run_under_observation(
        package_path,
        list(hypothesis.experiment or []),
        settings,
        observe=FULL_ORACLE,
        budget=EXPERIMENT_BUDGET,
    )
    timeline = render_timeline(artifact)
    judgment = await judge_evidence(hypothesis, timeline, stated_purpose, llm, audit_id)
    reference = EvidenceRef(kind="run", id=artifact.runId, hash=artifact.contentHash)
    return ExperimentResult(
        judgment.confirmed,
        judgment.reason,
        judgment.cited_events,
        judgment.judge_failed,
        artifact,
        reference,
        timeline.text,
    )


async def _emit_resolved(emitter: AuditEmitter | None, hypothesis: Hypothesis) -> None:
    if emitter:
        await emitter.emit(
            "hypothesis_resolved",
            {
                "hypId": hypothesis.hypId,
                "claim": hypothesis.claim.kind,
                "severity": hypothesis.severity,
                "state": hypothesis.state,
                "by": hypothesis.resolution.by if hypothesis.resolution else "orchestrator",
                "reason": hypothesis.resolution.reason if hypothesis.resolution else "",
            },
        )


async def run_orchestrator(
    graph: HypothesisGraph,
    *,
    package_path: Path,
    artifact_store: ArtifactStore,
    log: AuditLog,
    emitter: AuditEmitter | None,
    stated_purpose: str,
    global_budget_ms: float,
    settings: Settings,
    llm: LlmClient,
) -> OrchestratorSummary:
    started = time.monotonic()
    summary = OrchestratorSummary()
    while (hypothesis := next_open(graph)) is not None:
        if (time.monotonic() - started) * 1000 > global_budget_ms:
            for pending in graph.filter_by_state("OPEN"):
                graph.transition(
                    pending.hypId,
                    "DEFERRED",
                    by="orchestrator",
                    reason=f"Analysis budget ({global_budget_ms}ms) exhausted before this hypothesis was dispatched.",
                )
                summary.deferred += 1
                await _emit_resolved(emitter, graph.get(pending.hypId))
            break
        graph.transition(hypothesis.hypId, "IN_PROGRESS", by="orchestrator")
        summary.dispatched += 1
        if not hypothesis.experiment:
            raise AssertionError(
                f"orchestrator: unarmed hypothesis {hypothesis.hypId} reached dispatch"
            )
        try:
            async with asyncio.timeout(PER_HYPOTHESIS_SECONDS):
                result = await run_experiment(
                    hypothesis, package_path, stated_purpose, settings, llm, graph.audit_id
                )
            artifact_value = result.artifact.model_dump(mode="json", exclude_none=False)
            declared_hash = artifact_value.pop("contentHash")
            stored_hash = artifact_store.write_artifact(artifact_value)
            if stored_hash != declared_hash:
                raise RuntimeError(
                    f"artifact hash mismatch: artifact={declared_hash} store={stored_hash}"
                )
            log.write(f"timeline-{hypothesis.hypId}.md", result.timeline)
            log.write(
                f"experiment-{hypothesis.hypId}.json",
                {
                    "hypId": hypothesis.hypId,
                    "confirmed": result.confirmed,
                    "reason": result.reason,
                    "citedEvents": result.cited_events,
                    "runId": result.artifact.runId,
                    "artifactHash": stored_hash,
                    "evidenceRef": result.evidence_ref.model_dump(mode="json"),
                    "wallMs": result.artifact.wallMs,
                    "eventCount": len(result.artifact.events),
                    "eventSummary": result.artifact.eventSummary.model_dump(mode="json"),
                    "error": result.artifact.error.model_dump(mode="json")
                    if result.artifact.error
                    else None,
                },
            )
            if result.confirmed:
                graph.transition(
                    hypothesis.hypId,
                    "CONFIRMED",
                    by="worker:experimenter",
                    reason=result.reason,
                    evidence_refs=[result.evidence_ref],
                )
                summary.confirmed += 1
            else:
                error = result.artifact.error
                error_kind = error.kind if error else None
                # A crash at module resolution means the program-under-test never
                # loaded (e.g. an uninstalled dependency), so the suspected path
                # never ran. That is a coverage gap, not a refutation — deferring
                # keeps a broken run from laundering an unproven suspicion into SAFE.
                unresolved_module = is_unresolved_module(error)
                if (
                    error_kind in {"SetupError", "SensorError", "TimeoutError"}
                    or result.judge_failed
                    or unresolved_module
                ):
                    graph.add_evidence(hypothesis.hypId, [result.evidence_ref])
                    if result.judge_failed:
                        reason = f"Judge could not evaluate the run: {result.reason}"
                    elif unresolved_module:
                        reason = f"Program-under-test could not be loaded ({error.detail})"
                    else:
                        reason = f"Observation incomplete ({error_kind}): {result.reason}"
                    graph.transition(
                        hypothesis.hypId, "DEFERRED", by="worker:experimenter", reason=reason
                    )
                    summary.deferred += 1
                else:
                    graph.transition(
                        hypothesis.hypId,
                        "REFUTED",
                        by="worker:experimenter",
                        reason=result.reason,
                        evidence_refs=[result.evidence_ref],
                    )
                    summary.refuted += 1
        except Exception as exc:
            if graph.get(hypothesis.hypId).state == "IN_PROGRESS":
                # Surface .detail (e.g. RunUnderObservationError carries the docker
                # stderr) so a deferred worker error names its actual cause instead
                # of an opaque one-liner.
                detail = getattr(exc, "detail", None)
                graph.transition(
                    hypothesis.hypId,
                    "DEFERRED",
                    by="worker:experimenter",
                    reason=f"Worker error: {exc}" + (f" — {detail}" if detail else ""),
                )
                summary.deferred += 1
        await _emit_resolved(emitter, graph.get(hypothesis.hypId))
    return summary
