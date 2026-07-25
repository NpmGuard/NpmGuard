"""Publisher attestation — the trust boundary for World ID proofs.

Mirrors the rule `payments.py` already enforces for money: **the client collects,
the server decides.** The CLI opens a browser and the browser talks to World App;
neither is ever trusted about what was proven. Every claim that ends up in the
registry is re-verified here, server-side, against World's verify API.

What each release actually proves
---------------------------------
A fresh, live human consented to **one exact tarball**:

    signal = "npmguard:v1:<package>@<version>:<integrity>:<github_user_id>"

bound into the proof and echoed back as ``signal_hash``. We recompute the signal
from our own session state and reject any mismatch, so a proof obtained for one
tarball is worthless for another. Nothing on the maintainer's machine — npm
token, CI secret, GitHub token, a worm holding all three — can produce it.

The document-backed *tier* is a durable property of the human, established once
at enrolment and looked up by nullifier. Re-scanning a passport per release would
prove nothing new, and (because World's IdentityCheck preset accepts no
``signal``) could not be bound to the artifact anyway.
"""

from dataclasses import dataclass
from typing import Any, Literal

import httpx
import structlog
from web3 import Web3

from .config import Settings

log = structlog.get_logger(__name__)

SIGNAL_VERSION = "npmguard:v1"

# Tier ladder. Higher is a stronger claim about the publisher, never about the
# code — an attestation says who pressed publish, not that the tarball is safe.
TIER_HUMAN = 1  # unique human, fresh presence, bound to this artifact
TIER_IDENTITY = 2  # + document-backed credential, 18+
TIER_JURISDICTION = 3  # + declared issuing country (opt-in)

Tier = Literal[1, 2, 3]


class AttestationError(RuntimeError):
    """A proof did not establish what it claimed. Never partially accepted."""


def hash_signal(signal: str) -> str:
    """World's ``hashSignal``, reimplemented for a Python backend.

    Ported from the published ``idkit-core@4.2.2`` bundle (``dist/hashing.js``)
    because the algorithm is not specified anywhere in the docs — see finding
    D-11 in the Identity Check testing document. Two details nobody would guess:

    1. the keccak digest is **shifted right by 8 bits** (a field reduction), and
    2. a string that merely *looks like* hex is decoded as bytes rather than
       encoded as UTF-8.

    Getting either wrong fails closed and looks like "the user's proof is
    invalid" rather than "your hashing is wrong", so this is pinned by tests
    against vectors taken from the reference implementation.
    """
    body = signal[2:] if signal.startswith("0x") else None
    if body and len(body) % 2 == 0 and all(c in "0123456789abcdefABCDEF" for c in body):
        data = bytes.fromhex(body)
    else:
        data = signal.encode("utf-8")
    reduced = int.from_bytes(Web3.keccak(data), "big") >> 8
    return "0x" + format(reduced, "064x")


def _hash_to_field(data: bytes) -> bytes:
    """World's field reduction: ``keccak256(data) >> 8``, as 32 bytes."""
    return (int.from_bytes(Web3.keccak(data), "big") >> 8).to_bytes(32, "big")


# The RP-signature wire format, ported from `@worldcoin/idkit-server@1.1.1`
# (`signRequest` / `computeRpSignatureMessage`). Undocumented and Node-only —
# the reference implementation explicitly refuses to run outside Node — so a
# Python backend has no option but to reimplement it. See finding D-12.
RP_SIGNATURE_MSG_VERSION = 1
RP_SIGNATURE_TTL_SECONDS = 300
_ETHEREUM_MESSAGE_PREFIX = b"\x19Ethereum Signed Message:\n"


def rp_signature_message(
    nonce: bytes, created_at: int, expires_at: int, action: str | None
) -> bytes:
    """The exact bytes an RP signs.

    Layout (49 bytes, plus 32 when an action is present):
        [0]      version
        [1:33]   nonce           (already field-reduced)
        [33:41]  created_at      big-endian uint64
        [41:49]  expires_at      big-endian uint64
        [49:81]  hashToField(action)   — only when an action is given
    """
    if len(nonce) != 32:
        raise AttestationError("rp signature nonce must be 32 bytes")
    message = bytearray(49)
    message[0] = RP_SIGNATURE_MSG_VERSION
    message[1:33] = nonce
    message[33:41] = created_at.to_bytes(8, "big")
    message[41:49] = expires_at.to_bytes(8, "big")
    if action is not None:
        message += _hash_to_field(action.encode("utf-8"))
    return bytes(message)


def sign_rp_request(
    *, signing_key: str, action: str | None, now: int, ttl: int = RP_SIGNATURE_TTL_SECONDS,
    nonce_seed: bytes | None = None,
) -> dict[str, Any]:
    """Produce the ``rp_context`` the browser hands IDKit.

    Signed **server-side only** — this is what stops anyone else's page from
    minting proof requests that look like ours. The signature is EIP-191
    (``\\x19Ethereum Signed Message:\\n<len>`` + message) over secp256k1, with the
    recovery id folded into a 65th byte as ``v = recovery + 27``.

    ``nonce_seed`` exists so tests can pin a vector; production always uses
    fresh randomness.
    """
    from eth_account import Account

    key = signing_key[2:] if signing_key.startswith("0x") else signing_key
    if len(key) != 64 or any(c not in "0123456789abcdefABCDEF" for c in key):
        raise AttestationError("world signing key must be 32 bytes of hex")

    import os

    nonce = _hash_to_field(nonce_seed if nonce_seed is not None else os.urandom(32))
    expires_at = now + ttl
    message = rp_signature_message(nonce, now, expires_at, action)
    digest = Web3.keccak(
        _ETHEREUM_MESSAGE_PREFIX + str(len(message)).encode("ascii") + message
    )
    signed = Account.unsafe_sign_hash(digest, key)
    signature = (
        signed.r.to_bytes(32, "big") + signed.s.to_bytes(32, "big") + bytes([signed.v])
    )
    return {
        "sig": "0x" + signature.hex(),
        "nonce": "0x" + nonce.hex(),
        "createdAt": now,
        "expiresAt": expires_at,
    }


def release_signal(
    *, package_name: str, version: str, integrity: str, github_user_id: str
) -> str:
    """The exact string bound into a release proof.

    Includes the GitHub user id so a proof produced in one authenticated session
    cannot be replayed by a different signed-in user, and the tarball integrity
    so it cannot be replayed onto a different artifact. Versioned because
    changing this format changes every future signal — old attestations stay
    verifiable under the version they were made with.
    """
    for name, value in (
        ("package_name", package_name),
        ("version", version),
        ("integrity", integrity),
        ("github_user_id", github_user_id),
    ):
        if not value:
            raise AttestationError(f"cannot build a release signal without {name}")
    return f"{SIGNAL_VERSION}:{package_name}@{version}:{integrity}:{github_user_id}"


@dataclass(frozen=True)
class VerifiedAttestation:
    """The server's own conclusion about a proof — not the client's claim."""

    nullifier: str
    tier: Tier
    identity_attested: bool
    user_presence: bool
    environment: str
    action: str
    # Issued against a passport/MNC credential — document assurance without any
    # identity attribute being requested or disclosed.
    document_backed: bool = False
    # "4.0", or "3.0" when a legacy proof was allowed. Recorded so a consumer can
    # tell a legacy attestation from a current one rather than having to assume.
    protocol_version: str = "4.0"


def _response_items(payload: Any) -> list[dict[str, Any]]:
    items = payload.get("results") or payload.get("responses") or []
    return [item for item in items if isinstance(item, dict)]


def _nullifier_of(payload: dict[str, Any]) -> str | None:
    top = payload.get("nullifier")
    if isinstance(top, str) and top:
        return top
    for item in _response_items(payload):
        value = item.get("nullifier")
        if isinstance(value, str) and value:
            return value
    return None


def _signal_hashes(payload: dict[str, Any], request_payload: dict[str, Any]) -> set[str]:
    """Every signal_hash the exchange mentions, from the verify response and
    from the proof we forwarded. World echoes it inconsistently across shapes,
    so both are searched and at least one must match."""
    found: set[str] = set()
    for source in (payload, request_payload):
        for container in (source, *_response_items(source)):
            value = container.get("signal_hash")
            if isinstance(value, str) and value:
                found.add(value.lower())
    return found


def _reject_reason(payload: dict[str, Any], *, sent: dict[str, Any]) -> str:
    """Say why World refused, in terms someone can act on.

    World's error body carries a ``code`` plus a human ``detail``; reporting only
    the code cost real debugging time once already — a bare ``validation_error``
    names no field and reads as "your proof was bad" when the actual fault was
    the *shape of our request*. So the detail travels with the code, and the keys
    we sent are logged beside it: for a validation error, what is missing from
    that list IS the diagnosis. Keys only, never values — a proof body is not
    something to spray into logs.
    """
    code = str(payload.get("code") or "verification_failed")
    detail = payload.get("detail") or payload.get("message")
    attribute = payload.get("attribute")
    log.warning(
        "world verify rejected the proof",
        code=code,
        detail=detail,
        attribute=attribute,
        sent_keys=sorted(sent),
    )
    parts = [p for p in (detail, f"attribute {attribute}" if attribute else None) if p]
    return f"World rejected the proof: {code}" + (f" — {'; '.join(map(str, parts))}" if parts else "")


# World's credential issuer schema ids, from the `ResponseItemV4.issuer_schema_id`
# doc comment in idkit-core@4.2.2. The two document issuers are what make a
# credential document-backed.
SCHEMA_PROOF_OF_HUMAN = 1
SCHEMA_SELFIE = 11
SCHEMA_PASSPORT = 9303
SCHEMA_MNC = 9310
DOCUMENT_SCHEMAS = frozenset({SCHEMA_PASSPORT, SCHEMA_MNC})


def _document_backed(payload: dict[str, Any]) -> bool:
    """True when the proof was issued against a document credential.

    Read from `issuer_schema_id` on the response items — a property of the
    credential that produced the proof, not a claim anyone made about it. This is
    also why the document tier needs no identity attributes at all: the schema id
    says a passport backed this proof without disclosing one field of it.
    """
    return any(item.get("issuer_schema_id") in DOCUMENT_SCHEMAS for item in _response_items(payload))


def assign_tier(
    *, identity_attested: bool, document_backed: bool = False, has_jurisdiction: bool = False
) -> Tier:
    """Grade what was actually proven.

    Deliberately conservative: an unattested identity is tier 1, never a
    failure. Proof of human bound to the artifact is the security-critical
    claim and stands on its own; the document tier is presentational assurance
    layered on top.

    Either route reaches tier 2 — an IdentityCheck attestation, or a proof issued
    against a document credential — because they establish the same thing, and
    the second establishes it while disclosing strictly less.
    """
    if not (identity_attested or document_backed):
        return TIER_HUMAN
    return TIER_JURISDICTION if has_jurisdiction else TIER_IDENTITY


class WorldVerifier:
    """Server-side verification against World's v4 verify API."""

    def __init__(self, settings: Settings, *, client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._client = client

    @property
    def enabled(self) -> bool:
        return self._settings.world_enabled

    async def verify(
        self,
        proof_payload: dict[str, Any],
        *,
        expected_signal: str,
        require_user_presence: bool = True,
    ) -> VerifiedAttestation:
        """Verify a proof and return what it established.

        Raises :class:`AttestationError` on any failure. There is no partial
        success: a proof either establishes a bound, present, unique human or it
        establishes nothing.
        """
        if not self.enabled:
            raise AttestationError("World ID is not configured")

        settings = self._settings
        body = {
            **proof_payload,
            "action": settings.world_action,
            "environment": settings.world_environment,
        }
        try:
            payload = await self._post(body)
        except httpx.HTTPError as exc:
            raise AttestationError(f"World verify request failed: {exc}") from exc

        if not payload.get("success"):
            raise AttestationError(_reject_reason(payload, sent=body))

        # The action scopes the nullifier. A proof minted for another action is
        # a different pseudonym namespace and must not be admitted here.
        action = payload.get("action")
        if action is not None and action != settings.world_action:
            raise AttestationError(
                f"proof action {action!r} does not match {settings.world_action!r}"
            )

        expected_hash = hash_signal(expected_signal).lower()
        seen = _signal_hashes(payload, proof_payload)
        if not seen:
            # Without a signal hash the proof is not bound to anything — that is
            # exactly the replayable case this whole design exists to prevent.
            raise AttestationError("proof carries no signal_hash — it is not artifact-bound")
        if expected_hash not in seen:
            raise AttestationError("signal_hash does not match this release")

        presence = bool(
            payload.get("user_presence_completed")
            or proof_payload.get("user_presence_completed")
        )
        if require_user_presence and not presence:
            raise AttestationError("proof did not include a fresh user-presence check")

        nullifier = _nullifier_of(payload)
        if not nullifier:
            raise AttestationError("verified proof carried no nullifier")

        identity_attested = bool(
            payload.get("identity_attested") or proof_payload.get("identity_attested")
        )
        # The issuer schema lives on the response items, which World echoes in
        # whichever half of the exchange carries them.
        document_backed = _document_backed(payload) or _document_backed(proof_payload)
        protocol = str(
            payload.get("protocol_version") or proof_payload.get("protocol_version") or "4.0"
        )
        return VerifiedAttestation(
            nullifier=nullifier,
            tier=assign_tier(
                identity_attested=identity_attested, document_backed=document_backed
            ),
            identity_attested=identity_attested,
            document_backed=document_backed,
            protocol_version=protocol,
            user_presence=presence,
            environment=str(payload.get("environment") or settings.world_environment),
            action=settings.world_action,
        )

    async def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        url = self._settings.world_verify_url
        if self._client is not None:
            response = await self._client.post(url, json=body, timeout=20.0)
        else:
            async with httpx.AsyncClient(timeout=20.0) as client:
                response = await client.post(url, json=body)
        try:
            payload = response.json()
        except ValueError as exc:
            raise AttestationError(
                f"World verify returned non-JSON (HTTP {response.status_code})"
            ) from exc
        if not isinstance(payload, dict):
            raise AttestationError("World verify returned an unexpected body")
        return payload


# --- the public envelope ----------------------------------------------------

# Attribute VALUES must never reach the envelope: it goes to public, immutable
# storage. Only these keys may appear, and `build_envelope` enforces it rather
# than trusting callers.
ENVELOPE_KEYS = frozenset(
    {
        "schemaVersion",
        "package",
        "version",
        "integrity",
        "artifactDigest",
        "nullifier",
        "tier",
        "assertions",
        "action",
        "environment",
        "attestedAt",
        "verifier",
    }
)

# The identity attributes World can return. None of them may ever be persisted
# as a value — see the minimization section of the Identity Check testing doc.
FORBIDDEN_ENVELOPE_VALUES = frozenset(
    {"full_name", "document_number", "nationality", "issuing_country", "document_type"}
)


def artifact_digest(integrity: str) -> str:
    """A 32-byte on-chain handle for the tarball, derived from npm's own
    `dist.integrity`. Keccak of the integrity string keeps the chain row fixed
    width while staying recomputable by anyone holding the package metadata."""
    if not integrity:
        raise AttestationError("cannot derive an artifact digest without an integrity string")
    return "0x" + Web3.keccak(text=integrity).hex().removeprefix("0x")


def build_envelope(
    *,
    package_name: str,
    version: str,
    integrity: str,
    verified: VerifiedAttestation,
    attested_at: str,
    assertions: dict[str, bool],
    verifier: str,
) -> dict[str, Any]:
    """The public evidence record published to 0G Storage.

    Carries booleans, never values: `{"minimum_age>=18": true}` says what was
    proven without saying anything about who proved it. The nullifier is a
    per-app pseudonym and is the only identifier here by design — learning the
    publisher's real identity would add nothing to the security property and
    would turn this into a real-name registry of open-source maintainers.
    """
    bad = {key for key in assertions if key in FORBIDDEN_ENVELOPE_VALUES}
    if bad:
        raise AttestationError(
            f"identity attribute values must never be published: {sorted(bad)}"
        )
    if not all(isinstance(value, bool) for value in assertions.values()):
        raise AttestationError("envelope assertions must be booleans, not attribute values")

    envelope = {
        "schemaVersion": 1,
        "package": package_name,
        "version": version,
        "integrity": integrity,
        "artifactDigest": artifact_digest(integrity),
        "nullifier": verified.nullifier,
        "tier": verified.tier,
        "assertions": dict(sorted(assertions.items())),
        "action": verified.action,
        # Recorded so a reader can tell a staging proof from a real one. A
        # staging attestation carries no real-world assurance and must never be
        # presentable as though it did.
        "environment": verified.environment,
        "attestedAt": attested_at,
        "verifier": verifier,
    }
    unexpected = set(envelope) - ENVELOPE_KEYS
    if unexpected:
        raise AttestationError(f"envelope has unexpected keys: {sorted(unexpected)}")
    return envelope
