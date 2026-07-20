"""The capture ledger: llm_runs (the workflow envelope) + llm_attempts
(one row per PHYSICAL call — billing, latency, and failures live here;
the logical step is the (run_id, step) grouping, not a table). Every
write is its own short transaction: a SIGKILL mid-run must leave a
readable record — a dead run you can't read is the worst outcome."""

import json
import uuid
from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso
from kit_spine.db import metadata

llm_runs = sa.Table(
    "llm_runs",
    metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("context_kind", sa.String(32), nullable=False),
    sa.Column("context_id", sa.String(64), nullable=False),
    sa.Column("role", sa.String(64), nullable=False),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("steps", sa.Integer, nullable=False),
    sa.Column("total_cost_usd", sa.Float, nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("finished_at", sa.String(64), nullable=True),
    sa.Index("ix_llm_runs_context", "context_kind", "context_id"),
)

llm_attempts = sa.Table(
    "llm_attempts",
    metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("run_id", sa.String(36), sa.ForeignKey("llm_runs.id"), nullable=False),
    sa.Column("step", sa.Integer, nullable=False),
    sa.Column("attempt", sa.Integer, nullable=False),
    sa.Column("model", sa.String(128), nullable=True),
    sa.Column("prompt_version", sa.Integer, nullable=True),
    sa.Column("prompt_hash", sa.String(12), nullable=True),
    sa.Column("messages", sa.JSON, nullable=False),
    sa.Column("tools", sa.JSON, nullable=True),
    sa.Column("output", sa.JSON, nullable=True),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("error", sa.String(1024), nullable=True),
    sa.Column("in_tokens", sa.Integer, nullable=True),
    sa.Column("out_tokens", sa.Integer, nullable=True),
    sa.Column("cached_tokens", sa.Integer, nullable=True),
    sa.Column("cost_usd", sa.Float, nullable=True),
    sa.Column("provider_call_id", sa.String(128), nullable=True),
    sa.Column("latency_ms", sa.Integer, nullable=False),
    sa.Column("request_id", sa.String(64), nullable=True),
    sa.Column("ts", sa.String(64), nullable=False),
    sa.Index("ix_llm_attempts_run_id", "run_id"),
    sa.Index("ix_llm_attempts_ts", "ts"),  # the spend window scans by time
)


@dataclass(frozen=True)
class AttemptWrite:
    run_id: str
    step: int
    attempt: int
    model: str | None
    prompt_version: int | None
    prompt_hash: str | None
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None
    output: Any
    status: str
    error: str | None
    in_tokens: int | None
    out_tokens: int | None
    cached_tokens: int | None
    cost_usd: float | None
    provider_call_id: str | None
    latency_ms: int
    request_id: str | None


class CaptureStore:
    def __init__(self, session_factory: async_sessionmaker) -> None:
        self._sessions = session_factory

    async def create_run(self, context_kind: str, context_id: str, role: str) -> str:
        run_id = str(uuid.uuid4())
        async with self._sessions() as session, session.begin():
            await session.execute(
                llm_runs.insert().values(
                    id=run_id,
                    context_kind=context_kind,
                    context_id=context_id,
                    role=role,
                    status="running",
                    steps=0,
                    total_cost_usd=None,
                    created_at=now_iso(),
                    finished_at=None,
                )
            )
        return run_id

    async def write_attempt(self, write: AttemptWrite) -> None:
        async with self._sessions() as session, session.begin():
            await session.execute(
                llm_attempts.insert().values(
                    id=str(uuid.uuid4()),
                    ts=now_iso(),
                    run_id=write.run_id,
                    step=write.step,
                    attempt=write.attempt,
                    model=write.model,
                    prompt_version=write.prompt_version,
                    prompt_hash=write.prompt_hash,
                    messages=write.messages,
                    tools=write.tools,
                    output=_jsonable(write.output),
                    status=write.status,
                    error=write.error[:1024] if write.error else None,
                    in_tokens=write.in_tokens,
                    out_tokens=write.out_tokens,
                    cached_tokens=write.cached_tokens,
                    cost_usd=write.cost_usd,
                    provider_call_id=write.provider_call_id,
                    latency_ms=write.latency_ms,
                    request_id=write.request_id,
                )
            )

    async def mark_invalid(self, run_id: str, step: int, attempt: int, error: str) -> None:
        """Restate an already-written attempt row as invalid_output: it was
        recorded 'ok' when the physical call returned, but parsing (part of
        the attempt's fate) then rejected its content. One UPDATE keeps all
        llm_attempts SQL in the store rather than the caller."""
        async with self._sessions() as session, session.begin():
            await session.execute(
                llm_attempts.update()
                .where(
                    llm_attempts.c.run_id == run_id,
                    llm_attempts.c.step == step,
                    llm_attempts.c.attempt == attempt,
                )
                .values(status="invalid_output", error=error[:1024])
            )

    async def finish_run(self, run_id: str, status: str, steps: int) -> None:
        """total_cost_usd = the sum of RESOLVED attempt costs; the
        deferred-cost resolver refreshes it after backfill."""
        async with self._sessions() as session, session.begin():
            total = await session.scalar(
                sa.select(sa.func.sum(llm_attempts.c.cost_usd)).where(
                    llm_attempts.c.run_id == run_id
                )
            )
            await session.execute(
                llm_runs.update()
                .where(llm_runs.c.id == run_id)
                .values(
                    status=status,
                    steps=steps,
                    total_cost_usd=total,
                    finished_at=now_iso(),
                )
            )


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (dict, list, str, int, float, bool)):
        return value
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return str(value)
