"""Postgres adapter: LISTEN/NOTIFY. One dedicated connection listens; wakes
are instant across processes and replicas. NOTIFY carries no payload — it is
a wake-up only; events themselves live in the database."""

import asyncio

import asyncpg

from kit_spine.ports import validate_channel


def _asyncpg_dsn(database_url: str) -> str:
    # SQLAlchemy URLs name the driver (postgresql+asyncpg://); asyncpg doesn't.
    return database_url.replace("postgresql+asyncpg://", "postgresql://", 1)


class _PostgresSubscription:
    def __init__(self, notifier: "PostgresNotifier", channel: str) -> None:
        self._notifier = notifier
        self._channel = channel
        self._event = asyncio.Event()

    async def wait(self, timeout: float) -> bool:
        try:
            await asyncio.wait_for(self._event.wait(), timeout=timeout)
            self._event.clear()
            return True
        except TimeoutError:
            return False

    async def __aenter__(self) -> "_PostgresSubscription":
        await self._notifier._add_subscription(self._channel, self)
        return self

    async def __aexit__(self, *exc) -> None:
        await self._notifier._remove_subscription(self._channel, self)


class PostgresNotifier:
    def __init__(self, database_url: str) -> None:
        self._dsn = _asyncpg_dsn(database_url)
        self._conn: asyncpg.Connection | None = None
        self._subscriptions: dict[str, set[_PostgresSubscription]] = {}

    async def start(self) -> None:
        self._conn = await asyncpg.connect(self._dsn)

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None
        self._subscriptions.clear()

    async def notify(self, channel: str) -> None:
        validate_channel(channel)
        assert self._conn is not None, "call start() first"
        await self._conn.execute("SELECT pg_notify($1, '')", channel)

    def subscribe(self, channel: str) -> _PostgresSubscription:
        validate_channel(channel)
        return _PostgresSubscription(self, channel)

    def _on_notify(self, connection, pid, channel: str, payload: str) -> None:
        for subscription in self._subscriptions.get(channel, set()):
            subscription._event.set()

    async def _add_subscription(self, channel: str, sub: _PostgresSubscription) -> None:
        assert self._conn is not None, "call start() first"
        first = channel not in self._subscriptions or not self._subscriptions[channel]
        self._subscriptions.setdefault(channel, set()).add(sub)
        if first:
            await self._conn.add_listener(channel, self._on_notify)

    async def _remove_subscription(self, channel: str, sub: _PostgresSubscription) -> None:
        subs = self._subscriptions.get(channel, set())
        subs.discard(sub)
        if not subs and self._conn is not None:
            await self._conn.remove_listener(channel, self._on_notify)
