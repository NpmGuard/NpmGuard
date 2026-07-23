from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Literal
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from kit_spine import now_iso
from kit_spine.db import metadata

audit_sessions = sa.Table(
    "audit_sessions",
    metadata,
    sa.Column("audit_id", sa.String(36), primary_key=True),
    sa.Column("package_name", sa.String(214), nullable=False),
    sa.Column("requested_version", sa.String(128), nullable=True),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("package_path", sa.Text, nullable=True),
    sa.Column("file_contents", sa.JSON, nullable=True),
    sa.Column("report", sa.JSON, nullable=True),
    sa.Column("error", sa.Text, nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
    sa.Column("updated_at", sa.String(64), nullable=False),
    sa.Index("ix_audit_sessions_status", "status"),
)

payment_claims = sa.Table(
    "payment_claims",
    metadata,
    sa.Column("provider", sa.String(32), primary_key=True),
    sa.Column("payment_key", sa.String(128), primary_key=True),
    sa.Column("audit_id", sa.String(36), sa.ForeignKey("audit_sessions.audit_id"), nullable=False),
    sa.Column("package_name", sa.String(214), nullable=False),
    sa.Column("version", sa.String(128), nullable=False),
    sa.Column("requester", sa.String(128), nullable=True),
    sa.Column("created_at", sa.String(64), nullable=False),
)


@dataclass(frozen=True)
class AuditSession:
    audit_id: str
    package_name: str
    requested_version: str | None
    status: Literal["running", "done", "error"]
    package_path: str | None
    file_contents: dict[str, str] | None
    report: dict[str, Any] | None
    error: str | None
    created_at: str
    updated_at: str


def _session(row: sa.RowMapping) -> AuditSession:
    return AuditSession(**{key: row[key] for key in AuditSession.__dataclass_fields__})


class AuditSessionStore:
    def __init__(self, sessions: async_sessionmaker, *, max_running: int = 100) -> None:
        self._sessions = sessions
        self._max_running = max_running

    async def create(self, package_name: str, version: str | None = None) -> AuditSession:
        now = now_iso()
        audit_id = str(uuid4())
        async with self._sessions() as session, session.begin():
            running = (
                await session.execute(
                    sa.select(sa.func.count())
                    .select_from(audit_sessions)
                    .where(audit_sessions.c.status == "running")
                )
            ).scalar_one()
            if running >= self._max_running:
                from .errors import SessionLimitError

                raise SessionLimitError()
            await session.execute(
                audit_sessions.insert().values(
                    audit_id=audit_id,
                    package_name=package_name,
                    requested_version=version,
                    status="running",
                    created_at=now,
                    updated_at=now,
                )
            )
        result = await self.get(audit_id)
        assert result is not None
        return result

    async def get(self, audit_id: str) -> AuditSession | None:
        async with self._sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(audit_sessions).where(audit_sessions.c.audit_id == audit_id)
                    )
                )
                .mappings()
                .one_or_none()
            )
        return _session(row) if row is not None else None

    async def running(self) -> list[AuditSession]:
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    sa.select(audit_sessions).where(audit_sessions.c.status == "running")
                )
            ).mappings()
            return [_session(row) for row in rows]

    async def set_package_path(self, audit_id: str, path: str) -> None:
        await self._update(audit_id, package_path=path)

    async def set_file_contents(
        self, audit_id: str, files: dict[str, str], path: str = "__demo__"
    ) -> None:
        await self._update(audit_id, file_contents=files, package_path=path)

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[AsyncSession]:
        """One open transaction for composing a session-row write with another
        store's write (e.g. kit_stream append(session=...)) so both commit —
        or roll back — together."""
        async with self._sessions() as session, session.begin():
            yield session

    async def finalize(
        self,
        audit_id: str,
        report: dict[str, Any] | None,
        error: str | None = None,
        *,
        session: AsyncSession | None = None,
    ) -> None:
        statement = (
            audit_sessions.update()
            .where(
                audit_sessions.c.audit_id == audit_id,
                audit_sessions.c.status == "running",
            )
            .values(
                report=report,
                error=error,
                status="error" if error else "done",
                updated_at=now_iso(),
            )
        )
        if session is not None:
            rowcount = (await session.execute(statement)).rowcount
        else:
            async with self._sessions() as own, own.begin():
                rowcount = (await own.execute(statement)).rowcount
        # INVARIANT: finalize transitions exactly one row running -> done|error.
        # A missing or already-terminal row is a lifecycle bug — raise loudly,
        # never a silent no-op or a done->error overwrite.
        assert rowcount == 1, (
            f"finalize({audit_id}): matched {rowcount} running rows "
            "(row missing or already terminal)"
        )

    async def _update(self, audit_id: str, **values: Any) -> None:
        values["updated_at"] = now_iso()
        async with self._sessions() as session, session.begin():
            await session.execute(
                audit_sessions.update()
                .where(audit_sessions.c.audit_id == audit_id)
                .values(**values)
            )

    async def payment(self, provider: str, key: str) -> dict[str, Any] | None:
        async with self._sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(payment_claims).where(
                            payment_claims.c.provider == provider,
                            payment_claims.c.payment_key == key,
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
        return dict(row) if row is not None else None

    async def claim_payment(
        self,
        provider: str,
        key: str,
        package_name: str,
        version: str,
        requester: str | None = None,
    ) -> tuple[AuditSession, bool]:
        """Atomically bind a payment proof to exactly one audit session."""
        now = now_iso()
        audit_id = str(uuid4())
        try:
            async with self._sessions() as session, session.begin():
                await session.execute(
                    audit_sessions.insert().values(
                        audit_id=audit_id,
                        package_name=package_name,
                        requested_version=version,
                        status="running",
                        created_at=now,
                        updated_at=now,
                    )
                )
                await session.execute(
                    payment_claims.insert().values(
                        provider=provider,
                        payment_key=key,
                        audit_id=audit_id,
                        package_name=package_name,
                        version=version,
                        requester=requester,
                        created_at=now,
                    )
                )
        except IntegrityError:
            existing = await self.payment(provider, key)
            if existing is None:
                raise
            claimed = await self.get(existing["audit_id"])
            assert claimed is not None
            return claimed, False
        claimed = await self.get(audit_id)
        assert claimed is not None
        return claimed, True
