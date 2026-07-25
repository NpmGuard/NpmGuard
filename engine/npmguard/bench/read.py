"""Assembling a stored run into the wire + its derived metrics.

This is the module that closes G24: everything below is reached from stored
``audit_id``s and the committed manifest. The verdict, the confirmation count, the
dealbreaker, the latency and the token spend are all read from
``audit_sessions.report`` (keyed by ``audit_id``) and the LLM ledger — never from
``data/reports/<pkg>/<version>.json``, which holds one slot per ``(name, version)``
and would collapse an N-repeat entry's N reports into whichever ran last.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..contract import models as contract
from ..panel.audit_set import Rollup, RollupItem, compute_rollup, set_wire
from ..panel.verdict_index import item_outcome
from .corpus import Corpus, Entry, load_corpora
from .projector import RunMetrics, project
from .store import Attempt, AuditObservation, BenchRunStore, RunDescriptor


class BenchCorpusDrift(Exception):
    """The corpus file changed under a fixed ``datasetVersion``.

    Raised rather than tolerated: ``manifestSha`` exists so that "a corpus whose
    content changed under a fixed (name, version) is caught rather than silently
    compared" (`shared/src/bench.ts:44-46`). Rendering the run against today's
    entries would be a comparison between two different corpora reported as one.
    """


class BenchRunNotFound(Exception):
    pass


def _duration_ms(report: dict[str, Any] | None) -> int | None:
    """Per-audit wall clock, summed over the report's own phase trace.

    The six phase names in ``trace`` are exactly the engine's timeout vocabulary,
    so this is directly comparable against the configured envelope (§7.2). It is
    ``None`` for an audit that produced no report: the alternative,
    ``updated_at - created_at``, silently includes queue wait, and one field
    meaning two things is how a latency percentile becomes uninterpretable. A
    failed audit therefore has no observed duration rather than a wrong one.
    """
    if not report:
        return None
    trace = report.get("trace") or []
    if not trace:
        return None
    return round(sum(float(phase.get("durationMs") or 0) for phase in trace))


def _item(
    run_id: int,
    entry: Entry,
    attempt: Attempt,
    observation: AuditObservation | None,
) -> contract.BenchRunItem:
    """One observation, projected to the wire. OBSERVATIONS ONLY."""
    report = observation.report if observation else None
    dealbreaker = (report or {}).get("dealbreaker") or None
    return contract.BenchRunItem(
        runId=run_id,
        entryId=entry.id,
        runIndex=attempt.run_index,
        auditId=attempt.audit_id,
        verdict=(report or {}).get("verdict"),
        durationMs=_duration_ms(report),
        error=(observation.error if observation else None) or attempt.error,
        confirmedCount=int(((report or {}).get("counts") or {}).get("confirmed") or 0),
        dealbreaker=dealbreaker.get("check") if dealbreaker else None,
        tokensPrompt=observation.tokens_prompt if observation else None,
        tokensCompletion=observation.tokens_completion if observation else None,
    )


def _entry_rollup_item(items: list[contract.BenchRunItem], statuses: list[str | None]) -> RollupItem:
    """One corpus ENTRY as the set's rollup sees it.

    ``BenchRunSchema.set`` counts audited ``(name, version)`` pairs while there are
    ``runsPerEntry`` observations per entry — the contract says so explicitly and
    warns that ``rows[].items.length`` does not sum to ``set.rollup.total``. So the
    set's rollup is a PROGRESS identity over entries, and no rate may be read off
    it; every rate comes from the projector at ``n = entries``.

    ``pending`` is "an attempt for this entry is still live", which for a bench run
    means an ``audit_sessions`` row that has not reached a terminal status — the
    bench lane's equivalent of the panel's live-job check.
    """
    pending = any(status in {"queued", "running"} for status in statuses) or not items
    verdict = next((item.verdict for item in items if item.verdict == "DANGEROUS"), None) or next(
        (item.verdict for item in items if item.verdict), None
    )
    return RollupItem(outcome=item_outcome(verdict, pending=pending), cached=False)


@dataclass(frozen=True)
class LoadedRun:
    run_id: int
    descriptor: RunDescriptor
    corpus: Corpus
    rows: tuple[tuple[Entry, list[contract.BenchRunItem]], ...]
    metrics: RunMetrics
    models: tuple[tuple[str, str], ...]
    rollup: Rollup
    set_row: Any

    @property
    def model_id(self) -> str:
        """The OBSERVED reproducibility identifier (B-11).

        ``BenchRunSchema.modelId`` is a single non-nullable string, which cannot
        describe a run that splits roles across two configured models and carries a
        fallback tail per role. Until the contract gains an observed
        ``models: {role, model}[]`` (reported), this renders the observed set as a
        stable label — and the EMPTY string when no LLM attempt was recorded at
        all, which is the honest reading of "this run has no observed model and
        therefore cannot be compared to another". It is never filled from
        configuration: a declared model that a fallback overrode is exactly the
        comparability failure this field is supposed to expose.
        """
        return "|".join(f"{role}={model}" for role, model in self.models)

    def as_run_wire(self) -> contract.BenchRun:
        return contract.BenchRun(
            id=self.run_id,
            corpusId=self.corpus.id,
            engineSha=self.descriptor.engine_sha,
            modelId=self.model_id,
            sandboxImageDigest=self.descriptor.sandbox_image_digest,
            runsPerEntry=self.descriptor.runs_per_entry,
            set=set_wire(self.set_row, self.rollup),
            tokenCostUsd=self.metrics.token_cost_usd,
        )

    def as_row_wires(self) -> list[contract.BenchRunRow]:
        return [
            contract.BenchRunRow(entry=entry.as_wire(), items=items) for entry, items in self.rows
        ]


async def load_run(
    store: BenchRunStore, run_id: int, *, dataset_dir: Path | None = None
) -> LoadedRun:
    set_rows = await store.run_rows([run_id])
    if not set_rows:
        raise BenchRunNotFound(f"no bench run {run_id}")
    loaded = await store.load(run_id)
    if loaded is None:
        raise BenchRunNotFound(f"bench run {run_id} has no descriptor frame")
    descriptor, attempts = loaded

    corpus = next(
        (
            c
            for c in load_corpora(dataset_dir)
            if c.dataset_version == descriptor.dataset_version
        ),
        None,
    )
    if corpus is None:
        raise BenchCorpusDrift(
            f"run {run_id} pinned datasetVersion {descriptor.dataset_version!r}, "
            "whose manifest is no longer on disk"
        )
    if corpus.manifest_sha != descriptor.manifest_sha:
        raise BenchCorpusDrift(
            f"run {run_id} pinned manifestSha {descriptor.manifest_sha[:12]} but "
            f"{corpus.path.name} now hashes to {corpus.manifest_sha[:12]}. The corpus "
            "changed under a fixed datasetVersion; comparing them would report two "
            "corpora as one. Re-cut it as a new datasetVersion instead."
        )

    observations = await store.observe([a.audit_id for a in attempts if a.audit_id])
    models = await store.observed_models([a.audit_id for a in attempts if a.audit_id])

    rows: list[tuple[Entry, list[contract.BenchRunItem]]] = []
    rollup_items: list[RollupItem] = []
    codes: dict[tuple[str, int], str] = {}
    costs: list[float | None] = []
    for entry in corpus.entries:
        mine = sorted(
            (a for a in attempts if a.fixture_name == entry.fixture_name),
            key=lambda a: a.run_index,
        )
        items: list[contract.BenchRunItem] = []
        statuses: list[str | None] = []
        for attempt in mine:
            observation = observations.get(attempt.audit_id or "")
            items.append(_item(run_id, entry, attempt, observation))
            statuses.append(observation.status if observation else None)
            code = (observation.code if observation else None) or attempt.code
            if code:
                codes[(entry.fixture_name, attempt.run_index)] = code
            costs.append(observation.cost_usd if observation else None)
        rows.append((entry, items))
        rollup_items.append(_entry_rollup_item(items, statuses))

    return LoadedRun(
        run_id=run_id,
        descriptor=descriptor,
        corpus=corpus,
        rows=tuple(rows),
        metrics=project(descriptor.engine_sha, rows, codes=codes, costs=costs),
        models=tuple(models),
        rollup=compute_rollup(rollup_items),
        set_row=set_rows[0],
    )


async def load_runs(
    store: BenchRunStore, *, dataset_dir: Path | None = None
) -> list[LoadedRun]:
    """Every bench run, newest first. A run whose corpus drifted is SKIPPED from
    the list rather than rendered against the wrong entries — and the detail route
    still raises for it, so the failure is discoverable instead of silent."""
    runs: list[LoadedRun] = []
    for row in await store.run_rows():
        try:
            runs.append(await load_run(store, int(row["id"]), dataset_dir=dataset_dir))
        except (BenchCorpusDrift, BenchRunNotFound):
            continue
    return runs


__all__ = ["BenchCorpusDrift", "BenchRunNotFound", "LoadedRun", "load_run", "load_runs"]
