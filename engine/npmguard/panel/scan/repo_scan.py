"""Repo-scan orchestrator (port of TS ``scan/repo-scan.ts``).

Data flow: fetch lockfile -> parse -> diff against the index -> cache-first
enqueue (budget-checked) -> rollup. Two shapes:

- :meth:`RepoScanEngine.full_repo_scan`  — manual / reconcile / default-branch
  push: replaces the ``repo_deps`` index and scans everything not yet audited.
- :meth:`RepoScanEngine.delta_repo_scan` — push to any branch: scans only pairs
  NEW vs the index, and touches the index only on the default branch (a PR
  branch must not redefine what the repo runs in production).

Progress computes from ``scan_items`` (never ``repo_deps`` — a delta scan does
not touch the index, and a push can move ``repo_deps`` under a live scan) and
never from job ownership (jobs are deduped across scans by the partial-unique
index).

The 4->2-state reconciliation (spec §5): a dep's verdict is ``SAFE``,
``DANGEROUS``, or ``None`` (pending/failed). ``compute_rollup`` keeps the 4-key
wire shape, but ``suspect`` is always 0 and ``unknown`` counts the null/unaudited
deps — a repo is never SAFE while any dep is pending.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso

from ..caps import CapsStore
from ..jobs import JobSpec, PanelJobQueue
from ..lockfile import LockfileDep
from ..tables import (
    installations,
    package_verdicts,
    panel_jobs,
    repo_deps,
    repos,
    scan_items,
    scans,
)
from ..verdict_index import VerdictIndex


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
# Called ONCE when a scan carrying a GitHub check run finalizes: (repo, check_run_id,
# rollup_verdict). Injected so the DB engine stays GitHub-free; the wire stage binds
# it to conclude_check_run over the installation octokit. The fail-only-on-DANGEROUS
# mapping (check_conclusion) lives on the wire side — a still-unresolved rollup leaves
# the check open.
FinalizeCheck = Callable[[Mapping[str, Any], int, str | None], Awaitable[None]]


@dataclass
class Rollup:
    """Worst-dep-wins rollup over a repo's deps (spec §5, 4-key wire shape)."""

    verdict: str | None = None
    dangerous: int = 0
    suspect: int = 0
    unknown: int = 0
    safe: int = 0

    def as_wire(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "dangerous": self.dangerous,
            "suspect": self.suspect,
            "unknown": self.unknown,
            "safe": self.safe,
        }


def _verdict_of(dep: Any) -> str | None:
    if isinstance(dep, Mapping):
        return dep.get("verdict")
    return dep


def compute_rollup(deps: Iterable[Any]) -> Rollup:
    """Worst-dep-wins rollup. Accepts an iterable of verdicts (``str``/``None``)
    or dep mappings carrying a ``verdict`` key.

    Ordering ``DANGEROUS > SUSPECT(=0) > UNKNOWN > SAFE``; a null/unaudited dep
    lands in ``unknown`` so the repo is never SAFE while any dep is pending. An
    empty dep set yields ``verdict=None`` (nothing to roll up).
    """
    rollup = Rollup()
    total = 0
    for dep in deps:
        total += 1
        verdict = _verdict_of(dep)
        if verdict == "DANGEROUS":
            rollup.dangerous += 1
        elif verdict == "SUSPECT":  # never produced by dev; kept for wire shape
            rollup.suspect += 1
        elif verdict == "SAFE":
            rollup.safe += 1
        else:  # None (pending/failed), UNKNOWN, or any unexpected string
            rollup.unknown += 1
    if total == 0:
        return rollup
    if rollup.dangerous > 0:
        rollup.verdict = "DANGEROUS"
    elif rollup.suspect > 0:
        rollup.verdict = "SUSPECT"
    elif rollup.unknown > 0:
        rollup.verdict = "UNKNOWN"
    else:
        rollup.verdict = "SAFE"
    return rollup


def _dedupe(deps: Iterable[LockfileDep]) -> list[LockfileDep]:
    """Collapse duplicate ``(name, version)`` pairs — a scan's item set and the
    repo_deps index are both keyed on the pair, so a dup would collide on insert.
    The first occurrence (direct-classified if present) wins."""
    seen: dict[tuple[str, str], LockfileDep] = {}
    for dep in deps:
        key = (dep.name, dep.version)
        if key not in seen:
            seen[key] = dep
    return list(seen.values())


@dataclass
class RepoScanEngine:
    """Owns scan creation, index maintenance, and progress finalization.

    All GitHub access is behind ``fetch_repo_deps``; caps, verdict lookups, and
    job enqueues go through the injected stores. ``watch_sync`` (optional) is
    called after a protected repo's index changes.
    """

    sessions: async_sessionmaker
    caps: CapsStore
    verdict_index: VerdictIndex
    queue: PanelJobQueue
    fetch_repo_deps: FetchRepoDeps
    watch_sync: WatchSync | None = field(default=None)
    finalize_check: FinalizeCheck | None = field(default=None)

    # -- scan creation -----------------------------------------------------

    async def create_scan(
        self,
        repo: Mapping[str, Any],
        trigger: str,
        deps: Iterable[LockfileDep],
        *,
        commit_sha: str | None = None,
        check_run_id: int | None = None,
    ) -> int:
        """Insert the scan row + items, enqueue budget-checked cache misses, and
        kick progress. ``deps`` is the exact item set this scan covers."""
        deps = _dedupe(deps)
        org = await self._org_of(repo)

        verdicts = await self.verdict_index.get_many([(d.name, d.version) for d in deps])
        misses = [d for d in deps if (d.name, d.version) not in verdicts]

        # Budget check BEFORE any row is written — a refusal creates no scan.
        await self.caps.assert_audit_budget(repo["installation_id"], len(misses))

        now = now_iso()
        async with self.sessions() as session, session.begin():
            result = await session.execute(
                scans.insert().values(
                    repo_id=repo["id"],
                    trigger_kind=trigger,
                    commit_sha=commit_sha,
                    status="running",
                    total=len(deps),
                    cached=len(deps) - len(misses),
                    check_run_id=check_run_id,
                    started_at=now,
                )
            )
            scan_id = int(result.inserted_primary_key[0])
            for dep in deps:
                await session.execute(
                    scan_items.insert().values(
                        scan_id=scan_id,
                        name=dep.name,
                        version=dep.version,
                        cached=(dep.name, dep.version) in verdicts,
                    )
                )

        inserted = await self.queue.enqueue_many(
            [JobSpec(d.name, d.version, org, scan_id) for d in misses]
        )
        # Charge only jobs actually inserted — a pair already queued by another
        # scan is shared, not re-charged.
        await self.caps.consume_audit_budget(repo["installation_id"], inserted)

        await self.refresh_scan_progress(scan_id)
        return scan_id

    async def full_repo_scan(
        self,
        repo: Mapping[str, Any],
        trigger: str,
        *,
        ref: str | None = None,
        commit_sha: str | None = None,
        check_run_id: int | None = None,
    ) -> int:
        """Manual audit / reconcile / resync: full index replace + full-coverage
        scan."""
        parsed = await self._fetch_and_parse(repo, ref)
        scan_id = await self.create_scan(
            repo, trigger, parsed.deps, commit_sha=commit_sha, check_run_id=check_run_id
        )
        await self._replace_repo_deps(repo, parsed)
        if repo.get("protected_at") and self.watch_sync is not None:
            await self.watch_sync()
        return scan_id

    async def delta_repo_scan(
        self,
        repo: Mapping[str, Any],
        ref: str,
        head_sha: str,
        check_run_id: int | None,
    ) -> int:
        """Push-triggered delta: audit only pairs NEW vs the index. On the
        default branch the index is refreshed afterwards (the push IS the new
        truth); on other branches the index is deliberately untouched."""
        parsed = await self._fetch_and_parse(repo, head_sha)
        async with self.sessions() as session:
            known = {
                (row["name"], row["version"])
                for row in (
                    await session.execute(
                        sa.select(repo_deps.c.name, repo_deps.c.version).where(
                            repo_deps.c.repo_id == repo["id"]
                        )
                    )
                )
                .mappings()
                .all()
            }
        delta = [d for d in parsed.deps if (d.name, d.version) not in known]

        scan_id = await self.create_scan(
            repo, "push", delta, commit_sha=head_sha, check_run_id=check_run_id
        )

        if ref == repo.get("default_branch"):
            await self._replace_repo_deps(repo, parsed)
            if repo.get("protected_at") and self.watch_sync is not None:
                await self.watch_sync()
        return scan_id

    # -- progress / rollup -------------------------------------------------

    async def refresh_scan_progress(self, scan_id: int) -> None:
        """Recompute a running scan's counters from ``scan_items ⋈
        package_verdicts`` + active jobs; finalize (``status='done'``) when no
        item has an active job left. A no-op on a scan that is not running.

        The ``status='running'`` guard makes the finalize transition fire
        exactly once, so the GitHub check-run conclusion (below) is emitted a
        single time even though this is called on every worker settle."""
        # (repo_id, check_run_id, rollup_verdict) to conclude AFTER the txn.
        to_conclude: tuple[int, int, str | None] | None = None
        async with self.sessions() as session, session.begin():
            row = (
                (
                    await session.execute(
                        sa.select(
                            scans.c.status, scans.c.repo_id, scans.c.check_run_id
                        ).where(scans.c.id == scan_id)
                    )
                )
                .mappings()
                .first()
            )
            if row is None or row["status"] != "running":
                return

            items = await self._scan_item_states(session, scan_id)
            total = len(items)
            cached = sum(1 for i in items if i["cached"])
            # audited = resolved during this scan (no verdict at creation).
            audited = sum(1 for i in items if i["verdict"] is not None and not i["cached"])
            active = sum(1 for i in items if i["active"])
            # unresolved with no active job = failed (audit gave up after retries).
            failed = sum(1 for i in items if i["verdict"] is None and not i["active"])

            values: dict[str, Any] = {
                "total": total,
                "cached": cached,
                "audited": audited,
                "failed": failed,
            }
            if active == 0:
                values["status"] = "done"
                values["finished_at"] = now_iso()
                if row["check_run_id"] is not None and self.finalize_check is not None:
                    verdict = compute_rollup([i["verdict"] for i in items]).verdict
                    to_conclude = (row["repo_id"], row["check_run_id"], verdict)
            await session.execute(
                scans.update().where(scans.c.id == scan_id).values(**values)
            )

        # Conclude the GitHub check-run OUTSIDE the write txn (it makes a network
        # call, and only on the single running->done transition above).
        if to_conclude is not None:
            repo_id, check_run_id, verdict = to_conclude
            async with self.sessions() as session:
                repo = (
                    (
                        await session.execute(
                            sa.select(repos).where(repos.c.id == repo_id)
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
            if repo is not None:
                await self.finalize_check(dict(repo), check_run_id, verdict)

    async def refresh_scans_touching(self, package_name: str, version: str) -> None:
        """Nudge every running scan that covers ``(package_name, version)``.
        Cross-scan job sharing makes this the only reliable completion signal —
        used as the panel worker's ``on_scans_touched`` callback."""
        async with self.sessions() as session:
            scan_ids = (
                await session.execute(
                    sa.select(scans.c.id)
                    .select_from(scans.join(scan_items, scan_items.c.scan_id == scans.c.id))
                    .where(
                        scans.c.status == "running",
                        scan_items.c.name == package_name,
                        scan_items.c.version == version,
                    )
                    .distinct()
                )
            ).scalars().all()
        for scan_id in scan_ids:
            await self.refresh_scan_progress(scan_id)

    async def _scan_item_states(self, session: Any, scan_id: int) -> list[dict[str, Any]]:
        active_exists = (
            sa.select(sa.literal(1))
            .select_from(panel_jobs)
            .where(
                panel_jobs.c.package_name == scan_items.c.name,
                panel_jobs.c.version == scan_items.c.version,
                panel_jobs.c.state.in_(("queued", "running")),
            )
            .exists()
        )
        rows = (
            (
                await session.execute(
                    sa.select(
                        scan_items.c.name,
                        scan_items.c.version,
                        scan_items.c.cached,
                        package_verdicts.c.verdict,
                        active_exists.label("active"),
                    )
                    .select_from(
                        scan_items.outerjoin(
                            package_verdicts,
                            sa.and_(
                                package_verdicts.c.name == scan_items.c.name,
                                package_verdicts.c.version == scan_items.c.version,
                            ),
                        )
                    )
                    .where(scan_items.c.scan_id == scan_id)
                )
            )
            .mappings()
            .all()
        )
        return [
            {
                "name": row["name"],
                "version": row["version"],
                "cached": bool(row["cached"]),
                "verdict": row["verdict"],
                "active": bool(row["active"]),
            }
            for row in rows
        ]

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
        deps = _dedupe(parsed.deps)
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
    "Rollup",
    "compute_rollup",
]
