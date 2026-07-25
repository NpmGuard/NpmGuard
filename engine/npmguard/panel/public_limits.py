"""Cost control for public-repo scans, scoped per signed-in USER (D-1 / F-F6).

A public scan requires a GitHub sign-in and nothing more: no App installation, no
repo ownership, nothing charged. The sign-in is therefore the *abuse* ceiling —
which is why there is no IP rate-limiting and no captcha anywhere near this — and
what remains to bound is **cost**.

**A scan's cost is exactly its cache misses.** A ``(name, version)`` already in
``package_verdicts`` is free to serve; a miss buys one sandboxed audit. So F-F6's
"dep-count cap per scan" and "cached-only past the cap" are not two mechanisms,
they are one number seen at two extremes — how many NEW audits a scan may buy:

    budget == 0            -> cached-only: the set covers the lockfile's cached
                              verdicts and buys nothing
    0 < budget < misses    -> partial coverage: cached hits + `budget` misses
    budget >= misses       -> full coverage

Coverage smaller than the lockfile is REPORTED, never hidden: the snapshot row
stores the lockfile's dep count and the wire carries it beside the set's rollup,
so "we audited 150 of this repo's 900 dependencies" is a statement the result
screen can make. It is deliberately not modeled as items with a fourth outcome —
``item_outcome`` maps "no verdict and no live job" to ``ERROR`` ("we tried and
failed"), so parking uncovered deps in the set as unenqueued items would report
every one of them as a failed audit.

Two properties worth naming because they are load-bearing rather than incidental:

- **A repeat scan never consumes anything.** Its packages are all cached by then,
  so its cost is zero by construction. The installation-scoped cap this replaces
  had to buy that property with a ``COUNT(DISTINCT github_repo_id)`` special case;
  here it falls out of what cost means, and cannot be lost by editing a query.
- **Nothing is metered.** Spend is recomputed from the user's own sets
  (``audit_set_items.cached = false``), not accumulated into a counter, so it
  matches ``account_usage``'s monthly reset without a second usage table and
  cannot desynchronize from what was actually bought.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from ..config import Settings
from .tables import audit_set_items, audit_sets

# Spelled here rather than imported from `audit_set` to keep the import edge
# one-way (audit_set imports the limits, not the reverse).
_PUBLIC_REPO_SCAN = "public_repo_scan"


class TooManyLiveScansError(Exception):
    """The requester already has this many public scans running.

    Not a quota — a concurrency bound. The route maps it to 429 with the limit,
    because the answer is "wait for one to finish", never "pay us".
    """

    def __init__(self, limit: int) -> None:
        super().__init__(
            f"You already have {limit} public scans running — wait for one to finish"
        )
        self.limit = limit


def _month_prefix() -> str:
    # `started_at` is an ISO string written by now_iso() in UTC, so a 'YYYY-MM'
    # prefix match is the month filter. Same UTC month key account_usage uses, so
    # the two budgets roll over together.
    return datetime.now(UTC).strftime("%Y-%m")


@dataclass
class PublicScanLimits:
    """The three per-user bounds on public scanning."""

    sessions: async_sessionmaker
    settings: Settings

    async def assert_capacity(self, user_id: int) -> None:
        """Refuse a scan that would exceed the requester's live-scan concurrency.

        The ONE refusal in this module. Everything else degrades coverage instead,
        because refusing a signed-in stranger at the funnel's front door over cost
        is worse than telling them honestly what was and was not audited.
        """
        limit = self.settings.public_scan_max_concurrent
        async with self.sessions() as session:
            live = (
                await session.execute(
                    sa.select(sa.func.count())
                    .select_from(audit_sets)
                    .where(
                        audit_sets.c.origin == _PUBLIC_REPO_SCAN,
                        audit_sets.c.requested_by == user_id,
                        audit_sets.c.finished_at.is_(None),
                    )
                )
            ).scalar_one()
        if live >= limit:
            raise TooManyLiveScansError(limit)

    async def new_audit_budget(self, user_id: int) -> int | None:
        """How many cache misses this user's next scan may buy — ``None`` = no cap.

        The per-scan ceiling and what is left of the monthly one, whichever binds
        first. ``0`` on either knob is the UNLIMITED sentinel (the convention
        ``caps.py`` uses for plan limits), so it drops out of the ``min`` rather
        than clamping the budget to zero.
        """
        per_scan = self.settings.public_scan_max_new_audits
        monthly = self.settings.public_scan_monthly_new_audits
        bounds: list[int] = []
        if per_scan > 0:
            bounds.append(per_scan)
        if monthly > 0:
            bounds.append(max(0, monthly - await self.new_audits_this_month(user_id)))
        return min(bounds) if bounds else None

    async def new_audits_this_month(self, user_id: int) -> int:
        """New audits this user's public scans have bought this calendar month.

        Recomputed from the sets themselves — an item is a purchase iff it was a
        cache miss at set creation (``cached = false``) — so there is no usage
        counter to drift from what was bought. Uncovered deps never appear here
        because they never became items.
        """
        async with self.sessions() as session:
            return (
                await session.execute(
                    sa.select(sa.func.count())
                    .select_from(
                        audit_set_items.join(
                            audit_sets, audit_sets.c.id == audit_set_items.c.set_id
                        )
                    )
                    .where(
                        audit_sets.c.origin == _PUBLIC_REPO_SCAN,
                        audit_sets.c.requested_by == user_id,
                        audit_sets.c.started_at.startswith(_month_prefix()),
                        audit_set_items.c.cached.is_(False),
                    )
                )
            ).scalar_one()


__all__ = ["PublicScanLimits", "TooManyLiveScansError"]
