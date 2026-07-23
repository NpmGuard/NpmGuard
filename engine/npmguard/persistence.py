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
    status: Literal["queued", "running", "done", "error"]
    package_path: str | None
    file_contents: dict[str, str] | None
    report: dict[str, Any] | None
    error: str | None
    created_at: str
    updated_at: str


def _session(row: sa.RowMapping) -> AuditSession:
    return AuditSession(**{key: row[key] for key in AuditSession.__dataclass_fields__})


class AuditSessionStore:
    def __init__(self, sessions: async_sessionmaker) -> None:
        self._sessions = sessions

    async def create(
        self,
        package_name: str,
        version: str | None = None,
        *,
        file_contents: dict[str, str] | None = None,
        package_path: str | None = None,
    ) -> AuditSession:
        # Rows are born 'queued'. The wait-queue bound (queued_count vs queue_size)
        # is enforced by AuditService.reserve() BEFORE create/claim — there is no
        # DB running-count cap here anymore. `file_contents`/`package_path` let the
        # demo path create its tagged row atomically (file_contents IS NOT NULL is
        # the de-facto demo tag; real audits never write file_contents on create).
        now = now_iso()
        audit_id = str(uuid4())
        values: dict[str, Any] = dict(
            audit_id=audit_id,
            package_name=package_name,
            requested_version=version,
            status="queued",
            created_at=now,
            updated_at=now,
        )
        # Only set file_contents/package_path when provided. The JSON column
        # renders an explicit Python None as JSON 'null', which would defeat the
        # `file_contents IS NULL` demo filter — so omit them to keep SQL NULL.
        if file_contents is not None:
            values["file_contents"] = file_contents
        if package_path is not None:
            values["package_path"] = package_path
        async with self._sessions() as session, session.begin():
            await session.execute(audit_sessions.insert().values(**values))
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
        # Excludes demo replays (file_contents IS NOT NULL): those are driven by
        # DemoService, never by AuditService, and must not be swept into 0031
        # restart recovery.
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    sa.select(audit_sessions).where(
                        audit_sessions.c.status == "running",
                        audit_sessions.c.file_contents.is_(None),
                    )
                )
            ).mappings()
            return [_session(row) for row in rows]

    async def queued(self) -> list[AuditSession]:
        # Durable wait-queue rows (excludes demo). Restart recovery re-enqueues
        # these rather than erroring them — a claimed paid audit is never dropped.
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    sa.select(audit_sessions).where(
                        audit_sessions.c.status == "queued",
                        audit_sessions.c.file_contents.is_(None),
                    )
                )
            ).mappings()
            return [_session(row) for row in rows]

    async def queued_count(self) -> int:
        # The real admission bound (checked by AuditService.reserve). Demo rows are
        # excluded so a running demo never eats a real audit's queue slot.
        async with self._sessions() as session:
            return (
                await session.execute(
                    sa.select(sa.func.count())
                    .select_from(audit_sessions)
                    .where(
                        audit_sessions.c.status == "queued",
                        audit_sessions.c.file_contents.is_(None),
                    )
                )
            ).scalar_one()

    async def mark_running(self, audit_id: str) -> bool:
        # Guarded queued->running transition. Returns whether THIS call won it.
        # A rowcount of 0 means the row was closed/reset/already-running between
        # dequeue and here — the worker must skip it, so this is NOT an assert.
        statement = (
            audit_sessions.update()
            .where(
                audit_sessions.c.audit_id == audit_id,
                audit_sessions.c.status == "queued",
            )
            .values(status="running", updated_at=now_iso())
        )
        async with self._sessions() as session, session.begin():
            rowcount = (await session.execute(statement)).rowcount
        return rowcount == 1

    async def reset_to_queued(self, audit_id: str) -> None:
        # Guarded error->queued transition, clearing the terminal payload. Makes a
        # claimed-but-errored paid audit genuinely retryable (submit re-runs it).
        statement = (
            audit_sessions.update()
            .where(
                audit_sessions.c.audit_id == audit_id,
                audit_sessions.c.status == "error",
            )
            .values(status="queued", error=None, report=None, updated_at=now_iso())
        )
        async with self._sessions() as session, session.begin():
            rowcount = (await session.execute(statement)).rowcount
        assert rowcount == 1, (
            f"reset_to_queued({audit_id}): matched {rowcount} error rows "
            "(row missing or not in error state)"
        )

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
                audit_sessions.c.status.in_(("queued", "running")),
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
        # INVARIANT: finalize transitions exactly one non-terminal (queued|running)
        # row -> done|error. A missing or already-terminal row is a lifecycle bug —
        # raise loudly, never a silent no-op or a done->error overwrite. The guard
        # includes 'queued' so close/recovery can finalize a never-run queued row.
        assert rowcount == 1, (
            f"finalize({audit_id}): matched {rowcount} non-terminal rows "
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
                        status="queued",
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
