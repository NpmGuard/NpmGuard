"""The capture ledger: llm_runs (the workflow envelope) + llm_attempts
(one row per PHYSICAL call — billing, latency, and failures live here;
the logical step is the (run_id, step) grouping, not a table). Every
write is its own short transaction: a SIGKILL mid-run must leave a
readable record — a dead run you can't read is the worst outcome."""

import math
import uuid
from collections.abc import Mapping
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
    # Provider/model identifiers have no portable vendor-wide length bound.
    # Text keeps an already-paid call capturable instead of letting PostgreSQL
    # reject a long routed identifier after the response arrived.
    sa.Column("model", sa.Text, nullable=True),
    sa.Column("prompt_version", sa.Integer, nullable=True),
    sa.Column("prompt_hash", sa.String(12), nullable=True),
    sa.Column("messages", sa.JSON, nullable=False),
    sa.Column("tools", sa.JSON, nullable=True),
    sa.Column("output", sa.JSON, nullable=True),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("error", sa.String(1024), nullable=True),
    # Usage is provider-owned. BigInteger covers the shared JS-safe public
    # contract without PostgreSQL's much smaller INTEGER ceiling.
    sa.Column("in_tokens", sa.BigInteger, nullable=True),
    sa.Column("out_tokens", sa.BigInteger, nullable=True),
    sa.Column("cached_tokens", sa.BigInteger, nullable=True),
    sa.Column("cost_usd", sa.Float, nullable=True),
    sa.Column("provider_call_id", sa.Text, nullable=True),
    # counts futile resolve_costs lookups; rows reach a terminal state at
    # COST_LOOKUP_MAX_ATTEMPTS instead of being re-swept forever when a
    # provider never reveals a deferred cost (spend.py)
    sa.Column("cost_lookup_attempts", sa.Integer, nullable=False, server_default="0"),
    sa.Column("actual_model", sa.Text, nullable=True),
    sa.Column("provider", sa.Text, nullable=True),
    sa.Column("finish_reason", sa.Text, nullable=True),
    # requested output transport ("text" | "json_object" | "strict_schema");
    # whether the route honored it is a response observation, not implied here.
    # Nullable only for rows that predate migration 0002 — new writes set it.
    sa.Column("transport", sa.Text, nullable=True),
    sa.Column("latency_ms", sa.Integer, nullable=False),
    sa.Column("request_id", sa.Text, nullable=True),
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
    actual_model: str | None
    provider: str | None
    finish_reason: str | None
    transport: str | None
    latency_ms: int
    request_id: str | None


class CaptureStore:
    def __init__(self, session_factory: async_sessionmaker) -> None:
        self._sessions = session_factory

    async def create_run(self, context_kind: str, context_id: str, role: str) -> str:
        _validate_run_identity(context_kind, context_id, role)
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
                    messages=_jsonable(write.messages),
                    tools=_jsonable(write.tools),
                    output=_jsonable(write.output),
                    status=write.status,
                    error=write.error[:1024] if write.error else None,
                    in_tokens=write.in_tokens,
                    out_tokens=write.out_tokens,
                    cached_tokens=write.cached_tokens,
                    cost_usd=write.cost_usd,
                    provider_call_id=write.provider_call_id,
                    actual_model=write.actual_model,
                    provider=write.provider,
                    finish_reason=write.finish_reason,
                    transport=write.transport,
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


def _jsonable(value: Any, ancestors: set[int] | None = None) -> Any:
    """Recursively normalize diagnostic provider output for a JSON column.

    Provider SDKs occasionally leave typed objects inside otherwise ordinary
    reasoning/metadata dictionaries. Returning the outer dictionary unchanged
    defers the failure to SQL serialization and loses the completed paid call.
    Preserve the JSON-shaped structure while stringifying only unsupported
    leaves; cycles and hostile ``__str__`` implementations also stay capturable.
    Valid string keys remain exact. Unsupported non-string keys get a typed
    diagnostic label, with a suffix on collisions, because JSON cannot retain
    their original identity.
    """
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)

    ancestors = set() if ancestors is None else ancestors
    marker = id(value)
    if isinstance(value, Mapping):
        if marker in ancestors:
            return "<recursive reference>"
        ancestors.add(marker)
        try:
            normalized: dict[str, Any] = {}
            for key, item in value.items():
                base = _json_key(key)
                normalized_key = base
                suffix = 2
                while normalized_key in normalized:
                    normalized_key = f"{base}#duplicate-{suffix}"
                    suffix += 1
                normalized[normalized_key] = _jsonable(item, ancestors)
            return normalized
        except Exception:
            return _safe_string(value)
        finally:
            ancestors.remove(marker)
    if isinstance(value, (list, tuple)):
        if marker in ancestors:
            return "<recursive reference>"
        ancestors.add(marker)
        try:
            return [_jsonable(item, ancestors) for item in value]
        except Exception:
            return _safe_string(value)
        finally:
            ancestors.remove(marker)
    return _safe_string(value)


def _safe_string(value: Any) -> str:
    try:
        return str(value)
    except Exception:
        value_type = type(value)
        return f"<unserializable {value_type.__module__}.{value_type.__qualname__}>"


def _json_key(value: Any) -> str:
    if isinstance(value, str):
        return value
    value_type = type(value)
    return f"<{value_type.__module__}.{value_type.__qualname__}:{_safe_string(value)}>"


def _validate_run_identity(context_kind: Any, context_id: Any, role: Any) -> None:
    """Enforce the public RunRecord/storage boundary before any provider call."""
    if not isinstance(context_kind, str) or not context_kind.strip() or len(context_kind) > 32:
        raise ValueError("context kind must be a non-empty string of at most 32 characters")
    if not isinstance(context_id, str) or len(context_id) > 64:
        raise ValueError("context id must be a string of at most 64 characters")
    if not isinstance(role, str) or not role.strip() or len(role) > 64:
        raise ValueError("role must be a non-empty string of at most 64 characters")
