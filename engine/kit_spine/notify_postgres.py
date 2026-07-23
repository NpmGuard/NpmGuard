"""Postgres adapter: LISTEN/NOTIFY. One dedicated connection listens; wakes
are instant across processes and replicas. NOTIFY carries no payload — it is
a wake-up only; events themselves live in the database.

The dedicated connection is a single point of failure: a Postgres restart
or failover would otherwise leave every subscriber permanently, silently
deaf. A termination listener reconnects with backoff, re-issues LISTEN for
active channels, and wakes every subscriber once restored — a wake means
"check the database", so a spurious wake after a gap is exactly right."""

import asyncio

import asyncpg
import structlog

from kit_spine.ports import validate_channel

log = structlog.get_logger("kit.notify")

COMMAND_TIMEOUT_SECONDS = 10.0  # bound on every outbound call (CONVENTIONS.md)
RECONNECT_INITIAL_DELAY_SECONDS = 0.5
RECONNECT_MAX_DELAY_SECONDS = 30.0


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
        # serializes LISTEN registration against reconnects AND closes the
        # window where a second subscriber returned before the first's
        # LISTEN round-trip completed (a notify in that window woke nobody)
        self._listen_lock = asyncio.Lock()
        self._reconnect_task: asyncio.Task | None = None
        self._closed = False

    async def start(self) -> None:
        self._closed = False
        self._conn = await self._connect()

    async def close(self) -> None:
        self._closed = True
        if self._reconnect_task is not None:
            self._reconnect_task.cancel()
            self._reconnect_task = None
        if self._conn is not None:
            await self._conn.close()
            self._conn = None
        self._subscriptions.clear()

    async def notify(self, channel: str) -> None:
        validate_channel(channel)
        if self._conn is None:
            raise RuntimeError("PostgresNotifier.notify() before start()")
        await self._conn.execute("SELECT pg_notify($1, '')", channel)

    def subscribe(self, channel: str) -> _PostgresSubscription:
        validate_channel(channel)
        return _PostgresSubscription(self, channel)

    async def _connect(self) -> asyncpg.Connection:
        conn = await asyncpg.connect(self._dsn, command_timeout=COMMAND_TIMEOUT_SECONDS)
        conn.add_termination_listener(self._on_termination)
        return conn

    def _on_termination(self, connection) -> None:
        if self._closed or self._reconnect_task is not None:
            return
        log.warning("notify connection lost — reconnecting")
        self._reconnect_task = asyncio.get_running_loop().create_task(self._reconnect())

    async def _reconnect(self) -> None:
        delay = RECONNECT_INITIAL_DELAY_SECONDS
        try:
            while not self._closed:
                try:
                    conn = await self._connect()
                    async with self._listen_lock:
                        self._conn = conn
                        for channel, subs in self._subscriptions.items():
                            if subs:
                                await conn.add_listener(channel, self._on_notify)
                except (OSError, asyncpg.PostgresError) as error:
                    log.warning(
                        "notify reconnect failed", error=str(error), retry_in_seconds=delay
                    )
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, RECONNECT_MAX_DELAY_SECONDS)
                    continue
                # wakes may have been lost while deaf — wake everyone; a wake
                # only means "check the database", so spurious is safe
                for subs in self._subscriptions.values():
                    for sub in subs:
                        sub._event.set()
                log.info("notify connection restored")
                return
        finally:
            self._reconnect_task = None

    def _on_notify(self, connection, pid, channel: str, payload: str) -> None:
        for subscription in self._subscriptions.get(channel, set()):
            subscription._event.set()

    async def _add_subscription(self, channel: str, sub: _PostgresSubscription) -> None:
        if self._conn is None:
            raise RuntimeError("PostgresNotifier.subscribe() before start()")
        async with self._listen_lock:
            first = not self._subscriptions.get(channel)
            self._subscriptions.setdefault(channel, set()).add(sub)
            if first:
                await self._conn.add_listener(channel, self._on_notify)

    async def _remove_subscription(self, channel: str, sub: _PostgresSubscription) -> None:
        async with self._listen_lock:
            subs = self._subscriptions.get(channel, set())
            subs.discard(sub)
            if not subs and self._conn is not None and not self._conn.is_closed():
                await self._conn.remove_listener(channel, self._on_notify)


def _asyncpg_dsn(database_url: str) -> str:
    # SQLAlchemy URLs name the driver (postgresql+asyncpg://); asyncpg doesn't.
    return database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
