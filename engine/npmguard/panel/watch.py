"""Registry-watch + lockfile-reconcile (port of TS ``watch/poller.ts`` +
``jobs/reconcile.ts``).

The CLI guards the *install* moment; this guards the *publish* moment. Every
distinct package used by a protected repo is ETag-polled against the npm
registry — 304s are free, so a few thousand watched packages cost almost
nothing per cycle. A newly published version is audited proactively (before
anyone installs it) and, when DANGEROUS, fans out via ``alerts/notify``. Watch
audits carry ``org=None`` — they fill the shared cache and are **not charged**
to any org's budget.

Reconcile is the daily healer: a webhook missed while the engine was down leaves
the dep index stale, and registry-watch alerts FROM that index. One contents
call per protected repo compares the lockfile blob sha; a scan runs only on
actual drift.

The two loops are ``asyncio`` background tasks (unlike TS's ``setInterval``),
built here and started by the wire stage. ``sync_watched_packages`` must be
called after every writer of ``repo_deps`` (scan, webhook, protect toggle) to
keep the watch list reconciled with the protected-repo dependency set.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

import httpx
import sqlalchemy as sa
import structlog
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso
from npmguard.resolve import NPM_REGISTRY

from .jobs import JobSpec, PanelJobQueue
from .scan.repo_scan import LockfileNotFoundError, RepoScanEngine
from .tables import repo_deps, repos, watched_packages
from .verdict_index import VerdictIndex

log = structlog.get_logger("npmguard.panel.watch")


async def sync_watched_packages(sessions: async_sessionmaker) -> None:
    """Reconcile ``watched_packages`` with the DISTINCT deps of protected repos.

    Additive-then-subtractive and portable (no dialect-specific ``INSERT OR
    IGNORE``): insert names newly protected, delete names no longer used by any
    protected repo. Idempotent — safe to call after every ``repo_deps`` write.
    """
    now = now_iso()
    async with sessions() as session, session.begin():
        target = set(
            (
                await session.execute(
                    sa.select(sa.distinct(repo_deps.c.name))
                    .select_from(
                        repo_deps.join(repos, repos.c.id == repo_deps.c.repo_id)
                    )
                    .where(repos.c.protected_at.is_not(None))
                )
            ).scalars().all()
        )
        current = set(
            (
                await session.execute(sa.select(watched_packages.c.name))
            ).scalars().all()
        )
        for name in target - current:
            await session.execute(
                watched_packages.insert().values(name=name, created_at=now)
            )
        stale = current - target
        if stale:
            await session.execute(
                watched_packages.delete().where(watched_packages.c.name.in_(stale))
            )


def _encode_package(name: str) -> str:
    """Scoped names need the internal slash encoded: ``@scope%2Fname``."""
    return name.replace("/", "%2F")


@dataclass
class RegistryWatcher:
    """ETag-polls every watched package; audits newly published versions.

    Injectable ``registry_base`` (points at the registry stub in tests) and
    ``client_factory`` (an ``httpx.AsyncClient`` provider) keep it drivable
    without the public network.
    """

    sessions: async_sessionmaker
    queue: PanelJobQueue
    verdict_index: VerdictIndex
    registry_base: str = NPM_REGISTRY
    client_factory: Any = field(default=lambda: httpx.AsyncClient(timeout=30.0))
    _polling: bool = field(default=False, init=False)

    async def poll_once(self) -> None:
        """One full sweep. Guards against a slow cycle stacking on itself."""
        if self._polling:
            return
        self._polling = True
        try:
            async with self.sessions() as session:
                rows = (
                    (await session.execute(sa.select(watched_packages)))
                    .mappings()
                    .all()
                )
            async with self.client_factory() as client:
                for row in rows:
                    try:
                        await self._poll_package(client, dict(row))
                    except Exception as err:  # noqa: BLE001 - one bad pkg != a dead sweep
                        log.warning("watch poll failed", package=row["name"], error=str(err))
        finally:
            self._polling = False

    async def _poll_package(self, client: httpx.AsyncClient, row: dict[str, Any]) -> None:
        name = row["name"]
        url = f"{self.registry_base.rstrip('/')}/{_encode_package(name)}"
        headers = {"accept": "application/json"}
        if row.get("etag"):
            headers["if-none-match"] = row["etag"]
        resp = await client.get(url, headers=headers)

        if resp.status_code == 304:
            await self._touch(name)
            return
        if resp.status_code != 200:
            log.warning("registry non-200", package=name, status=resp.status_code)
            return

        meta = resp.json()
        versions = list((meta.get("versions") or {}).keys()) if isinstance(meta, dict) else []
        etag = resp.headers.get("etag")

        first_sight = row.get("last_checked_at") is None
        known = set(json.loads(row.get("known_versions") or "[]"))
        # First sight only establishes the baseline — a package's entire back
        # catalogue is not "newly published".
        fresh = [] if first_sight else [v for v in versions if v not in known]

        await self._record(name, etag, versions)
        if not fresh:
            return
        log.info("watch new versions", package=name, versions=fresh)

        # Proactive, shared-cache audits: org=None (not charged), scan_id=None.
        cached = await self.verdict_index.get_many([(name, v) for v in fresh])
        specs = [
            JobSpec(name, v, None, None) for v in fresh if (name, v) not in cached
        ]
        if specs:
            await self.queue.enqueue_many(specs)

    async def _touch(self, name: str) -> None:
        async with self.sessions() as session, session.begin():
            await session.execute(
                watched_packages.update()
                .where(watched_packages.c.name == name)
                .values(last_checked_at=now_iso())
            )

    async def _record(self, name: str, etag: str | None, versions: list[str]) -> None:
        async with self.sessions() as session, session.begin():
            await session.execute(
                watched_packages.update()
                .where(watched_packages.c.name == name)
                .values(
                    etag=etag,
                    known_versions=json.dumps(versions),
                    last_checked_at=now_iso(),
                )
            )

    async def run_forever(self, interval_seconds: float, first_delay: float = 30.0) -> None:
        """The background loop. First cycle shortly after boot (baselines), then
        every ``interval_seconds``."""
        try:
            await asyncio.sleep(first_delay)
            while True:
                try:
                    await self.poll_once()
                except Exception:  # noqa: BLE001 - guard the loop
                    log.exception("watch cycle crashed")
                await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


# The lockfile-fetch seam: (octo, owner, repo) -> the lockfile blob sha (or
# None). Injected so reconcile is testable without GitHub.
FetchLockfileSha = Any


@dataclass
class Reconciler:
    """Daily lockfile-drift healer over the protected repos."""

    sessions: async_sessionmaker
    gh_client: Any
    panel_scan: RepoScanEngine
    fetch_lockfile: Any  # async (octo, owner, repo) -> FetchedFile | None

    async def reconcile_once(self) -> None:
        async with self.sessions() as session:
            protected = (
                (
                    await session.execute(
                        sa.select(repos).where(repos.c.protected_at.is_not(None))
                    )
                )
                .mappings()
                .all()
            )
        for repo in protected:
            try:
                octo = self.gh_client.installation_octokit(repo["installation_id"])
                lockfile = await self.fetch_lockfile(octo, repo["owner"], repo["name"])
                if lockfile is None:
                    continue  # lockfile-less repos can't be reconciled
                if lockfile.sha == repo["lockfile_sha"]:
                    continue  # no drift
                log.info("reconcile drift — rescanning", repo=repo["full_name"])
                await self.panel_scan.full_repo_scan(dict(repo), "reconcile")
            except LockfileNotFoundError:
                continue
            except Exception as err:  # noqa: BLE001 - one repo failure != a dead sweep
                log.warning("reconcile failed", repo=repo["full_name"], error=str(err))

    async def run_forever(
        self, interval_seconds: float = 24 * 60 * 60, first_delay: float = 60.0
    ) -> None:
        """Daily loop + a startup pass (delayed so boot isn't blocked) that heals
        anything missed while the engine was down."""
        try:
            await asyncio.sleep(first_delay)
            while True:
                try:
                    await self.reconcile_once()
                except Exception:  # noqa: BLE001 - guard the loop
                    log.exception("reconcile cycle crashed")
                await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise


# Module-level thin wrappers matching the task's function-shaped seams. The wire
# stage may use either these or the runner classes above.
async def poll_once(watcher: RegistryWatcher) -> None:
    await watcher.poll_once()


async def reconcile_once(reconciler: Reconciler) -> None:
    await reconciler.reconcile_once()


__all__ = [
    "Reconciler",
    "RegistryWatcher",
    "poll_once",
    "reconcile_once",
    "sync_watched_packages",
]
