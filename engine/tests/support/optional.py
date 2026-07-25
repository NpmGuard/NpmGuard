"""``present`` — read through an Optional the test has already established.

Contract models mark plenty of fields optional that a real pipeline always
fills (``EvidenceEvent.normalized``, ``Hypothesis.experiment``), and stores
return ``X | None`` for a row a test just wrote. Reading straight through those
works until it does not, and then the failure is a ``TypeError`` on ``None``
pointing at the assertion rather than at the missing thing.
"""

from __future__ import annotations


def present[T](value: T | None, what: str = "value") -> T:
    """``value``, asserted to exist."""
    assert value is not None, f"expected {what} to be present"
    return value
