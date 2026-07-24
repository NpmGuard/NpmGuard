"""DANGEROUS-verdict fan-out (port of TS ``alerts/notify.ts``).

Called when any audit — scan-triggered or registry-watch — lands a DANGEROUS
verdict. Two exposure kinds (spec §5.6 / provocation 1):

- **exact** — the version is present in a repo's dependency index (``repo_deps``
  / a lockfile): it IS installed.
- **range** — a *protected* repo declares a DIRECT-dependency semver range that
  would ADOPT this version on its next update. This is the early-warning the
  product sells: a poisoned version nobody has installed yet.

npm ranges (``^``, ``~``, exact, ``*``, ``x``-ranges, ``||`` unions) are
evaluated with :mod:`univers` (``NpmVersionRange``). Non-semver ranges
(``git:``, ``file:``, ``workspace:``, url/tag specs) are not adoptable from the
registry and are silently skipped.

Both exposure kinds produce dashboard alert rows (deduped by
``(repo_id, name, version)``) and one email per affected org.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import sqlalchemy as sa
import structlog
from sqlalchemy.ext.asyncio import async_sessionmaker
from univers.version_range import NpmVersionRange
from univers.versions import SemverVersion

from kit_spine import now_iso
from npmguard.config import Settings
from npmguard.panel.tables import (
    alerts,
    gh_users,
    installations,
    repo_deps,
    repos,
    user_installations,
)

from .email import send_dangerous_email

log = structlog.get_logger("npmguard.panel.alerts")

# The email sender seam — injectable so notify's DB/exposure logic is unit
# testable without SMTP (a fake collector stands in for the real transport).
SendEmail = Callable[
    [Settings, str, list[str], str, str, list[str]], Awaitable[None]
]


def range_satisfies(version: str, range_spec: str | None) -> bool:
    """Whether ``version`` falls inside an npm ``range_spec``.

    Returns ``False`` — never raises — for a missing range, a non-semver range
    (``git:``/``file:``/``workspace:``/url/tag), or an unparseable version. Only
    a registry-adoptable semver match returns ``True``.
    """
    if not range_spec:
        return False
    try:
        rng = NpmVersionRange.from_native(range_spec)
        return SemverVersion(version) in rng
    except Exception:  # noqa: BLE001 - non-semver range / bad version => not adoptable
        return False


async def handle_dangerous_verdict(
    sessions: async_sessionmaker,
    package_name: str,
    version: str,
    *,
    source: str = "scan",
    verdict_reason: str | None = None,
    settings: Settings | None = None,
    send_email: SendEmail = send_dangerous_email,
) -> int:
    """Record + notify the exposure of a DANGEROUS ``package_name@version``.

    ``source`` is the alert ``kind`` (``'scan'`` | ``'watch'``). Returns the
    number of alert rows inserted (0 when nothing is exposed, or every exposed
    repo was already alerted for this pair). Email is sent per org only when
    ``settings`` is provided (the wire stage passes it).
    """
    exposed = await _collect_exposure(sessions, package_name, version, verdict_reason)
    if not exposed:
        return 0

    inserted = await _insert_alerts(sessions, package_name, version, source, exposed)

    # One email per org, addressed to every user with a known email on any
    # installation that owns the org.
    by_org: dict[str, list[dict[str, Any]]] = {}
    for repo in exposed:
        by_org.setdefault(repo["org"], []).append(repo)
    for org, org_repos in by_org.items():
        recipients = await _org_recipients(sessions, org)
        lines = [f"{r['full_name']}: {r['message']}" for r in org_repos]
        if settings is not None:
            await send_email(settings, org, recipients, package_name, version, lines)

    log.info(
        "dangerous fan-out",
        package=package_name,
        version=version,
        source=source,
        repos=len(exposed),
        orgs=len(by_org),
        alerts=inserted,
    )
    return inserted


async def _collect_exposure(
    sessions: async_sessionmaker,
    package_name: str,
    version: str,
    verdict_reason: str | None,
) -> list[dict[str, Any]]:
    """The exposed repos: exact (installed) first, then range (would-adopt).

    A repo exposed exactly is never double-counted in the range pass.
    """

    def _message(installed: bool, rng: str | None) -> str:
        if installed:
            base = f"installed at {version}"
        else:
            base = f"range {rng} would adopt {version} on next update"
        return f"{base}. Evidence: {verdict_reason}" if verdict_reason else base

    async with sessions() as session:
        exact_rows = (
            (
                await session.execute(
                    sa.select(
                        repos.c.id.label("repo_id"),
                        repos.c.full_name,
                        installations.c.account_login.label("org"),
                    )
                    .select_from(
                        repo_deps.join(repos, repos.c.id == repo_deps.c.repo_id).join(
                            installations,
                            installations.c.id == repos.c.installation_id,
                        )
                    )
                    .where(
                        repo_deps.c.name == package_name,
                        repo_deps.c.version == version,
                    )
                )
            )
            .mappings()
            .all()
        )

        range_rows = (
            (
                await session.execute(
                    sa.select(
                        repo_deps.c.range,
                        repos.c.id.label("repo_id"),
                        repos.c.full_name,
                        installations.c.account_login.label("org"),
                    )
                    .select_from(
                        repo_deps.join(repos, repos.c.id == repo_deps.c.repo_id).join(
                            installations,
                            installations.c.id == repos.c.installation_id,
                        )
                    )
                    .where(
                        repo_deps.c.name == package_name,
                        repo_deps.c.direct.is_(True),
                        repo_deps.c.range.is_not(None),
                        repos.c.protected_at.is_not(None),
                    )
                    .distinct()
                )
            )
            .mappings()
            .all()
        )

    exposed: list[dict[str, Any]] = []
    exact_ids: set[int] = set()
    for row in exact_rows:
        exact_ids.add(row["repo_id"])
        exposed.append(
            {
                "repo_id": row["repo_id"],
                "full_name": row["full_name"],
                "org": row["org"],
                "message": _message(installed=True, rng=None),
            }
        )
    for row in range_rows:
        if row["repo_id"] in exact_ids:
            continue  # already exposed exactly — don't duplicate
        if not range_satisfies(version, row["range"]):
            continue
        exposed.append(
            {
                "repo_id": row["repo_id"],
                "full_name": row["full_name"],
                "org": row["org"],
                "message": _message(installed=False, rng=row["range"]),
            }
        )
    return exposed


async def _insert_alerts(
    sessions: async_sessionmaker,
    package_name: str,
    version: str,
    source: str,
    exposed: list[dict[str, Any]],
) -> int:
    """Insert one alert row per exposed repo, deduped by
    ``(repo_id, package_name, version)``. Returns the count inserted."""
    now = now_iso()
    inserted = 0
    async with sessions() as session, session.begin():
        for repo in exposed:
            already = (
                await session.execute(
                    sa.select(sa.literal(1))
                    .select_from(alerts)
                    .where(
                        alerts.c.repo_id == repo["repo_id"],
                        alerts.c.package_name == package_name,
                        alerts.c.version == version,
                    )
                    .limit(1)
                )
            ).first()
            if already is not None:
                continue
            await session.execute(
                alerts.insert().values(
                    org=repo["org"],
                    repo_id=repo["repo_id"],
                    package_name=package_name,
                    version=version,
                    verdict="DANGEROUS",
                    kind=source,
                    message=repo["message"],
                    seen=False,
                    created_at=now,
                )
            )
            inserted += 1
    return inserted


async def _org_recipients(sessions: async_sessionmaker, org: str) -> list[str]:
    async with sessions() as session:
        rows = (
            await session.execute(
                sa.select(sa.distinct(gh_users.c.email))
                .select_from(
                    gh_users.join(
                        user_installations,
                        user_installations.c.user_id == gh_users.c.id,
                    ).join(
                        installations,
                        installations.c.id == user_installations.c.installation_id,
                    )
                )
                .where(
                    installations.c.account_login == org,
                    gh_users.c.email.is_not(None),
                )
            )
        ).scalars().all()
    return [email for email in rows if email]


__all__ = ["handle_dangerous_verdict", "range_satisfies"]
