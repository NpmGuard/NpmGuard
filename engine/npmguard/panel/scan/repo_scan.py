"""Item discovery for the ``repo_scan`` origin: an owned repo's lockfile.

After R-1 this module owns exactly one thing — turning a repo (and optionally a
ref) into the ``(name, version)`` list an audit set covers, plus the ``repo_deps``
index maintenance that registry-watch alerts from. Progress, the rollup, the item
projection, truncation and the SSE stream all live once in
:mod:`npmguard.panel.audit_set`; this file no longer has an opinion about any of
them.

Two entry points, and they differ in **less than they used to**:

- :meth:`RepoScanEngine.full_repo_scan`  — manual / reconcile / resync: replaces
  the ``repo_deps`` index from the parsed lockfile.
- :meth:`RepoScanEngine.push_repo_scan`  — a push to any branch: opens a set over
  the pushed commit's lockfile, and touches the index only on the default branch
  (a PR branch must not redefine what the repo runs in production).

**Both cover the WHOLE parsed lockfile.** The old delta scan covered only pairs
new versus the index, and that was wrong in two ways at once. It made
``repo.lastScan`` — which the dashboard's entire triage story reads as the repo's
posture — a rollup over three items out of four hundred. And a push whose delta
was empty produced a set with no items, whose outcome was therefore ``None``,
which the check-run mapper read as "not resolved yet" and left ``in_progress``
forever. Covering the commit fixes both, and costs nothing: "audit only what
changed" was never the item list's job — it is the cache-first enqueue in
``AuditSetStore.create``, which already skips every pair that has a landed
verdict. The one behavioural difference is that a pair whose previous audit
FAILED is retried on the next push instead of being silently skipped forever,
which is the retry story working rather than a regression.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso

from ..audit_set import (
    ORIGIN_REPO_SCAN,
    AuditSetSpec,
    AuditSetStore,
    dedupe,
    monthly_budget_hooks,
)
from ..caps import CapsStore
from ..lockfile import LockfileDep
from ..tables import installations, repo_deps, repos


class LockfileNotFoundError(Exception):
    """No supported lockfile at the repo root — the repo is non-auditable."""

    def __init__(self) -> None:
        super().__init__(
            "No supported lockfile found — commit package-lock.json, "
            "pnpm-lock.yaml, or yarn.lock at the repo root"
        )


@dataclass(frozen=True)
class ParsedRepoDeps:
    """The result of fetching + parsing a repo's lockfile."""

    deps: list[LockfileDep]
    lockfile_path: str
    lockfile_sha: str


# The fetch+parse seam (octokit + contents API + lockfile parser). Injected so
# the engine's DB logic is testable without GitHub. Raises LockfileNotFoundError
# when the repo has no supported root lockfile.
FetchRepoDeps = Callable[[Mapping[str, Any], str | None], Awaitable[ParsedRepoDeps]]
WatchSync = Callable[[], Awaitable[None]]


@dataclass
class RepoScanEngine:
    """Discovers a repo's items, opens the set, and maintains ``repo_deps``.

    All GitHub access is behind ``fetch_repo_deps``; the set itself is created by
    the shared :class:`~npmguard.panel.audit_set.AuditSetStore`. ``watch_sync``
    (optional) is called after a protected repo's index changes.
    """

    sessions: async_sessionmaker
    caps: CapsStore
    sets: AuditSetStore
    fetch_repo_deps: FetchRepoDeps
    watch_sync: WatchSync | None = field(default=None)

    # -- set creation ------------------------------------------------------

    async def create_set(
        self,
        repo: Mapping[str, Any],
        trigger: str,
        deps: list[LockfileDep],
        *,
        commit_sha: str | None = None,
        check_run_id: int | None = None,
    ) -> int:
        """Open a ``repo_scan`` set over ``deps``, billed to the repo's
        installation's monthly audit budget."""
        installation_id = repo["installation_id"]
        assert_budget, consume_budget = monthly_budget_hooks(self.caps, installation_id)
        return await self.sets.create(
            AuditSetSpec(
                origin=ORIGIN_REPO_SCAN,
                origin_ref=repo["id"],
                trigger=trigger,
                items=deps,
                billed_to=installation_id,
                billed_org=await self._org_of(repo),
                commit_sha=commit_sha,
                check_run_id=check_run_id,
                assert_budget=assert_budget,
                consume_budget=consume_budget,
            )
        )

    async def full_repo_scan(
        self,
        repo: Mapping[str, Any],
        trigger: str,
        *,
        ref: str | None = None,
        commit_sha: str | None = None,
        check_run_id: int | None = None,
    ) -> int:
        """Manual audit / reconcile / resync: full index replace + a set over the
        whole lockfile."""
        parsed = await self._fetch_and_parse(repo, ref)
        set_id = await self.create_set(
            repo, trigger, parsed.deps, commit_sha=commit_sha, check_run_id=check_run_id
        )
        await self._replace_repo_deps(repo, parsed)
        if repo.get("protected_at") and self.watch_sync is not None:
            await self.watch_sync()
        return set_id

    async def push_repo_scan(
        self,
        repo: Mapping[str, Any],
        ref: str,
        head_sha: str,
        check_run_id: int | None,
    ) -> int:
        """Push-triggered: a set over the PUSHED COMMIT's lockfile.

        On the default branch the index is refreshed afterwards (the push IS the
        new truth); on other branches the index is deliberately untouched, so the
        set answers "is this commit safe" without redefining production.
        """
        parsed = await self._fetch_and_parse(repo, head_sha)
        set_id = await self.create_set(
            repo, "push", parsed.deps, commit_sha=head_sha, check_run_id=check_run_id
        )
        if ref == repo.get("default_branch"):
            await self._replace_repo_deps(repo, parsed)
            if repo.get("protected_at") and self.watch_sync is not None:
                await self.watch_sync()
        return set_id

    # -- index maintenance -------------------------------------------------

    async def _fetch_and_parse(
        self, repo: Mapping[str, Any], ref: str | None
    ) -> ParsedRepoDeps:
        try:
            return await self.fetch_repo_deps(repo, ref)
        except LockfileNotFoundError:
            # Record the repo as confirmed non-auditable so /panel/repos filters
            # it out (lockfile_path NULL + a set auditability marker).
            checked = now_iso()
            async with self.sessions() as session, session.begin():
                await session.execute(
                    repos.update()
                    .where(repos.c.id == repo["id"])
                    .values(
                        lockfile_path=None,
                        lockfile_sha=None,
                        auditability_checked_at=checked,
                        updated_at=checked,
                    )
                )
            raise

    async def _replace_repo_deps(
        self, repo: Mapping[str, Any], parsed: ParsedRepoDeps
    ) -> None:
        now = now_iso()
        deps = dedupe(parsed.deps)
        async with self.sessions() as session, session.begin():
            await session.execute(
                repo_deps.delete().where(repo_deps.c.repo_id == repo["id"])
            )
            for dep in deps:
                await session.execute(
                    repo_deps.insert().values(
                        repo_id=repo["id"],
                        name=dep.name,
                        version=dep.version,
                        direct=dep.direct,
                        range=dep.range,
                    )
                )
            await session.execute(
                repos.update()
                .where(repos.c.id == repo["id"])
                .values(
                    lockfile_path=parsed.lockfile_path,
                    lockfile_sha=parsed.lockfile_sha,
                    auditability_checked_at=now,
                    updated_at=now,
                )
            )

    async def _org_of(self, repo: Mapping[str, Any]) -> str:
        async with self.sessions() as session:
            login = (
                await session.execute(
                    sa.select(installations.c.account_login).where(
                        installations.c.id == repo["installation_id"]
                    )
                )
            ).scalar_one_or_none()
        return login or repo.get("owner") or ""


__all__ = [
    "LockfileNotFoundError",
    "ParsedRepoDeps",
    "RepoScanEngine",
]
