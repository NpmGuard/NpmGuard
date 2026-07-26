"""0G attestation relayer: encoding, signing boundary and failure isolation."""

from types import SimpleNamespace

import pytest
from hexbytes import HexBytes

from npmguard.config import Settings
from npmguard.zerog import (
    PublishedAttestation,
    ZeroGAttestationError,
    ZeroGAttestationPublisher,
)
from npmguard.zerog.attestations import _bytes32

FAKE_KEY = "0x" + "11" * 32
CONTRACT = "0x" + "22" * 20
NULLIFIER = "0x" + "33" * 32
DIGEST = "0x" + "44" * 32
ROOT = "0x" + "55" * 32


def _settings(**overrides) -> Settings:
    return Settings(
        _env_file=None,
        zerog_relayer_key=FAKE_KEY,
        zerog_attestations_contract=CONTRACT,
        **overrides,
    )


class FakeFunction:
    def __init__(self, eth) -> None:
        self.eth = eth

    def build_transaction(self, base):
        self.eth.built = base
        return {**base, "gas": 100_000, "gasPrice": 1}


class FakeFunctions:
    def __init__(self, eth) -> None:
        self.eth = eth

    def attest(self, *args):
        self.eth.attest_args = args
        return FakeFunction(self.eth)


class FakeEth:
    chain_id = 16602

    def __init__(self, *, status=1) -> None:
        self.status = status
        self.attest_args = None
        self.built = None
        self.sent = None

    def contract(self, *, address, abi):
        self.contract_address = address
        self.abi = abi
        return SimpleNamespace(functions=FakeFunctions(self))

    def get_transaction_count(self, address, block):
        assert block == "pending"
        self.nonce_address = address
        return 7

    def send_raw_transaction(self, raw):
        self.sent = raw
        return HexBytes("0x" + "ab" * 32)

    def wait_for_transaction_receipt(self, tx_hash, *, timeout, poll_latency):
        assert timeout == 90 and poll_latency == 1
        return SimpleNamespace(status=self.status, blockNumber=42)


class FakeWeb3:
    def __init__(self, *, status=1) -> None:
        self.eth = FakeEth(status=status)


class FakeAccount:
    address = "0x" + "11" * 20

    def sign_transaction(self, transaction):
        self.transaction = transaction
        return SimpleNamespace(raw_transaction=b"signed")


def _publisher(monkeypatch, *, status=1):
    publisher = ZeroGAttestationPublisher(_settings())
    web3 = FakeWeb3(status=status)
    account = FakeAccount()
    monkeypatch.setattr(publisher, "_web3", lambda: web3)
    monkeypatch.setattr(publisher, "_account", lambda: account)
    return publisher, web3, account


def test_bytes32_accepts_hex_and_decimal_but_rejects_text() -> None:
    assert _bytes32("0x01", field="value") == b"\x00" * 31 + b"\x01"
    assert _bytes32("1", field="value") == b"\x00" * 31 + b"\x01"
    with pytest.raises(ZeroGAttestationError, match="valid bytes32"):
        _bytes32("not-a-nullifier", field="value")
    with pytest.raises(ZeroGAttestationError, match="exceeds"):
        _bytes32("0x" + "11" * 33, field="value")


async def test_publish_submits_the_exact_release_binding(monkeypatch) -> None:
    publisher, web3, account = _publisher(monkeypatch)
    result = await publisher.publish(
        package_name="left-pad",
        version="1.3.0",
        nullifier=NULLIFIER,
        tier=2,
        artifact_digest=DIGEST,
        storage_root=ROOT,
    )

    assert result == PublishedAttestation(tx_hash="ab" * 32, block_number=42)
    assert web3.eth.attest_args == (
        "left-pad",
        "1.3.0",
        bytes.fromhex(NULLIFIER[2:]),
        2,
        bytes.fromhex(DIGEST[2:]),
        bytes.fromhex(ROOT[2:]),
    )
    assert web3.eth.built["chainId"] == 16602
    assert web3.eth.built["nonce"] == 7
    assert account.transaction["gas"] == 100_000
    assert web3.eth.sent == b"signed"


async def test_try_publish_contains_a_chain_failure(monkeypatch) -> None:
    publisher, _, _ = _publisher(monkeypatch, status=0)
    values = {
        "package_name": "left-pad",
        "version": "1.3.0",
        "nullifier": NULLIFIER,
        "tier": 1,
        "artifact_digest": DIGEST,
        "storage_root": ROOT,
    }
    assert await publisher.try_publish(**values) is None
    with pytest.raises(ZeroGAttestationError, match="reverted"):
        await publisher.publish(**values)


async def test_unconfigured_publisher_is_inert() -> None:
    publisher = ZeroGAttestationPublisher(Settings(_env_file=None))
    assert not publisher.enabled
    assert await publisher.try_publish() is None
