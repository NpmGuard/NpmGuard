"""Public-repo audit engine (port of TS ``scan/public-repo-scan.ts``).

A public-repo audit is a **read-only snapshot**: a signed-in user points the
panel at any public GitHub repository, and its root lockfile is audited against
the shared verdict cache. Unlike a protected-repo scan there is no owning repo
row, no check-run, and no webhook relationship — the snapshot lives entirely in
``public_repo_scans`` / ``public_repo_scan_items``.

Two boundaries are load-bearing:

- :func:`parse_public_repo_reference` is the **SSRF boundary**. It accepts only a
  GitHub repository *identity* (``owner/repo`` or ``https://github.com/owner/repo``)
  — never an arbitrary fetch URL — and hands back a validated ``owner``/``repo``.
  The bytes are then pulled by the credential-free public octokit + the raw-host
  allow-list in ``github/content.py``; a private repo 404s by construction.
- The cap is asserted by stable ``github_repo_id`` (:meth:`CapsStore.
  assert_public_repo_audit_cap`), so **re-auditing the same repo is always
  free** — a rename can't make a repo cost a second Free slot.

Progress + rollup mirror ``repo_scan``: counters come from ``public_repo_scan_items
⋈ package_verdicts`` + active ``panel_jobs``, and :func:`compute_rollup` (reused
from ``repo_scan``) keeps the 4-key wire shape while dev only ever produces
``SAFE``/``DANGEROUS``/``None``.

Fan-out (the dev decision, differing from TS): public deps enqueue ``panel_jobs``
with ``scan_id=None`` **and** ``org=None`` — a public snapshot owns no scan and
its audits are not charged against the org's monthly budget (the public-audit
cap is the only quota, counted by distinct ``github_repo_id``). Only pairs with
no global verdict yet are enqueued.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso

from ..caps import CapsStore
from ..jobs import JobSpec, PanelJobQueue
from ..lockfile import LockfileDep
from ..tables import (
    package_verdicts,
    panel_jobs,
    public_repo_scan_items,
    public_repo_scans,
)
from ..verdict_index import VerdictIndex
from .repo_scan import Rollup, compute_rollup

# GitHub identity grammar (mirrors the TS OWNER_PATTERN / REPO_PATTERN).
_OWNER_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_GITHUB_HOST = "github.com"


class InvalidPublicRepoReferenceError(Exception):
    """The input was not a recognizable GitHub repository identity."""

    def __init__(self) -> None:
        super().__init__(
            "Enter a GitHub repository as owner/repo or "
            "https://github.com/owner/repo"
        )


@dataclass(frozen=True, slots=True)
class PublicRepoReference:
    owner: str
    repo: str
    full_name: str


def parse_public_repo_reference(raw: str) -> PublicRepoReference:
    """Accept only a GitHub repository identity, never an arbitrary fetch URL.

    This is both the UX normalizer and the SSRF boundary for public audits:
    ``owner/repo`` or an ``https://github.com/owner/repo`` URL (``.git`` stripped)
    is accepted; anything with another scheme/host, credentials, a query, a
    fragment, or a shape that is not exactly two path segments is rejected.
    """
    value = raw.strip()
    path = value

    # A bare ``github.com/owner/repo`` (no scheme) is normalized to https first.
    if re.match(r"^github\.com/", path, re.IGNORECASE):
        path = f"https://{path}"

    if re.match(r"^https?://", path, re.IGNORECASE):
        parts = urlsplit(path)
        host = (parts.hostname or "").lower()
        if (
            parts.scheme != "https"
            or host != _GITHUB_HOST
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
        ):
            raise InvalidPublicRepoReferenceError()
        path = parts.path.strip("/")
    elif ":" in path:
        # Reject scp-style (``git@github.com:owner/repo``) and any other scheme —
        # a colon in a non-URL input is never a valid ``owner/repo``.
        raise InvalidPublicRepoReferenceError()

    segments = path.strip("/").split("/")
    if len(segments) != 2:
        raise InvalidPublicRepoReferenceError()

    owner = segments[0]
    repo = re.sub(r"\.git$", "", segments[1], flags=re.IGNORECASE)
    if (
        not _OWNER_PATTERN.match(owner)
        or not _REPO_PATTERN.match(repo)
        or repo in {".", ".."}
    ):
        raise InvalidPublicRepoReferenceError()
    return PublicRepoReference(owner=owner, repo=repo, full_name=f"{owner}/{repo}")


@dataclass(frozen=True, slots=True)
class CreatePublicRepoScanInput:
    """Everything needed to persist one public-repo snapshot.

    ``deps`` is the parsed lockfile; ``github_repo_id`` is the stable id the cap
    counts on (free re-audit); the ``owner``/``name``/``full_name`` are the
    canonical values from the GitHub repo response, not the user's input.
    """

    installation_id: int
    requested_by: int
    github_repo_id: int
    owner: str
    name: str
    full_name: str
    html_url: str
    default_branch: str
    commit_sha: str | None
    lockfile_path: str
    lockfile_sha: str
    deps: list[LockfileDep]


def _unique_deps(deps: Iterable[LockfileDep]) -> list[LockfileDep]:
    """Collapse duplicate ``(name, version)`` pairs — the item set is keyed on
    the pair, so a dup would collide on insert. First occurrence wins."""
    seen: dict[tuple[str, str], LockfileDep] = {}
    for dep in deps:
        key = (dep.name, dep.version)
        if key not in seen:
            seen[key] = dep
    return list(seen.values())


@dataclass
class PublicRepoScanEngine:
    """Owns public-snapshot creation, progress finalization, and rollups.

    Mirrors :class:`RepoScanEngine` but over the ``public_repo_scans`` tables.
    Collaborators are injected so the DB logic is testable without GitHub.
    """

    sessions: async_sessionmaker
    caps: CapsStore
    verdict_index: VerdictIndex
    queue: PanelJobQueue = field(default=None)  # type: ignore[assignment]

    # -- lookups -----------------------------------------------------------

    async def find_running_public_scan(
        self, installation_id: int, full_name: str
    ) -> int | None:
        """The id of a still-running scan for this repo (case-insensitive), or
        ``None``. The frontend treats a 409 carrying this id as a success."""
        async with self.sessions() as session:
            return (
                await session.execute(
                    sa.select(public_repo_scans.c.id)
                    .where(
                        public_repo_scans.c.installation_id == installation_id,
                        public_repo_scans.c.full_name_lower == full_name.lower(),
                        public_repo_scans.c.status == "running",
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()

    # -- scan creation -----------------------------------------------------

    async def create_public_repo_scan(self, data: CreatePublicRepoScanInput) -> int:
        """Persist a read-only snapshot and enqueue only globally-uncached work.

        The cap is re-asserted here (a repo consumes one Free slot only once; the
        stable ``github_repo_id`` survives renames) as the race guard. dev's
        ``CapsStore`` manages its own session, so this is a pre-insert assertion
        rather than a same-txn lock — the ``ix_public_repo_scans_active`` partial
        unique index is the durable guard against two concurrent running scans.
        """
        deps = _unique_deps(data.deps)
        verdicts = await self.verdict_index.get_many(
            [(d.name, d.version) for d in deps]
        )
        cached_keys = {
            (d.name, d.version) for d in deps if (d.name, d.version) in verdicts
        }
        misses = [d for d in deps if (d.name, d.version) not in cached_keys]

        await self.caps.assert_public_repo_audit_cap(
            data.installation_id, data.github_repo_id
        )

        now = now_iso()
        async with self.sessions() as session, session.begin():
            result = await session.execute(
                public_repo_scans.insert().values(
                    installation_id=data.installation_id,
                    requested_by=data.requested_by,
                    github_repo_id=data.github_repo_id,
                    owner=data.owner,
                    name=data.name,
                    full_name=data.full_name,
                    full_name_lower=data.full_name.lower(),
                    html_url=data.html_url,
                    default_branch=data.default_branch,
                    commit_sha=data.commit_sha,
                    lockfile_path=data.lockfile_path,
                    lockfile_sha=data.lockfile_sha,
                    status="running",
                    total=len(deps),
                    cached=len(cached_keys),
                    started_at=now,
                )
            )
            scan_id = int(result.inserted_primary_key[0])
            for dep in deps:
                await session.execute(
                    public_repo_scan_items.insert().values(
                        scan_id=scan_id,
                        name=dep.name,
                        version=dep.version,
                        direct=dep.direct,
                        range=dep.range,
                        cached=(dep.name, dep.version) in cached_keys,
                    )
                )

        # Public snapshots own no jobs (scan_id=None) and are not charged to the
        # org budget (org=None) — the public-audit cap is the only quota.
        await self.queue.enqueue_many([JobSpec(d.name, d.version) for d in misses])
        await self.refresh_public_scan_progress(scan_id)
        return scan_id

    # -- progress / rollup -------------------------------------------------

    async def refresh_public_scan_progress(self, scan_id: int) -> None:
        """Recompute a running snapshot's counters from ``public_repo_scan_items
        ⋈ package_verdicts`` + active jobs; finalize (``status='done'``) once no
        item has an active job left. A no-op on a scan that is not running.

        The ``status='running'`` guard makes the finalize transition fire exactly
        once (called on every worker settle via ``refresh_public_scans_touching``)."""
        async with self.sessions() as session, session.begin():
            row = (
                (
                    await session.execute(
                        sa.select(public_repo_scans.c.status).where(
                            public_repo_scans.c.id == scan_id
                        )
                    )
                )
                .mappings()
                .first()
            )
            if row is None or row["status"] != "running":
                return

            items = await self._public_item_states(session, scan_id)
            total = len(items)
            cached = sum(1 for i in items if i["cached"])
            # audited = resolved during this scan (no verdict at creation).
            audited = sum(
                1 for i in items if i["verdict"] is not None and not i["cached"]
            )
            active = sum(1 for i in items if i["active"])
            # unresolved with no active job = failed (audit gave up after retries).
            failed = sum(1 for i in items if i["verdict"] is None and not i["active"])

            values: dict[str, object] = {
                "total": total,
                "cached": cached,
                "audited": audited,
                "failed": failed,
            }
            if active == 0:
                values["status"] = "done"
                values["finished_at"] = now_iso()
            await session.execute(
                public_repo_scans.update()
                .where(public_repo_scans.c.id == scan_id)
                .values(**values)
            )

    async def refresh_public_scans_touching(
        self, package_name: str, version: str
    ) -> None:
        """Nudge every running public snapshot that covers ``(package_name,
        version)`` — the panel worker's public-side ``on_scans_touched`` hook."""
        async with self.sessions() as session:
            scan_ids = (
                await session.execute(
                    sa.select(public_repo_scans.c.id)
                    .select_from(
                        public_repo_scans.join(
                            public_repo_scan_items,
                            public_repo_scan_items.c.scan_id == public_repo_scans.c.id,
                        )
                    )
                    .where(
                        public_repo_scans.c.status == "running",
                        public_repo_scan_items.c.name == package_name,
                        public_repo_scan_items.c.version == version,
                    )
                    .distinct()
                )
            ).scalars().all()
        for scan_id in scan_ids:
            await self.refresh_public_scan_progress(scan_id)

    async def _public_item_states(
        self, session: object, scan_id: int
    ) -> list[dict[str, object]]:
        active_exists = (
            sa.select(sa.literal(1))
            .select_from(panel_jobs)
            .where(
                panel_jobs.c.package_name == public_repo_scan_items.c.name,
                panel_jobs.c.version == public_repo_scan_items.c.version,
                panel_jobs.c.state.in_(("queued", "running")),
            )
            .exists()
        )
        rows = (
            (
                await session.execute(  # type: ignore[attr-defined]
                    sa.select(
                        public_repo_scan_items.c.cached,
                        package_verdicts.c.verdict,
                        active_exists.label("active"),
                    )
                    .select_from(
                        public_repo_scan_items.outerjoin(
                            package_verdicts,
                            sa.and_(
                                package_verdicts.c.name
                                == public_repo_scan_items.c.name,
                                package_verdicts.c.version
                                == public_repo_scan_items.c.version,
                            ),
                        )
                    )
                    .where(public_repo_scan_items.c.scan_id == scan_id)
                )
            )
            .mappings()
            .all()
        )
        return [
            {
                "cached": bool(row["cached"]),
                "verdict": row["verdict"],
                "active": bool(row["active"]),
            }
            for row in rows
        ]


async def public_scan_item_verdicts(session: object, scan_id: int) -> list[str | None]:
    """The per-dep verdicts (``SAFE``/``DANGEROUS``/``None``) covering a scan,
    for :func:`compute_rollup`. Shared by the route's serializer."""
    return list(
        (
            await session.execute(  # type: ignore[attr-defined]
                sa.select(package_verdicts.c.verdict)
                .select_from(
                    public_repo_scan_items.outerjoin(
                        package_verdicts,
                        sa.and_(
                            package_verdicts.c.name == public_repo_scan_items.c.name,
                            package_verdicts.c.version
                            == public_repo_scan_items.c.version,
                        ),
                    )
                )
                .where(public_repo_scan_items.c.scan_id == scan_id)
            )
        )
        .scalars()
        .all()
    )


async def compute_public_scan_rollup(session: object, scan_id: int) -> Rollup:
    """Worst-dep-wins rollup over a public snapshot (reuses :func:`compute_rollup`)."""
    return compute_rollup(await public_scan_item_verdicts(session, scan_id))


__all__ = [
    "CreatePublicRepoScanInput",
    "InvalidPublicRepoReferenceError",
    "PublicRepoReference",
    "PublicRepoScanEngine",
    "compute_public_scan_rollup",
    "parse_public_repo_reference",
    "public_scan_item_verdicts",
]
