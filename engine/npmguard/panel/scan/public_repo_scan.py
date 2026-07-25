"""Item discovery for the ``public_repo_scan`` origin: any public repo's lockfile.

A public-repo audit is a **read-only snapshot**: a signed-in user points the panel
at any public GitHub repository, and its root lockfile is audited against the
shared verdict cache. Unlike an owned-repo scan there is no repo row, no check run,
and no webhook relationship.

After R-1 the only things this module owns are the SSRF boundary, the cost
ceiling, and the snapshot subject row. Progress, the rollup, the item projection, truncation and the
SSE stream are the shared audit-set entity's — the second progress refresher and
the second rollup call site that used to live here are gone, and so is the
client-side polling loop they fed, because a public set streams on exactly the same
route as an owned-repo set.

Two boundaries remain load-bearing:

- :func:`parse_public_repo_reference` is the **SSRF boundary**. It accepts only a
  GitHub repository *identity* (``owner/repo`` or ``https://github.com/owner/repo``)
  — never an arbitrary fetch URL — and hands back a validated ``owner``/``repo``.
  The bytes are then pulled by the credential-free public octokit + the raw-host
  allow-list in ``github/content.py``; a private repo 404s by construction.
- The set is scoped by its **requester** (D-1): a signed-in user, no App
  installation, no ownership, nothing charged. ``audit_sets.requested_by`` is that
  identity — the key column of ``ix_audit_sets_active_public``, the read
  authorization, and the per-user budget in ``panel/public_limits.py``. The stable
  ``github_repo_id`` remains the set's ``origin_ref``, which is what replaced the
  lowercased ``full_name`` mirror the active-scan uniqueness used to need, and a
  rename still cannot smuggle in a second concurrent audit.

Billing (the one per-origin difference besides discovery): **nobody is billed**.
A public snapshot passes no budget hooks and no ``billed_to``; its ceiling is
cost, bounded per user, and a scan past that ceiling covers less of the lockfile
rather than being refused. What it covers versus what the lockfile held is
recorded on the snapshot row (``dep_count``) so the difference can be stated
instead of hidden.

Its jobs carry the REQUESTER's login as their queue fairness key, because
starving every other user behind one user's monorepo is a scheduling bug, not a
billing decision, and conflating the two is why these jobs were once ``org=None``.
TODO(R-2): they belong in the durable queue's ``public`` lane, which is where
"can never starve paid or panel work" (F-F6) is actually expressible — a lane
built here would be this repo's THIRD queue implementation, the exact mistake
R-1 was done to stop.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from ..audit_set import (
    ORIGIN_PUBLIC_REPO_SCAN,
    AuditSetSpec,
    AuditSetStore,
    dedupe,
)
from ..lockfile import LockfileDep
from ..public_limits import PublicScanLimits
from ..tables import audit_sets, gh_users, public_repo_scans

# GitHub identity grammar (mirrors the TS OWNER_PATTERN / REPO_PATTERN).
_OWNER_PATTERN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$")
_REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_GITHUB_HOST = "github.com"


class InvalidPublicRepoReferenceError(Exception):
    """The input was not a recognizable GitHub repository identity."""

    def __init__(self) -> None:
        super().__init__("Enter a GitHub repository as owner/repo or https://github.com/owner/repo")


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
    if not _OWNER_PATTERN.match(owner) or not _REPO_PATTERN.match(repo) or repo in {".", ".."}:
        raise InvalidPublicRepoReferenceError()
    return PublicRepoReference(owner=owner, repo=repo, full_name=f"{owner}/{repo}")


@dataclass(frozen=True, slots=True)
class CreatePublicRepoScanInput:
    """Everything needed to persist one public-repo snapshot.

    ``deps`` is the parsed lockfile; ``github_repo_id`` is the set's
    ``origin_ref``; the ``owner``/``name``/``full_name`` are the canonical values
    from the GitHub repo response, not the user's input.
    """

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


@dataclass
class PublicRepoScanEngine:
    """Discovers a public repo's items, opens the set, writes the snapshot row."""

    sessions: async_sessionmaker
    limits: PublicScanLimits
    sets: AuditSetStore

    # -- lookups -----------------------------------------------------------

    async def find_running_public_scan(self, user_id: int, github_repo_id: int) -> int | None:
        """The set id of a still-live audit of this repo for this USER, or ``None``.

        Keyed on the stable ``github_repo_id``, so a rename cannot smuggle in a
        second concurrent audit — the case-insensitive ``full_name`` mirror this
        replaced could. The frontend treats a 409 carrying this id as a success:
        the set is already live and streamable.
        """
        async with self.sessions() as session:
            return (
                await session.execute(
                    sa.select(audit_sets.c.id)
                    .where(
                        audit_sets.c.origin == ORIGIN_PUBLIC_REPO_SCAN,
                        audit_sets.c.origin_ref == github_repo_id,
                        audit_sets.c.requested_by == user_id,
                        audit_sets.c.finished_at.is_(None),
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()

    # -- set creation ------------------------------------------------------

    async def create_public_repo_scan(self, data: CreatePublicRepoScanInput) -> int:
        """Open a ``public_repo_scan`` set and persist its snapshot subject row.

        The requester's live-scan concurrency is re-asserted here as the race
        guard, and the ``ix_audit_sets_active_public`` partial unique index is the
        durable guard against two concurrent live audits of one repo by one user.

        The set covers the lockfile's cached verdicts plus at most
        ``new_audit_budget`` misses, so a 900-dep monorepo cannot buy 900 audits.
        ``dep_count`` records what the lockfile actually held, which is the only
        way the difference can be stated later — the set knows what it covers and
        nothing about what it declined to.

        Returns the SET id — which is also the snapshot's id, because ``set_id`` is
        the snapshot's primary key. One id, so ``scanId`` means the same thing on
        every route.
        """
        await self.limits.assert_capacity(data.requested_by)
        set_id = await self.sets.create(
            AuditSetSpec(
                origin=ORIGIN_PUBLIC_REPO_SCAN,
                origin_ref=data.github_repo_id,
                trigger="manual",
                items=data.deps,
                requested_by=data.requested_by,
                # The queue fairness key is the REQUESTER's login, not an org.
                # `billed_org` is not a billing field (money is metered by the
                # budget hooks, which this origin passes none of) — it is what
                # `claim_next` groups on, and leaving it NULL would drop every
                # public scan into one bucket, so one user's 900-dep monorepo
                # would starve every other user's scan.
                billed_org=await self._login_of(data.requested_by),
                max_new_audits=await self.limits.new_audit_budget(data.requested_by),
                commit_sha=data.commit_sha,
            )
        )
        async with self.sessions() as session, session.begin():
            await session.execute(
                public_repo_scans.insert().values(
                    set_id=set_id,
                    github_repo_id=data.github_repo_id,
                    owner=data.owner,
                    name=data.name,
                    full_name=data.full_name,
                    html_url=data.html_url,
                    default_branch=data.default_branch,
                    lockfile_path=data.lockfile_path,
                    lockfile_sha=data.lockfile_sha,
                    dep_count=len(dedupe(data.deps)),
                )
            )
        return set_id

    async def _login_of(self, user_id: int) -> str | None:
        async with self.sessions() as session:
            return (
                await session.execute(sa.select(gh_users.c.login).where(gh_users.c.id == user_id))
            ).scalar_one_or_none()


__all__ = [
    "CreatePublicRepoScanInput",
    "InvalidPublicRepoReferenceError",
    "PublicRepoReference",
    "PublicRepoScanEngine",
    "parse_public_repo_reference",
]
