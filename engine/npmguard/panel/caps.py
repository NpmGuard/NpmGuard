"""Entitlements + quotas per GitHub App installation.

An installation is the billing account shared by every member who can access it, so caps are enforced per ``installation_id``.

Plan resolution: ``plan='pro'`` iff the installation's
``billing_accounts.subscription_status`` is ``active`` or ``trialing`` — every
other status (including the ``inactive`` default and a missing row) is ``free``.

Limit semantics: a limit of ``0`` means UNLIMITED — the matching
``UsageBucket.remaining`` is ``None`` (the wire contract's "no cap" signal),
and the cap assertions never fire. A positive limit is a hard ceiling.

Limits come from ``Settings`` (``free_*`` / ``pro_*`` fields), so a deployment
retunes quotas without a code change.

What is NOT here: the public-repo scan. It used to carry a third bucket
(``publicRepoAudits``, counted per installation), and D-1 removed the only thing
that made it an installation's business — a public scan now needs a GitHub
sign-in and nothing else, so it has a requester and no payer, and no installation
is charged for one. Its ceiling is cost, not entitlement, it is scoped per user,
and it lives in ``panel/public_limits.py``. A bucket kept here would have had no
producer and would have reported ``used: 0`` forever.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from ..config import Settings
from .tables import (
    account_usage,
    billing_accounts,
    installations,
    repos,
)

AccountPlan = Literal["free", "pro"]
CapResource = Literal["protected_repos", "monthly_audits"]

# Only these subscription statuses grant the Pro plan; everything else is free.
_ACTIVE_SUBSCRIPTION_STATUSES = frozenset({"active", "trialing"})


@dataclass(frozen=True)
class PlanLimits:
    protected_repos: int
    monthly_audits: int


class CapExceededError(Exception):
    """A quota was exhausted. Carries the machine-readable ``resource`` and the
    fresh ``entitlements`` snapshot; the route layer maps this to a 402 body
    ``{error, cap: true, resource, installationId, entitlements}``."""

    cap = True

    def __init__(
        self,
        message: str,
        installation_id: int,
        resource: CapResource,
        entitlements: dict[str, Any],
    ) -> None:
        super().__init__(message)
        self.installation_id = installation_id
        self.resource = resource
        self.entitlements = entitlements


def _month_key() -> str:
    # 'YYYY-MM' in UTC — matches now_iso()'s timezone so a usage row and its
    # audit timestamps never straddle a month boundary differently.
    return datetime.now(UTC).strftime("%Y-%m")


def _remaining(limit: int, used: int) -> int | None:
    # limit == 0 is the UNLIMITED sentinel -> remaining is None (no cap).
    return None if limit == 0 else max(0, limit - used)


class CapsStore:
    def __init__(self, sessions: async_sessionmaker, settings: Settings) -> None:
        self._sessions = sessions
        self._settings = settings

    def plan_limits(self, plan: AccountPlan) -> PlanLimits:
        s = self._settings
        if plan == "pro":
            return PlanLimits(
                protected_repos=s.pro_max_protected_repos,
                monthly_audits=s.pro_max_audits_month,
            )
        return PlanLimits(
            protected_repos=s.free_max_protected_repos,
            monthly_audits=s.free_max_audits_month,
        )

    def plan_catalog(self) -> dict[str, dict[str, int]]:
        def _shape(limits: PlanLimits) -> dict[str, int]:
            return {
                "protectedRepos": limits.protected_repos,
                "monthlyAudits": limits.monthly_audits,
            }

        return {"free": _shape(self.plan_limits("free")), "pro": _shape(self.plan_limits("pro"))}

    async def entitlements(self, installation_id: int) -> dict[str, Any]:
        """The full ``AccountEntitlements``-shaped dict for one installation."""
        async with self._sessions() as session:
            account_login = await self._installation_account(session, installation_id)
            subscription_status = await self._subscription_status(session, installation_id)
            protected = await self._protected_repo_count(session, installation_id)
            monthly = await self._audits_used_this_month(session, installation_id)

        plan: AccountPlan = (
            "pro" if subscription_status in _ACTIVE_SUBSCRIPTION_STATUSES else "free"
        )
        limits = self.plan_limits(plan)
        return {
            "installationId": installation_id,
            "accountLogin": account_login,
            "plan": plan,
            "subscriptionStatus": subscription_status,
            "protectedRepos": {
                "used": protected,
                "limit": limits.protected_repos,
                "remaining": _remaining(limits.protected_repos, protected),
            },
            "monthlyAudits": {
                "used": monthly,
                "limit": limits.monthly_audits,
                "remaining": _remaining(limits.monthly_audits, monthly),
            },
        }

    async def assert_protect_cap(self, installation_id: int) -> None:
        entitlements = await self.entitlements(installation_id)
        bucket = entitlements["protectedRepos"]
        used, limit = bucket["used"], bucket["limit"]
        if limit > 0 and used >= limit:
            raise CapExceededError(
                f"{entitlements['accountLogin']} has used all {limit} "
                f"{entitlements['plan'].upper()} protected repositories",
                installation_id,
                "protected_repos",
                entitlements,
            )

    async def assert_audit_budget(self, installation_id: int, count: int) -> None:
        entitlements = await self.entitlements(installation_id)
        bucket = entitlements["monthlyAudits"]
        used, limit, available = bucket["used"], bucket["limit"], bucket["remaining"]
        if limit > 0 and used + count > limit:
            raise CapExceededError(
                f"This scan needs {count} new package audits, but "
                f"{entitlements['accountLogin']} has {available or 0} of {limit} "
                "left this month",
                installation_id,
                "monthly_audits",
                entitlements,
            )

    async def consume_audit_budget(self, installation_id: int, count: int) -> None:
        # Monthly accumulation keyed by (installation_id, 'YYYY-MM'). A new month
        # is a fresh row, so the budget resets automatically at the boundary.
        if count <= 0:
            return
        month = _month_key()
        async with self._sessions() as session, session.begin():
            existing = (
                await session.execute(
                    sa.select(account_usage.c.audits).where(
                        account_usage.c.installation_id == installation_id,
                        account_usage.c.month == month,
                    )
                )
            ).scalar_one_or_none()
            if existing is None:
                await session.execute(
                    account_usage.insert().values(
                        installation_id=installation_id, month=month, audits=count
                    )
                )
            else:
                await session.execute(
                    account_usage.update()
                    .where(
                        account_usage.c.installation_id == installation_id,
                        account_usage.c.month == month,
                    )
                    .values(audits=account_usage.c.audits + count)
                )

    async def _installation_account(self, session, installation_id: int) -> str:
        login = (
            await session.execute(
                sa.select(installations.c.account_login).where(
                    installations.c.id == installation_id
                )
            )
        ).scalar_one_or_none()
        if login is None:
            raise LookupError(f"GitHub installation {installation_id} not found")
        return login

    async def _subscription_status(self, session, installation_id: int) -> str:
        status = (
            await session.execute(
                sa.select(billing_accounts.c.subscription_status).where(
                    billing_accounts.c.installation_id == installation_id
                )
            )
        ).scalar_one_or_none()
        return status if status is not None else "inactive"

    async def _protected_repo_count(self, session, installation_id: int) -> int:
        return (
            await session.execute(
                sa.select(sa.func.count())
                .select_from(repos)
                .where(
                    repos.c.installation_id == installation_id,
                    repos.c.protected_at.is_not(None),
                )
            )
        ).scalar_one()

    async def _audits_used_this_month(self, session, installation_id: int) -> int:
        used = (
            await session.execute(
                sa.select(account_usage.c.audits).where(
                    account_usage.c.installation_id == installation_id,
                    account_usage.c.month == _month_key(),
                )
            )
        ).scalar_one_or_none()
        return used if used is not None else 0


__all__ = [
    "AccountPlan",
    "CapResource",
    "CapExceededError",
    "CapsStore",
    "PlanLimits",
]
