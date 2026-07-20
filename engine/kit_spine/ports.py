"""Capability ports: engine-specific features expressed as small interfaces,
one adapter per engine. Modules program against the port, never against an
engine. Every adapter must pass the shared conformance suite
(modules/spine/e2e/test_notifier_conformance.py) — that suite IS the
contract below, made executable.

EventNotifier semantics:
- notify(channel) wakes every subscriber of that channel "soon" (bounded by
  the adapter's latency: instant for Postgres NOTIFY, one poll interval for
  the polling adapter).
- Subscription.wait(timeout) returns True when the caller should re-query
  the source of truth (a signal or a poll hint), False on a clean timeout.
  A True is a hint, not a delivery — events themselves live in the database.
- Channel names match ^[a-z_][a-z0-9_]{0,62}$ (valid Postgres identifiers).
"""

import re
from typing import Protocol

CHANNEL_PATTERN = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def validate_channel(channel: str) -> str:
    if not CHANNEL_PATTERN.match(channel):
        raise ValueError(f"invalid channel name: {channel!r}")
    return channel


class Subscription(Protocol):
    async def wait(self, timeout: float) -> bool: ...

    async def __aenter__(self) -> "Subscription": ...

    async def __aexit__(self, *exc) -> None: ...


class EventNotifier(Protocol):
    async def start(self) -> None: ...

    async def close(self) -> None: ...

    async def notify(self, channel: str) -> None: ...

    def subscribe(self, channel: str) -> Subscription: ...


def make_notifier(database_url: str) -> EventNotifier:
    """Pick the adapter for the configured engine."""
    from kit_spine.notify_polling import PollingNotifier
    from kit_spine.notify_postgres import PostgresNotifier

    if database_url.startswith("postgresql"):
        return PostgresNotifier(database_url)
    return PollingNotifier()
