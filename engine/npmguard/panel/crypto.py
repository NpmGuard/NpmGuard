"""AES-256-GCM encryption for panel secrets at rest.

A faithful port of the TS engine's ``crypto.ts``. Only user OAuth access /
refresh tokens are encrypted at rest — the DB file must never be a credential
dump. Installation tokens are minted on demand and never persisted.

Blob format (byte-for-byte compatible with the TS implementation)::

    base64(iv).base64(tag).base64(ciphertext)

three dot-joined base64 parts, a 12-byte random IV, a 16-byte GCM auth tag.
Node's ``createCipheriv`` exposes the tag separately via ``getAuthTag()``;
Python's :meth:`AESGCM.encrypt` instead returns ``ciphertext || tag``, so we
split the trailing 16 bytes back out on encrypt and re-append them on decrypt
to reproduce the exact same wire format.

The key is ``settings.encryption_key`` — 32 bytes, hex-encoded (64 hex chars,
regex-validated in :class:`~npmguard.config.Settings`).

Plaintext is NEVER included in any error message or log line.
"""

from __future__ import annotations

import base64
import binascii
import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from npmguard.config import get_settings

_IV_LEN = 12
_TAG_LEN = 16


class TokenCryptoError(Exception):
    """A malformed encrypted blob or an auth-tag verification failure.

    Never carries plaintext or key material — only a structural description of
    what was wrong with the blob.
    """


def _key() -> bytes:
    """Return the 32-byte AES key from settings.

    ``get_settings`` is the module seam tests move the key through
    (monkeypatch it to exercise the wrong-key class). The hex shape is already
    enforced by the ``Settings.encryption_key`` regex, so ``bytes.fromhex``
    cannot raise here in a configured engine.
    """
    key_hex = get_settings().encryption_key
    if not key_hex:
        raise TokenCryptoError("NPMGUARD_ENCRYPTION_KEY is required to store secrets")
    return bytes.fromhex(key_hex)


def encrypt(plaintext: str) -> str:
    """Encrypt ``plaintext`` → ``base64(iv).base64(tag).base64(ciphertext)``."""
    iv = os.urandom(_IV_LEN)
    ct_and_tag = AESGCM(_key()).encrypt(iv, plaintext.encode("utf-8"), None)
    # Python appends the tag to the ciphertext; split it back out so the blob
    # matches the TS `[iv, tag, ciphertext]` ordering byte-for-byte.
    ciphertext, tag = ct_and_tag[:-_TAG_LEN], ct_and_tag[-_TAG_LEN:]
    return ".".join(
        base64.b64encode(part).decode("ascii") for part in (iv, tag, ciphertext)
    )


def decrypt(blob: str) -> str:
    """Decrypt a ``base64(iv).base64(tag).base64(ciphertext)`` blob → plaintext.

    Raises :class:`TokenCryptoError` on a malformed blob (wrong part count, bad
    base64, wrong IV/tag length) or on auth-tag verification failure (wrong key
    or tampered ciphertext).
    """
    parts = blob.split(".")
    if len(parts) != 3:
        raise TokenCryptoError(
            f"malformed encrypted blob: expected 3 dot-joined parts, got {len(parts)}"
        )
    try:
        iv, tag, ciphertext = (base64.b64decode(part, validate=True) for part in parts)
    except (binascii.Error, ValueError) as exc:
        raise TokenCryptoError("malformed encrypted blob: invalid base64") from exc
    if len(iv) != _IV_LEN:
        raise TokenCryptoError(
            f"malformed encrypted blob: IV must be {_IV_LEN} bytes, got {len(iv)}"
        )
    if len(tag) != _TAG_LEN:
        raise TokenCryptoError(
            f"malformed encrypted blob: tag must be {_TAG_LEN} bytes, got {len(tag)}"
        )
    try:
        # Re-append the tag: AESGCM.decrypt expects ciphertext || tag.
        plaintext = AESGCM(_key()).decrypt(iv, ciphertext + tag, None)
    except InvalidTag as exc:
        raise TokenCryptoError("auth-tag verification failed") from exc
    return plaintext.decode("utf-8")
