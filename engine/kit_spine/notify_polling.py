"""Polling adapter: works on any engine (SQLite included) and across
processes. Same-process notifies wake subscribers instantly via
asyncio.Event; cross-process wake-up is bounded by the poll interval —
wait() returns a poll hint once per interval, prompting a re-query."""

import asyncio
import time

from kit_spine.ports import validate_channel


class _PollingSubscription:
    def __init__(self, notifier: "PollingNotifier", channel: str) -> None:
        self._notifier = notifier
        self._channel = channel
        self._event = asyncio.Event()

    async def wait(self, timeout: float) -> bool:
        interval = self._notifier.poll_interval
        deadline = min(timeout, interval)
        start = time.monotonic()
        try:
            await asyncio.wait_for(self._event.wait(), timeout=deadline)
            self._event.clear()
            return True
        except TimeoutError:
            # Waited a full interval: poll hint. Shorter than an interval:
            # the caller's own timeout expired cleanly.
            return time.monotonic() - start >= interval

    async def __aenter__(self) -> "_PollingSubscription":
        self._notifier._subscriptions.setdefault(self._channel, set()).add(self)
        return self

    async def __aexit__(self, *exc) -> None:
        self._notifier._subscriptions.get(self._channel, set()).discard(self)


class PollingNotifier:
    def __init__(self, poll_interval: float = 0.5) -> None:
        self.poll_interval = poll_interval
        self._subscriptions: dict[str, set[_PollingSubscription]] = {}

    async def start(self) -> None:
        pass

    async def close(self) -> None:
        self._subscriptions.clear()

    async def notify(self, channel: str) -> None:
        validate_channel(channel)
        for subscription in self._subscriptions.get(channel, set()):
            subscription._event.set()

    def subscribe(self, channel: str) -> _PollingSubscription:
        validate_channel(channel)
        return _PollingSubscription(self, channel)
