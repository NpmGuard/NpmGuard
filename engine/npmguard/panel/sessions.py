"""DB-backed opaque-token panel sessions (port of TS ``session.ts``).

The token is 32 random bytes hex, stored in the HttpOnly ``ng_session`` cookie;
logout is a row delete. Expiry is a 30-day sliding window, extended at most
once per day to avoid write churn. Mirrors ``AuditSessionStore``'s
``async_sessionmaker`` style over the ``gh_sessions`` table and writes ISO
timestamps via the same clock convention as ``now_iso`` (never a SQL DEFAULT).

The clock is injectable (``now``) so the sliding-extend / expiry boundaries are
observable in tests without reading a private clock.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from npmguard.panel.tables import gh_sessions

SESSION_COOKIE = "ng_session"
SESSION_TTL = timedelta(days=30)
EXTEND_THRESHOLD = timedelta(days=1)


def _iso(moment: datetime) -> str:
    # Same wire format as kit_spine.now_iso: millisecond ISO-8601, 'Z' suffix.
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


class PanelSessionStore:
    def __init__(
        self,
        sessions: async_sessionmaker,
        *,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._sessions = sessions
        self._now = now

    async def create(self, user_id: int) -> str:
        """Issue a fresh session for ``user_id`` → the opaque token."""
        token = secrets.token_hex(32)  # 32 bytes → 64 hex chars (String(64))
        now = self._now()
        async with self._sessions() as session, session.begin():
            await session.execute(
                gh_sessions.insert().values(
                    token=token,
                    user_id=user_id,
                    created_at=_iso(now),
                    expires_at=_iso(now + SESSION_TTL),
                )
            )
        return token

    async def get(self, token: str | None) -> int | None:
        """Resolve a token to its ``user_id``. Returns None for an unknown or
        expired token; an expired row is deleted as a side effect."""
        if not token:
            return None
        async with self._sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(gh_sessions.c.user_id, gh_sessions.c.expires_at).where(
                            gh_sessions.c.token == token
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
        if row is None:
            return None

        now = self._now()
        if _parse(row["expires_at"]) <= now:
            await self.delete(token)
            return None

        # Sliding expiry — extend only when the stored expiry lags the target by
        # more than a day, so an active session writes at most once per day.
        target = now + SESSION_TTL
        if target - _parse(row["expires_at"]) > EXTEND_THRESHOLD:
            async with self._sessions() as session, session.begin():
                await session.execute(
                    gh_sessions.update()
                    .where(gh_sessions.c.token == token)
                    .values(expires_at=_iso(target))
                )

        return row["user_id"]

    async def delete(self, token: str) -> None:
        async with self._sessions() as session, session.begin():
            await session.execute(gh_sessions.delete().where(gh_sessions.c.token == token))
