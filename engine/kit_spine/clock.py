"""Timestamp helper. Envelope `ts` must satisfy the contract's
TIMESTAMP_PATTERN (ISO-8601 with explicit timezone); this is the one way
to mint it."""

from datetime import UTC, datetime


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
