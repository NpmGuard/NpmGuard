"""Spend: the attempt table IS the ledger — no second bookkeeping. The
gate reads a trailing 24h window; unresolved costs (cost_usd NULL) are
counted at their static ModelSpec price or the settings' deliberately
expensive fallback rate — a budget that undercounts is not a budget.
resolve_costs() is the deferred pipeline stage: providers that only
reveal the real price after the fact get backfilled by provider_call_id."""

from datetime import UTC, datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_llm.capture import llm_attempts, llm_runs
from kit_llm.config import LlmSettings, ModelSpec
from kit_llm.errors import BudgetExhausted
from kit_llm.provider import ProviderPort


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
    price_in, price_out = spec.prices if spec and spec.prices else (
        settings.llm_fallback_price_in_per_mtok,
        settings.llm_fallback_price_out_per_mtok,
    )
    fresh = max((in_tokens or 0) - (cached_tokens or 0), 0)
    return (
        fresh * price_in / 1e6
        + (cached_tokens or 0) * price_in * 0.1 / 1e6
        + (out_tokens or 0) * price_out / 1e6
    )


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
        """Resolved costs summed in SQL; unresolved rows fetched and
        estimated conservatively — never counted at zero."""
        since = _window_start()
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
                        llm_attempts.c.in_tokens,
                        llm_attempts.c.out_tokens,
                        llm_attempts.c.cached_tokens,
                    ).where(
                        llm_attempts.c.ts >= since,
                        llm_attempts.c.cost_usd.is_(None),
                    )
                )
            ).all()
        estimated = sum(
            estimate_cost(
                self._specs.get(row.model) if row.model else None,
                self._settings,
                row.in_tokens,
                row.out_tokens,
                row.cached_tokens,
            )
            for row in unresolved
        )
        return float(resolved) + estimated

    async def guard(self, estimate_usd: float = 0.0) -> None:
        """Raises BudgetExhausted when the window plus the estimate would
        cross the budget minus its safety margin. Budget 0 = gate off."""
        budget = self._settings.llm_budget_usd_24h
        if budget <= 0:
            return
        headroom = budget * (1 - self._settings.llm_budget_margin)
        if await self.spent_24h() + estimate_usd > headroom:
            raise BudgetExhausted(
                f"llm budget: spent+estimate exceeds {headroom:.2f} USD headroom "
                f"(budget {budget:.2f}/24h)"
            )

    async def resolve_costs(self, provider: ProviderPort, limit: int = 500) -> int:
        """Backfill attempts whose provider reveals cost after the fact,
        then refresh their runs' totals. Returns rows resolved."""
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
                    )
                    .limit(limit)
                )
            ).all()
        resolved = 0
        touched_runs: set[str] = set()
        for row in pending:
            cost = await provider.lookup_cost(row.provider_call_id)
            if cost is None:
                continue
            async with self._sessions() as session, session.begin():
                await session.execute(
                    llm_attempts.update()
                    .where(llm_attempts.c.id == row.id)
                    .values(cost_usd=cost)
                )
            touched_runs.add(row.run_id)  # run_id is NOT NULL (FK)
            resolved += 1
        for run_id in touched_runs:
            async with self._sessions() as session, session.begin():
                total = await session.scalar(
                    sa.select(sa.func.sum(llm_attempts.c.cost_usd)).where(
                        llm_attempts.c.run_id == run_id
                    )
                )
                await session.execute(
                    llm_runs.update()
                    .where(llm_runs.c.id == run_id)
                    .values(total_cost_usd=total)
                )
        return resolved
