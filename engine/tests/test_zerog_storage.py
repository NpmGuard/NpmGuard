# CLASS MAP — the 0G Storage put/get wrapper (npmguard/zerog/storage.py).
# Seam: the SDK's Indexer is faked at ZeroGStorage._indexer; ZgFile and
# eth_account run for real (both are offline, pure-local operations).
# Config:   Z1 no relayer key → disabled; put_json refuses, try_put_json is inert
# Content:  Z2 canonicalization is key-order independent (the root hash is a
#              function of the VALUE — a reader must be able to recompute it)
# Upload:   Z3 the signing account reaches the uploader (the SDK drops `signer`
#              and reads opts['account'] instead — this is the trap that makes
#              every documented call fail)
#           Z4 upload error → ZeroGStorageError; no root hash → also an error
# Failure:  Z5 try_put_json swallows failures — a storage outage must never fail
#              an audit or change a verdict
# Download: Z6 round-trip parses; non-JSON payload → typed error
#
# Blackbox: drives the public put_json/get_json/try_put_json surface.

import json

import pytest

from npmguard.config import Settings
from npmguard.zerog import StoredObject, ZeroGStorage, ZeroGStorageError

# Test-only key. Not a secret, never funded — eth_account just needs 32 bytes.
FAKE_KEY = "0x" + "11" * 32


def _settings(**overrides) -> Settings:
    return Settings(_env_file=None, zerog_relayer_key=FAKE_KEY, **overrides)


class FakeIndexer:
    """Records what the wrapper actually hands the SDK."""

    def __init__(self, result=None, error=None, payload=None) -> None:
        self._result = result if result is not None else {"rootHash": "0xroot", "txHash": "0xtx"}
        self._error = error
        self._payload = payload
        self.upload_calls: list[dict] = []

    def upload(self, file, rpc, signer, upload_opts=None, **_):
        self.upload_calls.append(
            {"rpc": rpc, "signer": signer, "opts": upload_opts or {}}
        )
        return self._result, self._error

    def download(self, root_hash, file_path, proof=False, **_):
        if self._error is not None:
            return self._error
        with open(file_path, "wb") as handle:
            handle.write(self._payload)
        return None


def _storage(monkeypatch, indexer: FakeIndexer, settings: Settings | None = None) -> ZeroGStorage:
    storage = ZeroGStorage(settings or _settings())
    monkeypatch.setattr(storage, "_indexer", lambda: indexer)
    return storage


# --- Z1: configuration gate -----------------------------------------------


async def test_without_a_relayer_key_storage_is_inert() -> None:
    """Storage submissions cost gas. With no key there is nothing to pay with,
    so writes are skipped outright rather than half-attempted."""
    storage = ZeroGStorage(Settings(_env_file=None))
    assert not storage.enabled
    with pytest.raises(ZeroGStorageError, match="not configured"):
        await storage.put_json({"a": 1})
    # the best-effort path stays silent — callers on the audit path see nothing
    assert await storage.try_put_json({"a": 1}) is None


# --- Z2: canonical content addressing --------------------------------------


def test_canonical_bytes_do_not_depend_on_key_order() -> None:
    """The root hash must be a function of the value, or a third party cannot
    recompute it from the object we publish."""
    assert ZeroGStorage.canonical({"b": 1, "a": [2, 3]}) == ZeroGStorage.canonical(
        {"a": [2, 3], "b": 1}
    )
    assert ZeroGStorage.canonical({"b": 1, "a": 2}) == b'{"a":2,"b":1}'


# --- Z3: the signer trap ---------------------------------------------------


async def test_the_signing_account_is_passed_where_the_sdk_reads_it(monkeypatch) -> None:
    """0g-storage-sdk 0.4.0 accepts `signer` and drops it — Uploader reads
    opts['account']. If this regresses, every upload dies deep in the SDK with a
    bare 'account is None'."""
    indexer = FakeIndexer()
    storage = _storage(monkeypatch, indexer)

    stored = await storage.put_json({"hello": "world"})
    assert stored == StoredObject(root_hash="0xroot", tx_hash="0xtx")

    call = indexer.upload_calls[0]
    assert call["opts"].get("account") is not None
    assert call["opts"]["account"].address == call["signer"].address
    # passing opts replaces the SDK defaults wholesale, so every key it reads
    # must be present
    for key in ("tags", "finalityRequired", "taskSize", "expectedReplica", "skipTx", "fee"):
        assert key in call["opts"], f"upload opts lost {key}"
    assert call["rpc"] == "https://evmrpc-testnet.0g.ai"


async def test_mainnet_network_moves_the_rpc_and_indexer() -> None:
    settings = _settings(zerog_network="mainnet")
    assert settings.zerog_storage_rpc_url == "https://evmrpc.0g.ai"
    assert settings.zerog_indexer_url == "https://indexer-storage-turbo.0g.ai"


# --- Z4/Z5: failure handling ------------------------------------------------


async def test_upload_error_is_typed(monkeypatch) -> None:
    storage = _storage(monkeypatch, FakeIndexer(error=Exception("node unreachable")))
    with pytest.raises(ZeroGStorageError, match="node unreachable"):
        await storage.put_json({"a": 1})


async def test_a_missing_root_hash_is_not_a_success(monkeypatch) -> None:
    """An upload that returns no root hash stored nothing addressable — treating
    it as success would publish an attestation quoting an empty handle."""
    storage = _storage(monkeypatch, FakeIndexer(result={"txHash": "0xtx"}))
    with pytest.raises(ZeroGStorageError, match="no root hash"):
        await storage.put_json({"a": 1})


async def test_try_put_swallows_failure(monkeypatch) -> None:
    """The mirror is best-effort: a storage outage must never fail an audit."""
    storage = _storage(monkeypatch, FakeIndexer(error=Exception("boom")))
    assert await storage.try_put_json({"a": 1}) is None


# --- Z6: download -----------------------------------------------------------


async def test_round_trip(monkeypatch) -> None:
    payload = {"package": "lodash", "tier": 2}
    indexer = FakeIndexer(payload=ZeroGStorage.canonical(payload))
    storage = _storage(monkeypatch, indexer)
    assert await storage.get_json("0xroot") == payload


async def test_a_non_json_object_is_a_typed_error(monkeypatch) -> None:
    storage = _storage(monkeypatch, FakeIndexer(payload=b"not json"))
    with pytest.raises(ZeroGStorageError, match="not JSON"):
        await storage.get_json("0xroot")


async def test_download_error_is_typed(monkeypatch) -> None:
    storage = _storage(monkeypatch, FakeIndexer(error=Exception("gone")))
    with pytest.raises(ZeroGStorageError, match="gone"):
        await storage.get_json("0xroot")


def test_canonical_round_trips_through_json() -> None:
    payload = {"z": 1, "a": {"n": [1, 2, 3]}}
    assert json.loads(ZeroGStorage.canonical(payload)) == payload
