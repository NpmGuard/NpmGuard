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

The verdict model is two axes (design §4.4): each item carries an OUTCOME
(``SAFE | ERROR | DANGEROUS``, null until concluded — see
:func:`~npmguard.panel.verdict_index.item_outcome`) and, separately, PROGRESS.
:func:`compute_rollup` is the one place a set's counters are computed, and its
counters partition the items so that a half-finished set reads "SAFE so far, N
pending" instead of "unknown".
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
from ..verdict_index import (
    LANDABLE_VERDICTS,
    OUTCOMES,
    VerdictIndex,
    item_outcome,
    outcome_severity,
)


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
# rollup_outcome). Injected so the DB engine stays GitHub-free; the wire stage binds
# it to conclude_check_run over the installation octokit. The outcome -> check-state
# mapping (check_conclusion) lives on the wire side — only a set with nothing
# concluded (outcome None) leaves the check open.
FinalizeCheck = Callable[[Mapping[str, Any], int, str | None], Awaitable[None]]


@dataclass(frozen=True)
class RollupItem:
    """One item as the rollup sees it: its outcome, and whether it was cached.

    Deliberately not "a dep row" — the rollup counts sets of audited pairs
    (repo dep index, scan items, public snapshot items), and each caller lifts
    its own row shape through :func:`item_outcome` before counting. That keeps
    the rollup pure and stops it from guessing which key holds the verdict.
    """

    outcome: str | None
    cached: bool = False


@dataclass
class Rollup:
    """The one counters object over an audit set's items (contract
    ``AuditSetRollup``). Replaces today's ``{total, cached, audited, failed}``
    plus a separate ``{verdict, dangerous, suspect, unknown, safe}``."""

    outcome: str | None = None
    total: int = 0
    safe: int = 0
    dangerous: int = 0
    error: int = 0
    pending: int = 0
    cached: int = 0

    def as_wire(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome,
            "total": self.total,
            "safe": self.safe,
            "dangerous": self.dangerous,
            "error": self.error,
            "pending": self.pending,
            "cached": self.cached,
        }


def compute_rollup(items: Iterable[RollupItem]) -> Rollup:
    """Roll a set of :class:`RollupItem` up into its counters + outcome.

    INVARIANT: ``safe + dangerous + error + pending == total`` — every item is in
    exactly one of those four states, which is what makes the old ``unknown``
    bucket (three facts under one name) unrepresentable. ``cached`` is orthogonal
    (a subset of the concluded three) and excluded from the sum.

    INVARIANT: ``outcome`` is the max severity (``DANGEROUS > ERROR > SAFE``)
    over CONCLUDED items only, and ``None`` when none has concluded. Pending
    never contributes — a half-finished set is "SAFE so far, N pending".
    """
    rollup = Rollup()
    best: int | None = None
    for item in items:
        rollup.total += 1
        # INVARIANT: an item's outcome is a panel outcome or None. A legacy
        # SUSPECT/UNKNOWN reaching here is corruption upstream, not a bucket.
        assert item.outcome is None or item.outcome in OUTCOMES, (
            f"rollup item outcome {item.outcome!r} is outside "
            f"{sorted(OUTCOMES)} + None"
        )
        # INVARIANT: cached ⇒ the item concluded on a LANDED verdict. Cached
        # means "resolved from an existing report", so it can be neither pending
        # nor ERROR, and `audited = safe + dangerous - cached` (the scans-row
        # projection) is only valid under that — asserted here rather than
        # trusted there.
        assert not item.cached or item.outcome in LANDABLE_VERDICTS, (
            f"a cached item cannot have outcome {item.outcome!r}; cached means "
            f"'resolved from an existing report', so it is one of "
            f"{sorted(LANDABLE_VERDICTS)}"
        )
        if item.cached:
            rollup.cached += 1
        if item.outcome is None:
            rollup.pending += 1
            continue
        if item.outcome == "SAFE":
            rollup.safe += 1
        elif item.outcome == "DANGEROUS":
            rollup.dangerous += 1
        else:  # ERROR — exhaustive by the domain assert above
            rollup.error += 1
        severity = outcome_severity(item.outcome)
        if best is None or severity > best:
            best = severity
            rollup.outcome = item.outcome
    assert rollup.safe + rollup.dangerous + rollup.error + rollup.pending == rollup.total, (
        f"rollup counters do not partition the set: {rollup.as_wire()}"
    )
    return rollup


def rollup_items(rows: Iterable[Mapping[str, Any]]) -> list[RollupItem]:
    """Lift raw item rows (``verdict`` + ``active`` + optional ``cached``) into
    :class:`RollupItem`. The ONE place raw progress becomes an outcome, so the
    scan counters, the wire projection and the check-run cannot classify the same
    row differently — which is exactly what they used to do (``refresh_scan_
    progress`` called a jobless item "failed" while the wire called it null)."""
    return [
        RollupItem(
            outcome=item_outcome(row["verdict"], pending=bool(row["active"])),
            cached=bool(row.get("cached", False)),
        )
        for row in rows
    ]


async def scan_item_states(session: Any, scan_id: int) -> list[dict[str, Any]]:
    """``scan_items ⋈ package_verdicts`` + "has a live job", for one scan.

    Progress comes from ``scan_items`` (never ``repo_deps``: a delta scan does
    not touch the index, and a push can move ``repo_deps`` under a live scan) and
    never from job ownership — jobs are deduped across scans by the
    partial-unique index, so a shared job belongs to no single scan.
    """
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


async def scan_rollup(session: Any, scan_id: int) -> Rollup:
    """A scan's rollup over its OWN items — the single answer to "what did this
    scan conclude", shared by the progress projection, the GitHub check-run and
    the wire. A delta scan covers only the changed pairs, so a rollup over the
    repo's current dep index answers a different question and must not be
    reported as this scan's outcome."""
    return compute_rollup(rollup_items(await scan_item_states(session, scan_id)))


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
        # (repo_id, check_run_id, rollup_outcome) to conclude AFTER the txn.
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

            rollup = await scan_rollup(session, scan_id)
            # The scans row still persists the older four-counter projection; it
            # is DERIVED from the rollup so the two cannot disagree. `audited` =
            # freshly concluded WITH a verdict, i.e. safe+dangerous minus the
            # ones that came from cache (valid because cached ⊆ {safe,dangerous},
            # asserted in compute_rollup); `failed` IS the ERROR bucket — no
            # result and no attempt left. total == cached+audited+failed+pending.
            values: dict[str, Any] = {
                "total": rollup.total,
                "cached": rollup.cached,
                "audited": rollup.safe + rollup.dangerous - rollup.cached,
                "failed": rollup.error,
            }
            # INVARIANT: pending == 0 ⟺ no item has a live attempt, so the set is
            # finished. `pending` is the one progress counter, replacing a second
            # `active` scan of the same items.
            if rollup.pending == 0:
                values["status"] = "done"
                values["finished_at"] = now_iso()
                if row["check_run_id"] is not None and self.finalize_check is not None:
                    to_conclude = (row["repo_id"], row["check_run_id"], rollup.outcome)
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
    "RollupItem",
    "compute_rollup",
    "rollup_items",
    "scan_item_states",
    "scan_rollup",
]
