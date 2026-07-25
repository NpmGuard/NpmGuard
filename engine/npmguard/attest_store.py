"""Durable state for publisher attestation.

Two lifecycles, kept apart on purpose:

* a **session** is one attempt by one signed-in GitHub user to attest one
  release. It carries the signal the engine will demand, frozen at ownership
  time so verification always compares against what the server decided;
* an **attestation** is the append-only record of what was actually proven.

``record`` is the only writer of the durable record, and it refuses to overwrite
— a release is attested exactly once, matching the on-chain registry.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso

from .attest_tables import attest_sessions, attestations


class AttestationConflict(RuntimeError):
    """This release is already attested. Never resolved by overwriting."""


@dataclass(frozen=True)
class AttestSession:
    id: str
    package_name: str
    version: str
    integrity: str
    status: str
    github_user_id: str | None
    github_login: str | None
    signal: str | None
    error: str | None


@dataclass(frozen=True)
class Attestation:
    package_name: str
    version: str
    nullifier: str
    tier: int
    assertions: dict[str, bool]
    environment: str
    github_login: str | None
    storage_root: str | None
    chain_tx: str | None
    attested_at: str


def _session(row: Any) -> AttestSession:
    return AttestSession(
        id=row.id,
        package_name=row.package_name,
        version=row.version,
        integrity=row.integrity,
        status=row.status,
        github_user_id=row.github_user_id,
        github_login=row.github_login,
        signal=row.signal,
        error=row.error,
    )


def _attestation(row: Any) -> Attestation:
    return Attestation(
        package_name=row.package_name,
        version=row.version,
        nullifier=row.nullifier,
        tier=row.tier,
        assertions=dict(row.assertions or {}),
        environment=row.environment,
        github_login=row.github_login,
        storage_root=row.storage_root,
        chain_tx=row.chain_tx,
        attested_at=row.attested_at,
    )


class AttestStore:
    def __init__(self, sessions: async_sessionmaker) -> None:
        self._sessions = sessions

    # --- sessions ---------------------------------------------------------

    async def create_session(
        self, package_name: str, version: str, integrity: str
    ) -> AttestSession:
        session_id = str(uuid.uuid4())
        now = now_iso()
        async with self._sessions() as db, db.begin():
            await db.execute(
                sa.insert(attest_sessions).values(
                    id=session_id,
                    package_name=package_name,
                    version=version,
                    integrity=integrity,
                    status="created",
                    created_at=now,
                    updated_at=now,
                )
            )
        return AttestSession(
            id=session_id,
            package_name=package_name,
            version=version,
            integrity=integrity,
            status="created",
            github_user_id=None,
            github_login=None,
            signal=None,
            error=None,
        )

    async def get_session(self, session_id: str) -> AttestSession | None:
        async with self._sessions() as db:
            row = (
                await db.execute(
                    sa.select(attest_sessions).where(attest_sessions.c.id == session_id)
                )
            ).one_or_none()
        return _session(row) if row is not None else None

    async def mark_owned(
        self, session_id: str, *, github_user_id: str, github_login: str, signal: str
    ) -> None:
        """Record proven ownership and FREEZE the signal.

        Storing the signal here — not at verification time — is what makes the
        binding the server's decision. Verification only ever compares against
        this value, so a client cannot influence what its proof is checked
        against.
        """
        async with self._sessions() as db, db.begin():
            await db.execute(
                sa.update(attest_sessions)
                .where(attest_sessions.c.id == session_id)
                .values(
                    github_user_id=github_user_id,
                    github_login=github_login,
                    signal=signal,
                    status="owned",
                    error=None,
                    updated_at=now_iso(),
                )
            )

    async def mark_status(self, session_id: str, status: str, error: str | None = None) -> None:
        async with self._sessions() as db, db.begin():
            await db.execute(
                sa.update(attest_sessions)
                .where(attest_sessions.c.id == session_id)
                .values(status=status, error=error, updated_at=now_iso())
            )

    # --- attestations -----------------------------------------------------

    async def record(
        self,
        *,
        package_name: str,
        version: str,
        integrity: str,
        nullifier: str,
        tier: int,
        assertions: dict[str, bool],
        environment: str,
        github_login: str | None,
        attested_at: str,
        storage_root: str | None = None,
        chain_tx: str | None = None,
    ) -> Attestation:
        """Persist one attestation, or refuse.

        The unique constraint is the enforcement point: a second attestation of
        the same release raises rather than overwriting, so local state can
        never disagree with the append-only on-chain registry.
        """
        try:
            async with self._sessions() as db, db.begin():
                await db.execute(
                    sa.insert(attestations).values(
                        package_name=package_name,
                        version=version,
                        integrity=integrity,
                        nullifier=nullifier,
                        tier=tier,
                        assertions=assertions,
                        environment=environment,
                        github_login=github_login,
                        storage_root=storage_root,
                        chain_tx=chain_tx,
                        attested_at=attested_at,
                    )
                )
        except IntegrityError as exc:
            raise AttestationConflict(
                f"{package_name}@{version} is already attested"
            ) from exc
        return Attestation(
            package_name=package_name,
            version=version,
            nullifier=nullifier,
            tier=tier,
            assertions=assertions,
            environment=environment,
            github_login=github_login,
            storage_root=storage_root,
            chain_tx=chain_tx,
            attested_at=attested_at,
        )

    async def attach_publication(
        self, package_name: str, version: str, *, storage_root: str | None, chain_tx: str | None
    ) -> None:
        """Backfill the 0G handles after publishing.

        Separate from ``record`` because publishing is best-effort: an
        attestation is real once verified, and a storage or chain outage must
        not discard it.
        """
        values = {k: v for k, v in (("storage_root", storage_root), ("chain_tx", chain_tx)) if v}
        if not values:
            return
        async with self._sessions() as db, db.begin():
            await db.execute(
                sa.update(attestations)
                .where(
                    attestations.c.package_name == package_name,
                    attestations.c.version == version,
                )
                .values(**values)
            )

    async def for_release(self, package_name: str, version: str) -> Attestation | None:
        async with self._sessions() as db:
            row = (
                await db.execute(
                    sa.select(attestations).where(
                        attestations.c.package_name == package_name,
                        attestations.c.version == version,
                    )
                )
            ).one_or_none()
        return _attestation(row) if row is not None else None

    async def for_package(self, package_name: str) -> list[Attestation]:
        """Every attestation for a package, oldest first — the continuity read."""
        async with self._sessions() as db:
            rows = (
                await db.execute(
                    sa.select(attestations)
                    .where(attestations.c.package_name == package_name)
                    .order_by(attestations.c.attested_at.asc())
                )
            ).all()
        return [_attestation(row) for row in rows]
