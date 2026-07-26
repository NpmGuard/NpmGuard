"""0G integration: decentralized storage for evidence that must outlive us.

The engine's own stores stay authoritative — `report_store` for verdicts, SQL for
sessions and claims. What lands on 0G is the material whose *value depends on
NpmGuard not being able to quietly rewrite it*: publisher-attestation envelopes,
and (optionally) a mirror of each audit report.
"""

from .attestations import (
    PublishedAttestation,
    ZeroGAttestationError,
    ZeroGAttestationPublisher,
)
from .storage import StoredObject, ZeroGStorage, ZeroGStorageError

__all__ = [
    "PublishedAttestation",
    "StoredObject",
    "ZeroGAttestationError",
    "ZeroGAttestationPublisher",
    "ZeroGStorage",
    "ZeroGStorageError",
]
