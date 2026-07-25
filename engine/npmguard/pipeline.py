from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kit_llm import LlmClient

from .audit_log import AuditLog
from .config import SOURCE_FILE_TYPES, Settings
from .contract.models import (
    AuditReport,
    FileRecord,
    FileSummary,
    FileVerdict,
    Hypothesis,
    HypothesisCounts,
    InventoryFlag,
    PhaseLog,
)
from .deps import provision_dependencies
from .errors import AuditIncompleteError, AuditTimeoutError, PackageTooLargeError
from .events import AuditEmitter
from .evidence import ArtifactStore
from .graph import HypothesisGraph, build_graph, derive_graph_verdict
from .hypothesis_agent import FallbackHypothesisGenerator, TwoPhaseHypothesisGenerator
from .inventory import INSTALL_COVERAGE_GAP, analyze_inventory
from .orchestrator import run_orchestrator
from .persistence import AuditSessionStore
from .phases import (
    HypothesisGenerator,
    KitHypothesisGenerator,
    extract_intent,
    flag_source_files,
    run_flag,
    run_hypothesize,
)
from .resolve import ResolvedPackage, cleanup_package, resolve_package

EMPTY_COUNTS = HypothesisCounts(total=0, open=0, inProgress=0, confirmed=0, refuted=0, deferred=0)
SEVERITY_SCORE = {"low": 3, "medium": 6, "high": 8, "critical": 10}
# Phase budgets in milliseconds. The last three are multiplied by `timeout_scale`,
# which grows with the FLAG file set (phases.flag_source_files) — named rather
# than inline so the scaling is testable at a boundary a test can move, instead of
# only after ten real minutes.
RESOLVE_TIMEOUT_MS = 240_000
INVENTORY_TIMEOUT_MS = 60_000
INTENT_TIMEOUT_MS = 120_000
FLAG_TIMEOUT_MS = 600_000
HYPOTHESIZE_TIMEOUT_MS = 1_200_000
ORCHESTRATOR_BUDGET_MS = 2_400_000


MAX_REPLAY_FILE_BYTES = 256 * 1024
MAX_REPLAY_TOTAL_BYTES = 4 * 1024 * 1024


def _replay_sources(root: Path, files: Sequence[FileRecord]) -> dict[str, str]:
    """The audited sources, kept so a replay can still serve them after
    `cleanup_package` deletes the extracted tarball.

    Driven by the inventory list, never a walk of `root`: dependencies are
    provisioned into `root/node_modules` first, so a walk would slurp the whole
    dependency tree. Over budget drops files rather than truncating one.
    """
    captured: dict[str, str] = {}
    budget = MAX_REPLAY_TOTAL_BYTES
    for record in files:
        if record.isBinary or record.sizeBytes > MAX_REPLAY_FILE_BYTES:
            continue
        target = root / record.path
        if not target.is_relative_to(root):
            continue
        try:
            text = target.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            continue
        cost = len(text.encode("utf-8"))
        if cost > budget:
            continue
        budget -= cost
        captured[record.path] = text
    return captured


@dataclass(frozen=True)
class AuditResult:
    report: AuditReport
    package_path: Path
    resolved: ResolvedPackage
    files: dict[str, str] = field(default_factory=dict)

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
    graph: HypothesisGraph,
    summaries: list[FileSummary],
    trace: list[PhaseLog],
    *,
    coverage_gaps: Sequence[InventoryFlag] = (),
) -> AuditReport:
    """Turn a resolved hypothesis graph into the report a consumer receives.

    INVARIANT: no report leaves this function while an install-time coverage gap is
    open and nothing was confirmed. This is the ONE function in the pipeline that
    derives a verdict from a graph — both SAFE-capable returns call it, the
    dealbreaker return builds its DANGEROUS report inline and never comes here — so
    the check cannot be bypassed by a return path added later, which a guard written
    at each call site would be. `coverage_gaps` is empty unless
    `NPMGUARD_REFUSE_INSTALL_COVERAGE_GAP` is on (the caller gates it, see `run`), and
    empty means exactly the behaviour that shipped before this existed.

    Why a refusal and not a flag: the verdict vocabulary is {SAFE, DANGEROUS}, so
    "we could not check what runs at install time" HAS no verdict. It is the same
    position a DEFERRED hypothesis is in (see the refusal in `run`), and it is
    refused the same way and with the same code — NPMGUARD-0031, retryable, no
    report written. Reporting it as a `critical` flag beside `verdict: "SAFE"` is
    what the engine did until now, and inventory flags reach only the PhaseLog and
    the audit log, never `inventory_meta` — so a package whose `postinstall` runs
    `node-gyp rebuild` shipped a green badge over unread install-time execution.

    Two orderings are load-bearing:

    - AFTER the dealbreaker early return, which is structural here rather than
      positional: that path never calls this function, so a free and correct
      DANGEROUS verdict can never be discarded over a gap.
    - SKIPPED when any hypothesis CONFIRMED, so a coverage gap can never suppress a
      true positive. Same rule 47b8c15 established for retrieval gaps: the gap is
      raised after the run, never instead of it. The price is that a package that
      will be refused still pays for intent + FLAG + hypothesize + the orchestrator
      — unavoidable, because "did anything confirm" is not knowable before then, and
      the cheap-refusal alternative (raise right after inventory) is exactly the
      trade that would throw away DANGEROUS-by-evidence.

    Measured blast radius when switched ON, over 834 installed packages on a dev
    machine (5 with an install-time hook, 132 with any lifecycle hook): 2 packages
    stop reaching SAFE — better-sqlite3 (`prebuild-install || node-gyp rebuild`) and
    msw (`node -e "import('./config/scripts/postinstall.js')"`). Both are genuinely
    unaudited install-time execution. 0.24% of manifests, 0 dealbreakers turned into
    refusals. That measurement is why the switch exists rather than the behaviour
    simply landing: it changes the conclusion for real, benign packages.
    """
    if coverage_gaps and not graph.filter_by_state("CONFIRMED"):
        details = "; ".join(gap.detail for gap in coverage_gaps[:5])
        plural = "" if len(coverage_gaps) == 1 else "s"
        raise AuditIncompleteError(
            "inventory",
            f"{len(coverage_gaps)} install-time coverage gap{plural} and no confirmed "
            f"hypothesis — this audit could not see what runs at install time, so it "
            f"has no verdict to give: {details}",
        )
    verdict = derive_graph_verdict(graph)
    return AuditReport(
        schemaVersion=2,
        verdict=verdict.verdict,
        rationale=verdict.rationale,
        counts=verdict.counts,
        confirmedHypIds=verdict.confirmed_hyp_ids,
        hypotheses=graph.all(),
        fileSummaries=summaries,
        dealbreaker=None,
        trace=trace,
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
            KitHypothesisGenerator(llm, settings), TwoPhaseHypothesisGenerator(llm, settings)
        )

    async def run(
        self,
        package_name: str,
        *,
        audit_id: str,
        version: str | None = None,
        emitter: AuditEmitter | None = None,
    ) -> AuditResult:
        # INVARIANT: run() RETURNS its report and never emits a terminal frame
        # (verdict_reached | audit_error). The service owns the terminal
        # transition — report durable on disk, then row running->terminal and
        # the terminal event in one transaction (AuditService._finish).
        log = AuditLog(package_name, audit_id)
        # Rooted at the run directory, which now names the audit_id — so a digest in
        # `report.hypotheses[].evidenceRefs[].hash` is joinable to the blob that
        # backs it without a side table (see AuditLog's INVARIANT).
        artifacts = ArtifactStore(log.run_dir)
        trace: list[PhaseLog] = []
        if emitter:
            await emitter.emit("audit_started", {"packageName": package_name})
        # The workdir has exactly one owner from the instant resolve_package
        # returns it: `acquired` is assigned inside the phase operation, so the
        # cleanup handler below covers every step after acquisition — including
        # the ones that used to sit OUTSIDE the try (the resolve PhaseLog write
        # and set_package_path, whose disk/DB errors left an extracted package in
        # /tmp/npmguard-* with no owner) and including the phase wrapper's own
        # phase_completed emit.
        acquired: ResolvedPackage | None = None

        async def acquire() -> ResolvedPackage:
            nonlocal acquired
            acquired = await resolve_package(package_name, version)
            return acquired

        try:
            resolved, phase = await _timed_phase(
                "resolve",
                acquire,
                RESOLVE_TIMEOUT_MS,
                {"packageName": package_name, "version": version},
                lambda value: {"path": str(value.path), "version": value.version},
                emitter,
            )
            trace.append(phase)
            log.write(
                "resolve.json",
                {
                    "path": str(resolved.path),
                    "workdir": str(resolved.workdir),
                    "version": resolved.version,
                },
            )
            await self.sessions.set_package_path(audit_id, str(resolved.path))
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
                INVENTORY_TIMEOUT_MS,
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
            # Here, so all three exits below return the same sources.
            replay_sources = await asyncio.to_thread(
                _replay_sources, resolved.path, inventory.files
            )
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

            # The budgets below are scaled over the files FLAG will actually read
            # — the same list run_flag fans out over, from the one function that
            # defines it (phases.flag_source_files). A local copy of the filter
            # used to omit the noise rule, so a test-heavy package was budgeted
            # for files nobody opens.
            sources = flag_source_files(inventory)
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
                return AuditResult(report, resolved.path, resolved, replay_sources)

            # "We could not check what runs at install time" (inventory.py:
            # `install-coverage-gap`, either kind — a hook whose code is nowhere in
            # the tarball, or a target that ships as a type no model reads). Read
            # HERE, below the dealbreaker return, so a package that is both is
            # DANGEROUS on the evidence rather than refused on the gap; carried to
            # `_report`, which owns the refusal and the CONFIRMED exception.
            #
            # The knob is read at this ONE place rather than at the two `_report`
            # call sites: an empty list is indistinguishable from "no gap", so OFF is
            # exactly the pre-change behaviour and a third report path added later
            # inherits the gate for free instead of needing to remember it. Ships OFF
            # — turning it on changes the conclusion for real published packages, and
            # that is an owner decision (see the field's ledger in config.py).
            coverage_gaps = (
                [flag for flag in inventory.flags if flag.check == INSTALL_COVERAGE_GAP]
                if self.settings.refuse_install_coverage_gap
                else []
            )

            # INVARIANT: past this line the audit is committed to at most
            # `max_source_files` FLAG model calls, because `sources` IS the list
            # run_flag fans out over one call at a time. It sits AFTER the
            # dealbreaker return — a free, correct DANGEROUS verdict is never
            # discarded over a size bound — and BEFORE `intent`, which is the
            # first model call of the audit, so the refusal costs exactly zero.
            #
            # Why a bound at all: FLAG's budget is FLAG_TIMEOUT_MS × timeout_scale
            # (600s × ≤4 = 2400s) at concurrency 8 with a 60s per-call timeout, so
            # between ~320 files (60s/call) and ~6400 (3s/call) fit — and which
            # end you land on is decided by provider latency, not by anything here.
            # Past that line the phase raises AuditTimeoutError and the audit
            # ERRORS having already paid for every call it made, with no report
            # written. The failure is not overspend; it is total loss of spend with
            # nothing delivered. This turns that into a cheap, honest refusal.
            if self.settings.max_source_files and len(sources) > self.settings.max_source_files:
                raise PackageTooLargeError(
                    package_name, len(sources), self.settings.max_source_files
                )

            intent, phase = await _timed_phase(
                "intent-extraction",
                lambda: extract_intent(resolved.path, inventory, self.llm, audit_id),
                INTENT_TIMEOUT_MS,
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
                FLAG_TIMEOUT_MS * timeout_scale,
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
                report = _report(
                    graph, flagged.fileSummaries, trace, coverage_gaps=coverage_gaps
                )
                log.write("report.json", report)
                return AuditResult(report, resolved.path, resolved, replay_sources)

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
                HYPOTHESIZE_TIMEOUT_MS * timeout_scale,
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
                global_budget_ms=ORCHESTRATOR_BUDGET_MS * timeout_scale,
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
            report = _report(graph, flagged.fileSummaries, trace, coverage_gaps=coverage_gaps)
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
            return AuditResult(report, resolved.path, resolved, replay_sources)
        except BaseException:
            # INVARIANT: this pipeline never leaves an extracted package behind.
            # `acquired is None` means resolve_package never returned, and it
            # removes its own workdir on internal failure. BaseException, not
            # Exception: a worker cancelled mid-audit (engine shutdown) is the
            # most likely way out of here, and CancelledError is not an Exception
            # — the success path's cleanup (AuditService._execute) does not run
            # for it either. rmtree is synchronous, so it completes even while the
            # cancellation is propagating.
            if acquired is not None:
                cleanup_package(acquired)
            raise
