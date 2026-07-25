"""0G Storage: content-addressed JSON put/get.

Objects are canonicalized with RFC 8785 before upload, so the root hash is a
function of the *value* and not of key order or float spelling — a reader who
re-serializes the same object gets the same root and can prove the stored bytes
are the ones we claim.

The SDK is synchronous (blocking `requests` + web3), so every call runs in a
worker thread, the way `payments.py` already treats web3.
"""

import asyncio
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import rfc8785
import structlog

from ..config import Settings

log = structlog.get_logger(__name__)

# Upload options. `Indexer.upload` accepts a `signer` argument and then DROPS it:
# `new_uploader_from_indexer_nodes` never forwards it, and `Uploader.upload_file`
# reads the signing account from `opts['account']` instead. Passing opts at all
# also replaces the SDK's defaults wholesale, so every key the uploader reads has
# to be supplied here. Omitting `account` fails the submission with a bare
# "account is None" deep inside the upload. (0g-storage-sdk 0.4.0)
_UPLOAD_OPTS: dict[str, Any] = {
    "tags": b"\x00",
    "finalityRequired": True,
    "taskSize": 10,
    "expectedReplica": 1,
    "skipTx": False,
    "fee": 0,
}


class ZeroGStorageError(RuntimeError):
    """A 0G Storage operation failed. Callers on the audit path must treat this
    as non-fatal: the engine's own stores are authoritative."""


@dataclass(frozen=True)
class StoredObject:
    """`root_hash` is the content address — the handle everything else quotes.
    `tx_hash` is the storage submission, absent when the node already held the
    content and no new submission was needed."""

    root_hash: str
    tx_hash: str | None = None


class ZeroGStorage:
    """Put/get JSON on 0G Storage. Disabled (and inert) without a relayer key."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def enabled(self) -> bool:
        return self._settings.zerog_storage_enabled

    def _account(self):
        from eth_account import Account

        # never logged, never returned, never rendered
        return Account.from_key(self._settings.zerog_relayer_key)

    def _indexer(self):
        from core import Indexer  # 0g-storage-sdk installs its packages flat

        return Indexer(self._settings.zerog_indexer_url)

    @staticmethod
    def canonical(payload: Any) -> bytes:
        """RFC 8785 canonical JSON — the exact bytes whose merkle root we quote."""
        return rfc8785.dumps(payload)

    def _put(self, data: bytes, filename: str) -> StoredObject:
        from core import ZgFile

        account = self._account()
        indexer = self._indexer()
        result, error = indexer.upload(
            ZgFile.from_bytes(data, filename),
            self._settings.zerog_storage_rpc_url,
            account,
            upload_opts={**_UPLOAD_OPTS, "account": account},
        )
        if error is not None:
            raise ZeroGStorageError(f"0G Storage upload failed: {error}")
        root = (result or {}).get("rootHash")
        if not root:
            raise ZeroGStorageError("0G Storage upload returned no root hash")
        return StoredObject(root_hash=root, tx_hash=(result or {}).get("txHash") or None)

    def _get(self, root_hash: str) -> Any:
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "object.json"
            error = self._indexer().download(root_hash, str(target), True)
            if error is not None:
                raise ZeroGStorageError(f"0G Storage download failed: {error}")
            try:
                return json.loads(target.read_bytes())
            except (OSError, json.JSONDecodeError) as exc:
                raise ZeroGStorageError(f"0G Storage object {root_hash} is not JSON") from exc

    async def put_json(self, payload: Any, *, filename: str = "object.json") -> StoredObject:
        """Canonicalize and upload. Raises ZeroGStorageError on any failure."""
        if not self.enabled:
            raise ZeroGStorageError("0G Storage is not configured (no relayer key)")
        data = self.canonical(payload)
        return await asyncio.to_thread(self._put, data, filename)

    async def get_json(self, root_hash: str) -> Any:
        """Fetch by root hash, verifying the merkle proof."""
        return await asyncio.to_thread(self._get, root_hash)

    async def try_put_json(self, payload: Any, *, filename: str = "object.json") -> StoredObject | None:
        """Best-effort put for callers on the audit path.

        A storage outage must never fail an audit or change a verdict, so this
        swallows every failure and returns None. Anything whose correctness
        depends on the write landing must call `put_json` and handle the error.
        """
        if not self.enabled:
            return None
        try:
            return await self.put_json(payload, filename=filename)
        except Exception:
            log.warning("0G Storage mirror failed", filename=filename, exc_info=True)
            return None
