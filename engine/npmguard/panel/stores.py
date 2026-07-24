"""Panel identity + installation/repo state, persistence.py-style.

Three small DB-backed stores over the panel tables, mirroring
``AuditSessionStore``'s ``async_sessionmaker`` idiom (portable read-then-write
upserts rather than dialect-specific ``ON CONFLICT`` — every write here happens
once per request, so a select+update is cheap and works identically on sqlite
and postgres):

- :class:`GhUserStore` — the GitHub identity (``gh_users``). OAuth access /
  refresh tokens are **AES-GCM encrypted at rest** via ``panel/crypto`` on the
  way in; the ``SessionUser`` projection read out for ``/me`` never touches the
  token columns.
- :class:`InstallationStore` — the authorization cache (``installations`` +
  ``user_installations``). ``/panel/orgs`` mirrors the user's installations from
  GitHub into it; repo-level authorization reads it.
- :class:`RepoStore` — the repo mirror (``repos``). ``/panel/repos`` upserts the
  live GitHub repo list, prunes repos that left an installation, and caches the
  root-lockfile auditability probe. A default-branch change invalidates that
  cache (the old branch's lockfile no longer describes the repo).

Installation access tokens are never persisted here — githubkit mints and
caches them in memory (see ``panel/github/client.py``).
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso
from npmguard.panel.crypto import encrypt
from npmguard.panel.tables import (
    gh_users,
    installations,
    repos,
    user_installations,
)


class GhUserStore:
    """The GitHub identity table (``gh_users``), tokens encrypted at rest."""

    def __init__(self, sessions: async_sessionmaker) -> None:
        self._sessions = sessions

    async def upsert(
        self,
        *,
        user_id: int,
        login: str,
        name: str | None,
        email: str | None,
        avatar_url: str | None,
        access_token: str,
        refresh_token: str | None,
        token_expires_at: str | None,
    ) -> None:
        """Insert or update a user row, encrypting the OAuth tokens.

        ``access_token`` / ``refresh_token`` are plaintext in — they are
        AES-GCM encrypted here and only the ciphertext is written. ``None``
        refresh token → NULL column (App without token expiration).
        """
        now = now_iso()
        values: dict[str, Any] = {
            "login": login,
            "name": name,
            "email": email,
            "avatar_url": avatar_url,
            "access_token_enc": encrypt(access_token),
            "refresh_token_enc": encrypt(refresh_token) if refresh_token else None,
            "token_expires_at": token_expires_at,
            "updated_at": now,
        }
        async with self._sessions() as session, session.begin():
            exists = (
                await session.execute(
                    sa.select(gh_users.c.id).where(gh_users.c.id == user_id)
                )
            ).scalar_one_or_none()
            if exists is None:
                await session.execute(
                    gh_users.insert().values(id=user_id, created_at=now, **values)
                )
            else:
                await session.execute(
                    gh_users.update().where(gh_users.c.id == user_id).values(**values)
                )

    async def get(self, user_id: int) -> dict[str, Any] | None:
        """The ``SessionUser`` projection for ``/me`` — never the token columns."""
        async with self._sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(
                            gh_users.c.id,
                            gh_users.c.login,
                            gh_users.c.name,
                            gh_users.c.email,
                            gh_users.c.avatar_url,
                        ).where(gh_users.c.id == user_id)
                    )
                )
                .mappings()
                .one_or_none()
            )
        if row is None:
            return None
        return {
            "id": row["id"],
            "login": row["login"],
            "name": row["name"],
            "email": row["email"],
            "avatarUrl": row["avatar_url"],
        }


class InstallationStore:
    """The installation authorization cache (``installations`` +
    ``user_installations``)."""

    def __init__(self, sessions: async_sessionmaker) -> None:
        self._sessions = sessions

    async def replace_user_installations(
        self, user_id: int, summaries: list[dict[str, Any]]
    ) -> None:
        """Mirror the user's installations: upsert each and rebuild the
        ``user_installations`` cache for this user atomically.

        ``summaries`` is the wire projection (``id`` / ``accountLogin`` /
        ``accountType`` / ``suspended``) so the route computes the account
        shape once and both the response and the DB agree.
        """
        now = now_iso()
        async with self._sessions() as session, session.begin():
            await session.execute(
                user_installations.delete().where(
                    user_installations.c.user_id == user_id
                )
            )
            for summary in summaries:
                inst_id = summary["id"]
                values = {
                    "account_login": summary["accountLogin"],
                    "account_type": summary["accountType"],
                    "suspended": summary["suspended"],
                    "updated_at": now,
                }
                exists = (
                    await session.execute(
                        sa.select(installations.c.id).where(
                            installations.c.id == inst_id
                        )
                    )
                ).scalar_one_or_none()
                if exists is None:
                    await session.execute(
                        installations.insert().values(
                            id=inst_id, created_at=now, **values
                        )
                    )
                else:
                    await session.execute(
                        installations.update()
                        .where(installations.c.id == inst_id)
                        .values(**values)
                    )
                await session.execute(
                    user_installations.insert().values(
                        user_id=user_id, installation_id=inst_id, refreshed_at=now
                    )
                )

    async def list_installation_ids(self, user_id: int) -> list[int]:
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    sa.select(user_installations.c.installation_id).where(
                        user_installations.c.user_id == user_id
                    )
                )
            ).scalars().all()
        return list(rows)


class RepoStore:
    """The repo mirror (``repos``) + its cached auditability probe."""

    def __init__(self, sessions: async_sessionmaker) -> None:
        self._sessions = sessions

    async def sync_installation_repos(
        self, installation_id: int, summaries: list[dict[str, Any]]
    ) -> None:
        """Upsert the live repo list for one installation and prune departures.

        A default-branch change clears the cached lockfile / auditability
        columns: the old branch's lockfile no longer describes the repo, so the
        next ``/panel/repos`` re-probes. Pruning only runs after a full fetch
        (the caller skips this on a flaky GitHub read), so a transient error
        never drops rows.
        """
        now = now_iso()
        async with self._sessions() as session, session.begin():
            for summary in summaries:
                repo_id = summary["id"]
                values: dict[str, Any] = {
                    "installation_id": installation_id,
                    "owner": summary["owner"],
                    "name": summary["name"],
                    "full_name": summary["full_name"],
                    "private": summary["private"],
                    "default_branch": summary["default_branch"],
                    "updated_at": now,
                }
                previous_branch = (
                    await session.execute(
                        sa.select(repos.c.default_branch).where(repos.c.id == repo_id)
                    )
                ).scalar_one_or_none()
                if previous_branch is None:
                    await session.execute(
                        repos.insert().values(id=repo_id, created_at=now, **values)
                    )
                else:
                    if previous_branch != summary["default_branch"]:
                        values["lockfile_path"] = None
                        values["lockfile_sha"] = None
                        values["auditability_checked_at"] = None
                    await session.execute(
                        repos.update().where(repos.c.id == repo_id).values(**values)
                    )
            keep = {summary["id"] for summary in summaries}
            existing_ids = (
                await session.execute(
                    sa.select(repos.c.id).where(
                        repos.c.installation_id == installation_id
                    )
                )
            ).scalars().all()
            stale = [rid for rid in existing_ids if rid not in keep]
            if stale:
                await session.execute(repos.delete().where(repos.c.id.in_(stale)))

    async def states_for_installation(
        self, installation_id: int
    ) -> dict[int, dict[str, Any]]:
        """The per-repo panel state a ``/panel/repos`` response needs, keyed by
        repo id: ``protected_at`` / ``lockfile_path`` / ``lockfile_sha`` /
        ``auditability_checked_at`` / ``default_branch``."""
        async with self._sessions() as session:
            rows = (
                (
                    await session.execute(
                        sa.select(
                            repos.c.id,
                            repos.c.protected_at,
                            repos.c.lockfile_path,
                            repos.c.lockfile_sha,
                            repos.c.auditability_checked_at,
                            repos.c.default_branch,
                        ).where(repos.c.installation_id == installation_id)
                    )
                )
                .mappings()
                .all()
            )
        return {
            row["id"]: {
                "protected_at": row["protected_at"],
                "lockfile_path": row["lockfile_path"],
                "lockfile_sha": row["lockfile_sha"],
                "auditability_checked_at": row["auditability_checked_at"],
                "default_branch": row["default_branch"],
            }
            for row in rows
        }

    async def set_auditability(
        self,
        repo_id: int,
        *,
        lockfile_path: str | None,
        lockfile_sha: str | None,
        checked_at: str,
    ) -> None:
        """Record a root-lockfile probe result. ``lockfile_path is None`` with a
        set ``checked_at`` is the "confirmed non-auditable" marker the repos
        route filters on."""
        async with self._sessions() as session, session.begin():
            await session.execute(
                repos.update()
                .where(repos.c.id == repo_id)
                .values(
                    lockfile_path=lockfile_path,
                    lockfile_sha=lockfile_sha,
                    auditability_checked_at=checked_at,
                    updated_at=checked_at,
                )
            )
