from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

import structlog

from kit_llm import CandidateRejected, LlmClient

from .audit_log import AuditLog
from .config import Settings
from .contract.models import EvidenceRef, Hypothesis, RunArtifact
from .errors import DockerUnavailableError
from .events import Emitting
from .evidence import ArtifactStore, RenderedTimeline, render_timeline
from .experiments import compile_experiment
from .graph import HypothesisGraph, next_open
from .observation import (
    RunUnderObservationError,
    is_unresolved_module,
    mint_run_id,
    planned_run,
    run_under_observation,
)
from .phases import JudgeVerdict
from .run_display import observations_for, project_run_display, sanitize_experiment

logger = structlog.get_logger("npmguard.orchestrator")

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
    run_id: str,
    on_run_complete: Callable[[RunArtifact], Awaitable[None]] | None = None,
) -> ExperimentResult:
    """Run the hypothesis's experiment under the full oracle, then judge it.

    `on_run_complete` fires between the two — the only point at which "the
    sandbox is finished and the judge has not started" is a true statement, and
    therefore the only honest place to announce it. A caller that passes nothing
    gets exactly the previous behaviour.
    """
    artifact = await run_under_observation(
        package_path,
        list(hypothesis.experiment or []),
        settings,
        observe=FULL_ORACLE,
        budget=EXPERIMENT_BUDGET,
        run_id=run_id,
    )
    if on_run_complete is not None:
        await on_run_complete(artifact)
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


async def _emit_resolved(
    emitter: Emitting | None,
    hypothesis: Hypothesis,
    *,
    run_id: str | None = None,
    cited_event_ids: list[str] | None = None,
    artifact: RunArtifact | None = None,
) -> None:
    """The terminal frame for one hypothesis, carrying the proof it rests on.

    `citedObservations` is resolved HERE rather than left to the consumer, and it
    is drawn from the artifact rather than from the `sandbox_completed` preview:
    the judge had not run when that frame was emitted, so a cited row may have
    fallen outside its bound. Sending the cited rows again is what makes
    "a confirmed verdict points back at the exact events" total.

    `runId` is null exactly when no run backs the state — a hypothesis deferred
    before dispatch has no experiment to point at, and a null says so.
    """
    if emitter is None:
        return
    await emitter.emit(
        "hypothesis_resolved",
        {
            "hypId": hypothesis.hypId,
            "claim": hypothesis.claim.kind,
            "severity": hypothesis.severity,
            "state": hypothesis.state,
            "by": hypothesis.resolution.by if hypothesis.resolution else "orchestrator",
            "reason": hypothesis.resolution.reason if hypothesis.resolution else "",
            "evidenceRefs": list(hypothesis.evidenceRefs or []),
            "citedEventIds": cited_event_ids or [],
            "citedObservations": (
                observations_for(artifact, cited_event_ids or []) if artifact is not None else []
            ),
            "runId": run_id,
        },
    )


def _run_announcer(
    emitter: Emitting | None, hyp_id: str, run_id: str
) -> Callable[[RunArtifact], Awaitable[None]]:
    """The callback that closes the sandbox and opens the judgment.

    Both frames are emitted from the one moment where each is true: the run is
    sealed and the judge has not been called. Splitting them apart would put
    `judgment_started` either before the evidence exists or after the verdict is
    known, and a viewer would be watching a claim rather than a boundary.
    """

    async def announce(sealed: RunArtifact) -> None:
        if emitter is None:
            return
        await emitter.emit(
            "sandbox_completed",
            {"hypId": hyp_id, "run": project_run_display(sealed, run_id=run_id)},
        )
        await emitter.emit("judgment_started", {"hypId": hyp_id, "runId": run_id})

    return announce


async def run_orchestrator(
    graph: HypothesisGraph,
    *,
    package_path: Path,
    artifact_store: ArtifactStore,
    log: AuditLog,
    emitter: Emitting | None,
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
        # Minted before execution so all four boundary frames share one handle.
        # They announce work this loop already did; they decide nothing, and
        # deleting every emit below leaves each verdict byte-identical.
        run_id = mint_run_id()
        resolved: ExperimentResult | None = None
        try:
            # Inside the try: an experiment that will not compile takes the same
            # route to DEFERRED it always did, and never emits a sandbox frame
            # for a run that cannot start.
            trigger = compile_experiment(list(hypothesis.experiment)).trigger
            observe, budget = planned_run(FULL_ORACLE, EXPERIMENT_BUDGET)
            if emitter:
                await emitter.emit(
                    "experiment_started",
                    {
                        "hypId": hypothesis.hypId,
                        "runId": run_id,
                        "experiment": sanitize_experiment(list(hypothesis.experiment)),
                        "trigger": trigger,
                    },
                )
                await emitter.emit(
                    "sandbox_started",
                    {
                        "hypId": hypothesis.hypId,
                        "runId": run_id,
                        "observe": observe,
                        "budget": budget,
                    },
                )
            async with asyncio.timeout(PER_HYPOTHESIS_SECONDS):
                result = await run_experiment(
                    hypothesis,
                    package_path,
                    stated_purpose,
                    settings,
                    llm,
                    graph.audit_id,
                    run_id,
                    _run_announcer(emitter, hypothesis.hypId, run_id),
                )
            resolved = result
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
                        assert error is not None  # is_unresolved_module implies it
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
        except TimeoutError:
            # The per-hypothesis asyncio.timeout fired: the experiment ran past its
            # cap, so the suspected path was not fully observed. A coverage gap —
            # defer (an incomplete run must never be laundered into REFUTED/SAFE).
            if graph.get(hypothesis.hypId).state == "IN_PROGRESS":
                graph.transition(
                    hypothesis.hypId,
                    "DEFERRED",
                    by="worker:experimenter",
                    reason=(
                        f"Observation incomplete (per-hypothesis timeout {PER_HYPOTHESIS_SECONDS}s)"
                    ),
                )
                summary.deferred += 1
        except (RunUnderObservationError, DockerUnavailableError) as exc:
            # Known sandbox/infra failure: the experiment could not be run. Defer
            # with the captured cause (RunUnderObservationError carries docker stderr).
            if graph.get(hypothesis.hypId).state == "IN_PROGRESS":
                detail = getattr(exc, "detail", None)
                graph.transition(
                    hypothesis.hypId,
                    "DEFERRED",
                    by="worker:experimenter",
                    reason=f"Sandbox unavailable: {exc}" + (f" — {detail}" if detail else ""),
                )
                summary.deferred += 1
        except Exception as exc:
            # UNEXPECTED — a bug or invariant violation, not a known failure mode.
            # Never hide it: log the full traceback so it is actionable. Still defer
            # this ONE hypothesis (a bug must not clear a suspicion into SAFE, and one
            # bug must not abort the sibling hypotheses), so the audit still ERRORs if
            # nothing confirms — now with a loud, located cause instead of silence.
            logger.exception(
                "orchestrator worker error",
                hyp_id=hypothesis.hypId,
                audit_id=graph.audit_id,
                error_type=type(exc).__name__,
            )
            if graph.get(hypothesis.hypId).state == "IN_PROGRESS":
                graph.transition(
                    hypothesis.hypId,
                    "DEFERRED",
                    by="worker:experimenter",
                    reason=f"Internal error ({type(exc).__name__}): {exc}",
                )
                summary.deferred += 1
        await _emit_resolved(
            emitter,
            graph.get(hypothesis.hypId),
            run_id=run_id,
            cited_event_ids=list(resolved.cited_events) if resolved else [],
            artifact=resolved.artifact if resolved else None,
        )
    return summary
