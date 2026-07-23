from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from kit_llm import LlmClient

from .audit_log import AuditLog
from .config import SOURCE_FILE_TYPES, Settings
from .contract.models import (
    AuditReport,
    FileSummary,
    FileVerdict,
    Hypothesis,
    HypothesisCounts,
    PhaseLog,
)
from .deps import provision_dependencies
from .errors import AuditIncompleteError, AuditTimeoutError
from .events import AuditEmitter
from .evidence import ArtifactStore
from .graph import HypothesisGraph, build_graph, derive_graph_verdict
from .hypothesis_agent import FallbackHypothesisGenerator, TwoPhaseHypothesisGenerator
from .inventory import analyze_inventory
from .orchestrator import run_orchestrator
from .persistence import AuditSessionStore
from .phases import (
    HypothesisGenerator,
    KitHypothesisGenerator,
    extract_intent,
    run_flag,
    run_hypothesize,
)
from .resolve import ResolvedPackage, cleanup_package, resolve_package

EMPTY_COUNTS = HypothesisCounts(total=0, open=0, inProgress=0, confirmed=0, refuted=0, deferred=0)
SEVERITY_SCORE = {"low": 3, "medium": 6, "high": 8, "critical": 10}


@dataclass(frozen=True)
class AuditResult:
    report: AuditReport
    package_path: Path
    resolved: ResolvedPackage

    def cleanup(self) -> None:
        cleanup_package(self.resolved)


async def _timed_phase[T](
    name: str,
    operation: Callable[[], Awaitable[T]],
    timeout_ms: float,
    input_summary: dict[str, Any],
    output_summary: Callable[[T], dict[str, Any]],
    emitter: AuditEmitter | None,
) -> tuple[T, PhaseLog]:
    if emitter:
        await emitter.emit("phase_started", {"phase": name})
    started = time.monotonic()
    try:
        async with asyncio.timeout(timeout_ms / 1000):
            result = await operation()
    except TimeoutError as exc:
        raise AuditTimeoutError(name, int(timeout_ms)) from exc
    duration = round((time.monotonic() - started) * 1000)
    if emitter:
        await emitter.emit("phase_completed", {"phase": name, "durationMs": duration})
    return result, PhaseLog(
        phase=name, durationMs=duration, input=input_summary, output=output_summary(result)
    )


async def _emit_file_verdicts(
    summaries: list[FileSummary], hypotheses: list[Hypothesis], emitter: AuditEmitter | None
) -> None:
    if emitter is None:
        return
    by_file: dict[str, list[Hypothesis]] = {}
    for hypothesis in hypotheses:
        for file in hypothesis.focusFiles or []:
            by_file.setdefault(file, []).append(hypothesis)
    for summary in summaries:
        nodes = by_file.get(summary.file, [])
        severity = max(
            (node.severity or "medium" for node in nodes),
            key=lambda value: SEVERITY_SCORE[value],
            default="low",
        )
        lines = [
            line.range
            for node in nodes
            for line in node.focusLines or []
            if line.file == summary.file
        ]
        verdict = FileVerdict(
            file=summary.file,
            capabilities=summary.capabilities or [],
            suspiciousPatterns=[node.description for node in nodes],
            suspiciousLines=",".join(lines) or None,
            summary=summary.summary or "",
            riskContribution=SEVERITY_SCORE[severity] if nodes else 0,
        )
        await emitter.emit("file_verdict", {"verdict": verdict})


def _report(
    graph: HypothesisGraph, summaries: list[FileSummary], trace: list[PhaseLog], *, dealbreaker=None
) -> AuditReport:
    verdict = derive_graph_verdict(graph)
    return AuditReport(
        schemaVersion=2,
        verdict=verdict.verdict,
        rationale=verdict.rationale,
        counts=verdict.counts,
        confirmedHypIds=verdict.confirmed_hyp_ids,
        hypotheses=graph.all(),
        fileSummaries=summaries,
        dealbreaker=dealbreaker,
        trace=trace,
    )


async def _emit_verdict(emitter: AuditEmitter | None, report: AuditReport) -> None:
    if emitter:
        await emitter.emit(
            "verdict_reached",
            {
                "verdict": report.verdict,
                "rationale": report.rationale,
                "counts": report.counts,
                "confirmedCount": report.counts.confirmed,
            },
        )


class AuditPipeline:
    def __init__(
        self,
        settings: Settings,
        llm: LlmClient,
        sessions: AuditSessionStore,
        *,
        hypothesis_generator: HypothesisGenerator | None = None,
    ) -> None:
        self.settings = settings
        self.llm = llm
        self.sessions = sessions
        # One-shot primary, agentic two-phase fallback: the union arms the flags
        # one-shot alone can't (measured no single approach wins every route).
        self.hypothesis_generator = hypothesis_generator or FallbackHypothesisGenerator(
            KitHypothesisGenerator(llm), TwoPhaseHypothesisGenerator(llm)
        )

    async def run(
        self,
        package_name: str,
        *,
        audit_id: str,
        version: str | None = None,
        emitter: AuditEmitter | None = None,
    ) -> AuditResult:
        log = AuditLog(package_name)
        artifacts = ArtifactStore(log.run_dir)
        trace: list[PhaseLog] = []
        if emitter:
            await emitter.emit("audit_started", {"packageName": package_name})
        resolved, phase = await _timed_phase(
            "resolve",
            lambda: resolve_package(package_name, version),
            120_000,
            {"packageName": package_name, "version": version},
            lambda value: {"path": str(value.path), "needsCleanup": value.needs_cleanup},
            emitter,
        )
        trace.append(phase)
        log.write(
            "resolve.json",
            {
                "path": str(resolved.path),
                "needsCleanup": resolved.needs_cleanup,
                "tmpdir": str(resolved.tmpdir) if resolved.tmpdir else None,
            },
        )
        await self.sessions.set_package_path(audit_id, str(resolved.path))
        try:
            deps = await provision_dependencies(resolved.path, self.settings)
            log.write(
                "dependencies.json",
                {
                    "installed": deps.installed,
                    "packageCount": deps.package_count,
                    "skipped": deps.skipped_reason,
                    "error": deps.error,
                },
            )
            if emitter:
                await emitter.emit(
                    "dependencies_provisioned",
                    {
                        "installed": deps.installed,
                        "packageCount": deps.package_count,
                        "skipped": deps.skipped_reason,
                        "error": deps.error,
                    },
                )

            inventory, phase = await _timed_phase(
                "inventory",
                lambda: analyze_inventory(resolved.path),
                30_000,
                {"packagePath": str(resolved.path)},
                lambda value: {
                    "fileCount": len(value.files),
                    "sourceFiles": len(
                        [file for file in value.files if file.fileType in SOURCE_FILE_TYPES]
                    ),
                    "flagCount": len(value.flags),
                    "flags": [
                        f"[{flag.severity}] {flag.check}: {flag.detail}" for flag in value.flags
                    ],
                    "hasDealbreaker": value.dealbreaker is not None,
                    "scripts": value.scripts,
                    "metadata": value.metadata.model_dump(mode="json", exclude_none=False),
                    "entryPoints": value.entryPoints.model_dump(mode="json"),
                },
                emitter,
            )
            trace.append(phase)
            log.write("inventory.json", inventory)
            if emitter:
                await emitter.emit("file_list", {"files": inventory.files})
                await emitter.emit(
                    "inventory_meta",
                    {
                        "scripts": inventory.scripts,
                        "dependencies": inventory.dependencies,
                        "entryPoints": inventory.entryPoints,
                        "metadata": inventory.metadata,
                    },
                )

            sources = [
                file
                for file in inventory.files
                if file.fileType in SOURCE_FILE_TYPES and not file.isBinary
            ]
            source_kb = sum(file.sizeBytes for file in sources) / 1024
            timeout_scale = max(
                min(4, 1 + max(0, len(sources) - 20) * 0.025),
                min(4, 1 + max(0, source_kb - 200) / 500),
            )

            if inventory.dealbreaker:
                report = AuditReport(
                    schemaVersion=2,
                    verdict="DANGEROUS",
                    rationale=f"Dealbreaker: {inventory.dealbreaker.check} — {inventory.dealbreaker.detail}",
                    counts=EMPTY_COUNTS,
                    confirmedHypIds=[],
                    hypotheses=[],
                    fileSummaries=[],
                    dealbreaker=inventory.dealbreaker,
                    trace=trace,
                )
                log.write("report.json", report)
                await _emit_verdict(emitter, report)
                return AuditResult(report, resolved.path, resolved)

            intent, phase = await _timed_phase(
                "intent-extraction",
                lambda: extract_intent(resolved.path, inventory, self.llm, audit_id),
                60_000,
                {
                    "packageName": inventory.metadata.name,
                    "description": inventory.metadata.description,
                },
                lambda value: value.model_dump(mode="json"),
                emitter,
            )
            trace.append(phase)
            log.write("intent.json", intent)
            if emitter:
                await emitter.emit(
                    "intent_extracted",
                    {
                        "statedPurpose": intent.statedPurpose,
                        "expectedCapabilities": intent.expectedCapabilities,
                    },
                )

            flagged, phase = await _timed_phase(
                "flag",
                lambda: run_flag(resolved.path, inventory, intent, self.llm, audit_id, emitter),
                300_000 * timeout_scale,
                {
                    "sourceFiles": [
                        {"path": file.path, "sizeBytes": file.sizeBytes} for file in sources
                    ],
                    "flagCount": len(inventory.flags),
                    "packageName": inventory.metadata.name,
                },
                lambda value: value.model_dump(mode="json"),
                emitter,
            )
            trace.append(phase)
            log.write("flag.json", flagged)
            if not flagged.flags:
                graph, _, _ = build_graph(audit_id, [])
                await _emit_file_verdicts(flagged.fileSummaries, [], emitter)
                report = _report(graph, flagged.fileSummaries, trace)
                log.write("report.json", report)
                await _emit_verdict(emitter, report)
                return AuditResult(report, resolved.path, resolved)

            hypotheses, phase = await _timed_phase(
                "hypothesize",
                lambda: run_hypothesize(
                    flagged.flags,
                    self.hypothesis_generator,
                    package_path=resolved.path,
                    intent=intent,
                    entry_points=inventory.entryPoints,
                    audit_id=audit_id,
                    emitter=emitter,
                ),
                300_000 * timeout_scale,
                {"flagCount": len(flagged.flags)},
                lambda values: {
                    "hypothesisCount": len(values),
                    "hypotheses": [
                        {
                            "hypId": item.hypId,
                            "claim": item.claim.kind,
                            "severity": item.severity,
                            "description": item.description,
                            "toolCalls": [call.tool for call in item.experiment or []],
                        }
                        for item in values
                    ],
                },
                emitter,
            )
            trace.append(phase)
            log.write("hypotheses.json", hypotheses)
            await _emit_file_verdicts(flagged.fileSummaries, hypotheses, emitter)
            if emitter:
                await emitter.emit(
                    "triage_complete",
                    {
                        "hypothesisCount": len(hypotheses),
                        "hypotheses": [
                            {
                                "hypId": item.hypId,
                                "claim": item.claim.kind,
                                "severity": item.severity,
                                "description": item.description,
                            }
                            for item in hypotheses
                        ],
                    },
                )
            graph, merged, added = build_graph(audit_id, hypotheses)
            log.write("graph.json", graph.serialize())
            if emitter:
                await emitter.emit(
                    "graph_built",
                    {"nodeCount": graph.size, "addedCount": added, "mergedCount": merged},
                )
                await emitter.emit("phase_started", {"phase": "orchestrator"})
            started = time.monotonic()
            summary = await run_orchestrator(
                graph,
                package_path=resolved.path,
                artifact_store=artifacts,
                log=log,
                emitter=emitter,
                stated_purpose=intent.statedPurpose,
                global_budget_ms=600_000 * timeout_scale,
                settings=self.settings,
                llm=self.llm,
            )
            duration = round((time.monotonic() - started) * 1000)
            if emitter:
                await emitter.emit(
                    "phase_completed", {"phase": "orchestrator", "durationMs": duration}
                )
            trace.append(
                PhaseLog(
                    phase="orchestrator",
                    durationMs=duration,
                    input={"hypotheses": graph.size},
                    output=summary.__dict__,
                )
            )
            log.write("graph-final.json", graph.serialize())
            deferred = graph.filter_by_state("DEFERRED")
            if not graph.filter_by_state("CONFIRMED") and deferred:
                details = "; ".join(
                    f"{item.hypId} ({item.resolution.reason if item.resolution else '?'})"
                    for item in deferred[:5]
                )
                raise AuditIncompleteError(
                    "orchestrator",
                    f"{len(deferred)} hypotheses could not be evaluated (and none confirmed): {details}",
                )
            report = _report(graph, flagged.fileSummaries, trace)
            log.write(
                "graph-verdict.json",
                {
                    "verdict": report.verdict,
                    "rationale": report.rationale,
                    "counts": report.counts.model_dump(mode="json"),
                    "confirmedHypIds": report.confirmedHypIds,
                },
            )
            log.write("report.json", report)
            await _emit_verdict(emitter, report)
            return AuditResult(report, resolved.path, resolved)
        except Exception:
            cleanup_package(resolved)
            raise
