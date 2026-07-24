# CLASS MAP — PanelSessionStore opaque-token sessions (port of TS session.ts)
# (seam: real sqlite DB per test; the clock is INJECTED so the expiry / sliding-
#  extend boundaries are observable without reading a private clock)
# Axes: token issue+resolve, expiry boundary, sliding-extend rate limit, unknown
#   C1 issue → get resolves to the same user_id; token is 64 hex chars (32 bytes)
#   C2 expired token (stored expiry <= now) → get returns None AND deletes the row
#      (a later get can't resurrect it, and no stale row lingers)
#   C3 sliding expiry extends AT MOST once per day: a get inside the 1-day
#      threshold does NOT move expires_at; a get after >1 day of elapsed time
#      moves it once; an immediate repeat get (same clock) does NOT move it again
#   C4 unknown token (and None) → get returns None, no row touched
from datetime import UTC, datetime, timedelta

import pytest
import sqlalchemy as sa

from kit_spine import make_engine, make_session_factory
from kit_spine.db import metadata
from npmguard.panel.sessions import SESSION_TTL, PanelSessionStore
from npmguard.panel.tables import gh_sessions, gh_users


class _Clock:
    """Injectable, hand-advanced clock — the store reads this, tests write it."""

    def __init__(self, start: datetime) -> None:
        self.value = start

    def __call__(self) -> datetime:
        return self.value

    def advance(self, delta: timedelta) -> None:
        self.value += delta


async def _make_store(url: str, clock: _Clock):
    engine = make_engine(url)
    async with engine.begin() as connection:
        await connection.run_sync(metadata.create_all)
    factory = make_session_factory(engine)
    # A real gh_users row: gh_sessions.user_id FKs it (ondelete CASCADE) and
    # sqlite enforces FKs (PRAGMA foreign_keys=ON), so the token needs an owner.
    async with factory() as session, session.begin():
        await session.execute(
            gh_users.insert().values(
                id=4242,
                login="octocat",
                created_at="2026-01-01T00:00:00.000Z",
                updated_at="2026-01-01T00:00:00.000Z",
            )
        )
    return PanelSessionStore(factory, now=clock), engine


async def _stored_expiry(engine, token: str) -> str | None:
    async with engine.connect() as connection:
        return (
            await connection.execute(
                sa.select(gh_sessions.c.expires_at).where(gh_sessions.c.token == token)
            )
        ).scalar_one_or_none()


@pytest.fixture
async def store_engine(tmp_path):
    clock = _Clock(datetime(2026, 7, 24, 12, 0, 0, tzinfo=UTC))
    store, engine = await _make_store(
        f"sqlite+aiosqlite:///{tmp_path / 'panel.sqlite3'}", clock
    )
    yield store, engine, clock
    await engine.dispose()


async def test_issue_then_get_resolves_user(store_engine) -> None:
    """C1: create returns an opaque 32-byte-hex token; get resolves it to the
    issuing user_id."""
    store, _engine, _clock = store_engine
    token = await store.create(4242)
    assert len(token) == 64  # 32 bytes hex
    int(token, 16)  # is hex
    assert await store.get(token) == 4242


async def test_expired_token_returns_none_and_deletes_row(store_engine) -> None:
    """C2: once the clock passes the stored expiry, get returns None and removes
    the row — a second get still returns None and no stale row remains."""
    store, engine, clock = store_engine
    token = await store.create(4242)
    clock.advance(SESSION_TTL + timedelta(seconds=1))  # step past the 30-day window
    assert await store.get(token) is None
    assert await _stored_expiry(engine, token) is None  # row was deleted
    assert await store.get(token) is None  # stays gone


async def test_sliding_expiry_extends_at_most_once_per_day(store_engine) -> None:
    """C3: get inside the 1-day threshold does not move expires_at; a get after
    >1 day elapsed extends it once; an immediate repeat get does not extend it
    again (the once-per-day write-churn guard)."""
    store, engine, clock = store_engine
    token = await store.create(4242)
    initial = await _stored_expiry(engine, token)

    # Inside the threshold: target-expiry < 1 day → no extend.
    clock.advance(timedelta(hours=6))
    await store.get(token)
    assert await _stored_expiry(engine, token) == initial

    # Past the threshold: one extend to now+TTL.
    clock.advance(timedelta(days=2))
    await store.get(token)
    extended = await _stored_expiry(engine, token)
    assert extended != initial

    # Same clock, immediate repeat: already within a day of target → no re-extend.
    await store.get(token)
    assert await _stored_expiry(engine, token) == extended


async def test_unknown_token_returns_none(store_engine) -> None:
    """C4: an unknown token (and a None token) resolves to None."""
    store, _engine, _clock = store_engine
    assert await store.get("deadbeef" * 8) is None
    assert await store.get(None) is None
