"""Where a bench run's two irreducible facts live — and why they need no table.

A bench run is an **audit set** whose ``origin`` is ``bench_run`` (R-1). Identity,
trigger, timing and the ``running -> done`` bit are the set's, so this module
stores exactly the two things the set cannot hold, and nothing else:

1. **the run's pinned descriptors** — ``datasetVersion``, ``manifestSha``,
   ``engineSha``, ``sandboxImageDigest`` (F-G5). Not derivable: a *historical*
   run's engine sha and image id are facts about a moment, and ``manifestSha`` is
   the whole point of pinning (a corpus edited under a fixed identity must be
   CAUGHT, which a hash recomputed at read time cannot do).
2. **the ``(entry, runIndex) → auditId`` mapping.** ``audit_set_items`` is keyed
   ``(set_id, name, version)`` — ONE row per pair, with no ``audit_id`` and no
   repeat index — so it structurally cannot hold N observations of one entry. This
   is the only genuinely new state in the domain.

Everything else is DERIVED: ``verdict``, ``confirmedCount``, ``dealbreaker`` and
``durationMs`` come from ``audit_sessions.report``; the failure CODE from the
durable ``audit_error`` frame; tokens and dollars from the LLM ledger; the corpus
and every expectation from the committed manifest; every rate from the projector.

**Both facts are appended to the durable log** (``stream_events``, channel
``bench_run_<set_id>``) rather than to a new table. Three reasons, in order:

- F-G2 says a run item records *observations only*, append-only, never a
  judgement. A durable append-only log is literally that shape, and the log
  cannot express an UPDATE — so the rule is enforced by the storage, not by
  review.
- R-4: "event fan-out is already right — copy it." The primitive exists, is
  transactional, allocates its own sequence, and is already the substrate for the
  audit and set streams.
- It needs **no migration**, so it cannot break the migration-vs-metadata parity
  check (`tests/test_panel_migration.py` C11) that a new table on the shared
  metadata would break while `alembic/**` is owned elsewhere. A table declared on
  a private ``MetaData`` would be worse than either: invisible to autogenerate,
  it would be emitted as a ``drop_table`` by the next author who runs it.

The cost, stated so it can be traded later: ``stream_events`` has a ``prune`` and
no index on frame payloads. The retention exemption bench runs need is therefore
the same one methodology §8.2 already demands for ``audit_sessions``, extended by
one table, and the "which run owns this audit" lookup is a channel scan — fine at
280 frames per run. The two-table upgrade is written out in this agent's handoff
for the moment either bound bites.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm.capture import llm_attempts, llm_runs
from kit_spine import now_iso
from kit_stream import StreamService
from kit_stream.models import stream_events

from ..events import audit_channel
from ..panel.audit_set import ORIGIN_BENCH_RUN
from ..panel.tables import audit_sets
from ..persistence import audit_sessions

FRAME_DESCRIPTOR = "descriptor"
FRAME_OBSERVATION = "observation"

# kit_stream reads in bounded batches; a 125-entry × N=2 run is 251 frames, so the
# page size is generous — but the loop below still pages, because a corpus that
# outgrows one batch must not silently truncate a run's history.
_PAGE = 500


def run_channel(run_id: int) -> str:
    """The durable-log channel holding one run's record.

    Deliberately NOT the set's own ``audit_set_<id>`` channel: that one carries the
    contract's ``ScanProgressFrame``/``ScanDepFrame`` union, and appending a frame
    type outside it would make the panel's SSE reader emit payloads no client can
    parse. Must satisfy kit_spine's channel pattern (``^[a-z_][a-z0-9_]{0,62}$``).
    """
    return f"bench_run_{run_id}"


@dataclass(frozen=True, slots=True)
class RunDescriptor:
    """F-G5's four identifiers plus the replication factor."""

    dataset_version: str
    manifest_sha: str
    engine_sha: str
    sandbox_image_digest: str
    runs_per_entry: int

    def as_frame(self) -> dict[str, Any]:
        return {
            "datasetVersion": self.dataset_version,
            "manifestSha": self.manifest_sha,
            "engineSha": self.engine_sha,
            "sandboxImageDigest": self.sandbox_image_digest,
            "runsPerEntry": self.runs_per_entry,
        }

    @classmethod
    def from_frame(cls, data: dict[str, Any]) -> RunDescriptor:
        return cls(
            dataset_version=data["datasetVersion"],
            manifest_sha=data["manifestSha"],
            engine_sha=data["engineSha"],
            sandbox_image_digest=data["sandboxImageDigest"],
            runs_per_entry=int(data["runsPerEntry"]),
        )


@dataclass(frozen=True, slots=True)
class Attempt:
    """One recorded attempt. ``audit_id is None`` ⟹ the attempt never reached an
    audit, and ``error`` says why (`shared/src/bench.ts:117-118`)."""

    fixture_name: str
    run_index: int
    audit_id: str | None
    error: str | None
    code: str | None


@dataclass(frozen=True, slots=True)
class AuditObservation:
    """Everything observed about one audit, read back by ``audit_id`` alone.

    G24's discriminating property lives here: ``report`` is
    ``audit_sessions.report`` keyed by ``audit_id`` — NEVER
    ``data/reports/<pkg>/<version>.json``, which keeps only the LAST audit of a
    pair and would silently collapse an N-repeat entry's N reports into one while
    appearing to work.
    """

    audit_id: str
    status: str
    report: dict[str, Any] | None
    error: str | None
    code: str | None
    tokens_prompt: int | None
    tokens_completion: int | None
    cost_usd: float | None


@dataclass
class BenchRunStore:
    sessions: async_sessionmaker
    stream: StreamService

    # -- writes ------------------------------------------------------------

    async def create(self, descriptor: RunDescriptor, corpus_id: int) -> int:
        """Open a run: one ``audit_sets`` row + the descriptor frame.

        No ``audit_set_items`` rows are written, and that is a decision rather
        than an omission. The panel's progress machinery reaches every live set by
        ``audit_set_items`` (``refresh_touching``) and recomputes it from
        ``panel_jobs`` liveness, which a bench audit — submitted through the audit
        core's own admission path, not the panel lane — never has. Items would
        therefore make a concurrent panel settle finalize a running bench set. The
        bench origin owns its own item source instead, lifting observations
        through ``RollupItem`` — the exact seam ``compute_rollup`` was built with
        ("every origin lifts its own rows … which keeps the rollup pure").
        """
        async with self.sessions() as session, session.begin():
            result = await session.execute(
                audit_sets.insert().values(
                    origin=ORIGIN_BENCH_RUN,
                    origin_ref=corpus_id,
                    billed_to=None,  # nobody is billed for a bench run
                    trigger_kind="manual",
                    commit_sha=None,
                    check_run_id=None,
                    started_at=now_iso(),
                )
            )
            run_id = int(result.inserted_primary_key[0])
            await self.stream.append(
                run_channel(run_id), FRAME_DESCRIPTOR, descriptor.as_frame(), session=session
            )
        return run_id

    async def record(self, run_id: int, attempt: Attempt) -> None:
        """Append one attempt. Observations only — no verdict, no outcome."""
        await self.stream.append(
            run_channel(run_id),
            FRAME_OBSERVATION,
            {
                "fixtureName": attempt.fixture_name,
                "runIndex": attempt.run_index,
                "auditId": attempt.audit_id,
                "error": attempt.error,
                "code": attempt.code,
            },
        )

    async def finish(self, run_id: int) -> None:
        """Close the run. ``finished_at`` is the ONE liveness fact for every
        origin (there is no stored ``status``), so this is the whole transition."""
        async with self.sessions() as session, session.begin():
            await session.execute(
                audit_sets.update()
                .where(audit_sets.c.id == run_id, audit_sets.c.finished_at.is_(None))
                .values(finished_at=now_iso())
            )

    # -- reads -------------------------------------------------------------

    async def _frames(self, run_id: int) -> list[dict[str, Any]]:
        channel, cursor, frames = run_channel(run_id), -1, []
        while True:
            page = await self.stream.read_after(channel, cursor, limit=_PAGE)
            if not page:
                return frames
            frames.extend(page)
            cursor = page[-1]["seq"]

    async def load(self, run_id: int) -> tuple[RunDescriptor, list[Attempt]] | None:
        frames = await self._frames(run_id)
        descriptor: RunDescriptor | None = None
        attempts: list[Attempt] = []
        for frame in frames:
            data = frame.get("data") or {}
            if frame["type"] == FRAME_DESCRIPTOR:
                descriptor = RunDescriptor.from_frame(data)
            elif frame["type"] == FRAME_OBSERVATION:
                attempts.append(
                    Attempt(
                        fixture_name=data["fixtureName"],
                        run_index=int(data["runIndex"]),
                        audit_id=data["auditId"],
                        error=data["error"],
                        code=data.get("code"),
                    )
                )
        if descriptor is None:
            return None
        # INVARIANT: an attempt is recorded at most once per (entry, runIndex). The
        # log has no UPDATE, so a duplicate would double-count one observation into
        # a rate. Load-bearing and checked here because the log cannot express a
        # unique constraint — this is the check a primary key would have been.
        keys = [(a.fixture_name, a.run_index) for a in attempts]
        assert len(set(keys)) == len(keys), (
            f"bench run {run_id}: duplicate (entry, runIndex) observations — "
            f"{sorted(k for k in keys if keys.count(k) > 1)}"
        )
        return descriptor, attempts

    async def run_rows(self, run_ids: Sequence[int] | None = None) -> list[sa.RowMapping]:
        """The ``audit_sets`` rows for bench runs, newest first."""
        query = (
            sa.select(audit_sets)
            .where(audit_sets.c.origin == ORIGIN_BENCH_RUN)
            .order_by(audit_sets.c.started_at.desc(), audit_sets.c.id.desc())
        )
        if run_ids is not None:
            query = query.where(audit_sets.c.id.in_(run_ids))
        async with self.sessions() as session:
            return list((await session.execute(query)).mappings().all())

    async def observe(self, audit_ids: Sequence[str]) -> dict[str, AuditObservation]:
        """Read every observation for a list of ``audit_id``s. THE G24 path."""
        if not audit_ids:
            return {}
        async with self.sessions() as session:
            sessions_rows = (
                (
                    await session.execute(
                        sa.select(
                            audit_sessions.c.audit_id,
                            audit_sessions.c.status,
                            audit_sessions.c.report,
                            audit_sessions.c.error,
                        ).where(audit_sessions.c.audit_id.in_(audit_ids))
                    )
                )
                .mappings()
                .all()
            )
            codes = await self._error_codes(session, audit_ids)
            spend = await self._spend(session, audit_ids)
        return {
            row["audit_id"]: AuditObservation(
                audit_id=row["audit_id"],
                status=row["status"],
                report=row["report"],
                error=row["error"],
                code=codes.get(row["audit_id"]),
                tokens_prompt=spend.get(row["audit_id"], (None, None, None))[0],
                tokens_completion=spend.get(row["audit_id"], (None, None, None))[1],
                cost_usd=spend.get(row["audit_id"], (None, None, None))[2],
            )
            for row in sessions_rows
        }

    async def _error_codes(self, session: Any, audit_ids: Sequence[str]) -> dict[str, str]:
        """``audit_id → NpmGuardError code``, from the durable terminal frame.

        ``audit_sessions.error`` stores ``str(exc)`` — the MESSAGE, not the code
        (`service.py:330-338`). The code is durable too, but in the audit's own
        event log, committed in the SAME transaction as the row's terminal
        transition, so it is reachable from ``audit_id`` alone and is exactly as
        durable as the row. Reading it there is what lets §4.5 key ABSTAINED vs
        VOID on a STABLE code instead of pattern-matching prose the way v1 did.
        """
        channels = {audit_channel(audit_id): audit_id for audit_id in audit_ids}
        rows = (
            (
                await session.execute(
                    sa.select(stream_events.c.channel, stream_events.c.data).where(
                        stream_events.c.channel.in_(list(channels)),
                        stream_events.c.type == "audit_error",
                    )
                )
            )
            .mappings()
            .all()
        )
        codes: dict[str, str] = {}
        for row in rows:
            code = (row["data"] or {}).get("code")
            if isinstance(code, str):
                codes[channels[row["channel"]]] = code
        return codes

    async def _spend(
        self, session: Any, audit_ids: Sequence[str]
    ) -> dict[str, tuple[int | None, int | None, float | None]]:
        """Tokens and dollars per audit from the LLM ledger.

        ``llm_runs`` is keyed ``(context_kind, context_id)`` and every engine call
        site passes ``context=("audit", audit_id)``, so this is a join, not a
        heuristic. Cost is ``None`` unless EVERY attempt reports one: a partial sum
        is an undercount wearing a total's clothing, and the contract's rule is
        null-while-unknown, never 0 as a stand-in.
        """
        rows = (
            (
                await session.execute(
                    sa.select(
                        llm_runs.c.context_id,
                        llm_attempts.c.in_tokens,
                        llm_attempts.c.out_tokens,
                        llm_attempts.c.cost_usd,
                    )
                    .select_from(llm_runs.join(llm_attempts, llm_attempts.c.run_id == llm_runs.c.id))
                    .where(
                        llm_runs.c.context_kind == "audit",
                        llm_runs.c.context_id.in_(audit_ids),
                    )
                )
            )
            .mappings()
            .all()
        )
        spend: dict[str, tuple[int | None, int | None, float | None]] = {}
        for row in rows:
            prompt, completion, cost = spend.get(row["context_id"], (0, 0, 0.0))
            spend[row["context_id"]] = (
                None if prompt is None or row["in_tokens"] is None else prompt + row["in_tokens"],
                None
                if completion is None or row["out_tokens"] is None
                else completion + row["out_tokens"],
                None if cost is None or row["cost_usd"] is None else cost + row["cost_usd"],
            )
        return spend

    async def observed_models(self, audit_ids: Sequence[str]) -> list[tuple[str, str]]:
        """The ``(role, actual_model)`` pairs a run ACTUALLY used (B-11).

        A single ``modelId`` cannot describe a run: roles split across two
        configured models and each carries a cross-provider fallback tail, so the
        reproducibility identifier has to be OBSERVED rather than declared. The
        data already exists as ``llm_attempts.actual_model``; this is the read.
        """
        if not audit_ids:
            return []
        async with self.sessions() as session:
            rows = (
                (
                    await session.execute(
                        sa.select(llm_runs.c.role, llm_attempts.c.actual_model)
                        .select_from(
                            llm_runs.join(llm_attempts, llm_attempts.c.run_id == llm_runs.c.id)
                        )
                        .where(
                            llm_runs.c.context_kind == "audit",
                            llm_runs.c.context_id.in_(audit_ids),
                            llm_attempts.c.actual_model.is_not(None),
                        )
                        .distinct()
                    )
                )
                .mappings()
                .all()
            )
        return sorted({(row["role"], row["actual_model"]) for row in rows})


__all__ = [
    "FRAME_DESCRIPTOR",
    "FRAME_OBSERVATION",
    "Attempt",
    "AuditObservation",
    "BenchRunStore",
    "RunDescriptor",
    "run_channel",
]
