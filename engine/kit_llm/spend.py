"""Spend: the attempt table IS the ledger — no second bookkeeping. The
gate reads a trailing 24h window; unresolved costs (cost_usd NULL) with
reported usage are counted at their static ModelSpec price or the settings'
deliberately expensive fallback rate. A failed call with no usage cannot yet
be estimated.
resolve_costs() is the deferred pipeline stage: providers that only
reveal the real price after the fact get backfilled by provider_call_id."""

from datetime import UTC, datetime, timedelta
import math
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm._contract import TOKEN_COUNT_MAX
from kit_llm.capture import llm_attempts, llm_runs
from kit_llm.config import LlmSettings, ModelSpec
from kit_llm.errors import BudgetExhausted
from kit_llm.provider import ProviderPort, ProviderResultError

# After this many futile lookups an unresolved row is TERMINAL: the sweep
# stops re-fetching it. Without a bound, an adapter that never reveals
# deferred cost (lookup_cost always None) turns every sweep into the same
# dead lookups while its backlog grows.
COST_LOOKUP_MAX_ATTEMPTS = 8


def _window_start(hours: int = 24) -> str:
    return (
        (datetime.now(UTC) - timedelta(hours=hours))
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def estimate_cost(
    spec: ModelSpec | None,
    settings: LlmSettings,
    in_tokens: int | None,
    out_tokens: int | None,
    cached_tokens: int | None,
) -> float:
    """Static pricing: ModelSpec prices when set, else the conservative
    fallback. Cached input bills at 0.1× the input rate."""
    in_count = _validated_token_count(in_tokens, field="in_tokens")
    out_count = _validated_token_count(out_tokens, field="out_tokens")
    cached_count = _validated_token_count(cached_tokens, field="cached_tokens")
    price_in, price_out = (
        spec.prices
        if spec and spec.prices
        else (
            settings.llm_fallback_price_in_per_mtok,
            settings.llm_fallback_price_out_per_mtok,
        )
    )
    fresh = max(in_count - cached_count, 0)
    try:
        estimate = (
            fresh * price_in / 1e6
            + cached_count * price_in * 0.1 / 1e6
            + out_count * price_out / 1e6
        )
    except OverflowError as error:
        raise ValueError("estimated cost must be finite and non-negative") from error
    if not math.isfinite(estimate) or estimate < 0:
        raise ValueError("estimated cost must be finite and non-negative")
    return estimate


def _validated_token_count(value: int | None, *, field: str) -> int:
    if value is None:
        return 0
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > TOKEN_COUNT_MAX
    ):
        raise ValueError(f"{field} tokens must be a non-negative JS-safe integer or None")
    return value


def _validated_nonnegative_number(value: Any, *, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a finite non-negative number")
    try:
        normalized = float(value)
    except OverflowError as error:
        raise ValueError(f"{field} must be a finite non-negative number") from error
    if not math.isfinite(normalized) or normalized < 0:
        raise ValueError(f"{field} must be a finite non-negative number")
    return normalized


def _validated_deferred_cost(value: Any) -> float:
    try:
        return _validated_nonnegative_number(value, field="deferred cost")
    except ValueError as error:
        raise ProviderResultError(str(error)) from error


class SpendTracker:
    def __init__(
        self,
        session_factory: async_sessionmaker,
        settings: LlmSettings,
        specs: dict[str, ModelSpec],
    ) -> None:
        self._sessions = session_factory
        self._settings = settings
        self._specs = specs

    async def spent_24h(self) -> float:
        """Resolved costs summed in SQL; unresolved usage aggregated in SQL
        per model and priced in Python. The aggregation matters: this runs
        on the guard path of EVERY run, and a deployment whose adapter never
        reveals native cost accumulates unresolved rows — an O(rows) fetch
        here would tax every call."""
        since = _window_start()
        in_ = sa.func.coalesce(llm_attempts.c.in_tokens, 0)
        cached_ = sa.func.coalesce(llm_attempts.c.cached_tokens, 0)
        out_ = sa.func.coalesce(llm_attempts.c.out_tokens, 0)
        # per-row clamp, kept in SQL so the group sum equals the row-wise sum
        fresh_ = sa.case((in_ - cached_ > 0, in_ - cached_), else_=0)
        async with self._sessions() as session:
            resolved = await session.scalar(
                sa.select(sa.func.coalesce(sa.func.sum(llm_attempts.c.cost_usd), 0.0)).where(
                    llm_attempts.c.ts >= since,
                    llm_attempts.c.cost_usd.is_not(None),
                )
            )
            unresolved = (
                await session.execute(
                    sa.select(
                        llm_attempts.c.model,
                        sa.func.sum(fresh_).label("fresh"),
                        sa.func.sum(cached_).label("cached"),
                        sa.func.sum(out_).label("out"),
                    )
                    .where(
                        llm_attempts.c.ts >= since,
                        llm_attempts.c.cost_usd.is_(None),
                    )
                    .group_by(llm_attempts.c.model)
                )
            ).all()
        estimated = sum(
            # in = fresh + cached reconstructs the row-wise arithmetic exactly.
            # int(): Postgres returns SUM(bigint) as NUMERIC -> Decimal;
            # SQLite returns int — normalize before the token validation
            estimate_cost(
                self._specs.get(row.model) if row.model else None,
                self._settings,
                int(row.fresh) + int(row.cached),
                int(row.out),
                int(row.cached),
            )
            for row in unresolved
        )
        total = _validated_nonnegative_number(resolved, field="resolved spend") + estimated
        return _validated_nonnegative_number(total, field="24h spend")

    async def guard(self, estimate_usd: float = 0.0) -> None:
        """Raises BudgetExhausted when the window plus the estimate would
        cross the budget minus its safety margin. Budget 0 = gate off."""
        estimate = _validated_nonnegative_number(estimate_usd, field="estimate_usd")
        budget = self._settings.llm_budget_usd_24h
        if budget <= 0:
            return
        headroom = budget * (1 - self._settings.llm_budget_margin)
        if await self.spent_24h() + estimate > headroom:
            raise BudgetExhausted(
                f"llm budget: spent+estimate exceeds {headroom:.2f} USD headroom "
                f"(budget {budget:.2f}/24h)"
            )

    async def resolve_costs(self, provider: ProviderPort, limit: int = 500) -> int:
        """Backfill attempts whose provider reveals cost after the fact,
        then refresh their runs' totals. Returns rows resolved.

        Newest first, deterministically: an adapter that never resolves
        (lookup_cost always None) accumulates dead rows past `limit`, and an
        unordered sweep would refetch an arbitrary 500 while fresh
        resolvable rows starve behind them. Each futile lookup is counted
        on its row; at COST_LOOKUP_MAX_ATTEMPTS the row is terminal and
        leaves the sweep (its cost stays NULL — the spend gate keeps
        estimating it from usage, which never needed the lookup)."""
        if isinstance(limit, bool) or not isinstance(limit, int) or limit <= 0:
            raise ValueError("limit must be a positive integer")
        async with self._sessions() as session:
            pending = (
                await session.execute(
                    sa.select(
                        llm_attempts.c.id,
                        llm_attempts.c.provider_call_id,
                        llm_attempts.c.run_id,
                    )
                    .where(
                        llm_attempts.c.cost_usd.is_(None),
                        llm_attempts.c.provider_call_id.is_not(None),
                        llm_attempts.c.cost_lookup_attempts < COST_LOOKUP_MAX_ATTEMPTS,
                    )
                    .order_by(llm_attempts.c.ts.desc(), llm_attempts.c.id)
                    .limit(limit)
                )
            ).all()
        resolved = 0
        futile: list[str] = []
        touched_runs: set[str] = set()
        for row in pending:
            cost = await provider.lookup_cost(row.provider_call_id)
            if cost is None:
                futile.append(row.id)
                continue
            cost = _validated_deferred_cost(cost)
            async with self._sessions() as session, session.begin():
                await session.execute(
                    llm_attempts.update().where(llm_attempts.c.id == row.id).values(cost_usd=cost)
                )
            touched_runs.add(row.run_id)  # run_id is NOT NULL (FK)
            resolved += 1
        if futile:
            # atomic SQL increment (never read-modify-write) — concurrent
            # sweeps must not undercount their way past the terminal bound
            async with self._sessions() as session, session.begin():
                await session.execute(
                    llm_attempts.update()
                    .where(llm_attempts.c.id.in_(futile))
                    .values(cost_lookup_attempts=llm_attempts.c.cost_lookup_attempts + 1)
                )
        for run_id in touched_runs:
            async with self._sessions() as session, session.begin():
                total = await session.scalar(
                    sa.select(sa.func.sum(llm_attempts.c.cost_usd)).where(
                        llm_attempts.c.run_id == run_id
                    )
                )
                await session.execute(
                    llm_runs.update().where(llm_runs.c.id == run_id).values(total_cost_usd=total)
                )
        return resolved
