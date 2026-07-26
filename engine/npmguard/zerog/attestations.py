"""Publish verified release attestations to the append-only 0G registry."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import structlog
from web3 import Web3

from ..config import Settings

log = structlog.get_logger(__name__)

ATTEST_ABI = [
    {
        "type": "function",
        "name": "attest",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "packageName", "type": "string"},
            {"name": "version", "type": "string"},
            {"name": "nullifier", "type": "bytes32"},
            {"name": "tier", "type": "uint8"},
            {"name": "artifactDigest", "type": "bytes32"},
            {"name": "storageRoot", "type": "bytes32"},
        ],
        "outputs": [],
    }
]


class ZeroGAttestationError(RuntimeError):
    """The registry transaction could not be constructed or confirmed."""


@dataclass(frozen=True)
class PublishedAttestation:
    tx_hash: str
    block_number: int


def _bytes32(value: str, *, field: str) -> bytes:
    """Accept the two integer encodings World uses plus ordinary bytes32 hex."""
    text = value.strip()
    try:
        if text.startswith("0x"):
            raw = bytes.fromhex(text[2:])
        elif text.isdecimal():
            number = int(text)
            if number < 0 or number >= 2**256:
                raise ValueError
            raw = number.to_bytes(32, "big")
        else:
            raise ValueError
    except ValueError as exc:
        raise ZeroGAttestationError(f"{field} is not a valid bytes32 value") from exc
    if len(raw) > 32:
        raise ZeroGAttestationError(f"{field} exceeds 32 bytes")
    return raw.rjust(32, b"\x00")


class ZeroGAttestationPublisher:
    """Relayer for ``NpmGuardAttestations.attest`` on the selected 0G chain.

    The signer is process-local and calls are serialized so two simultaneous
    proofs cannot reserve the same pending nonce. Publication is deliberately
    downstream of durable verification and Storage: callers may use
    :meth:`try_publish` when a chain outage must not discard a valid proof.
    """

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._nonce_lock = asyncio.Lock()

    @property
    def enabled(self) -> bool:
        return self._settings.zerog_attestations_enabled

    def _account(self):
        from eth_account import Account

        return Account.from_key(self._settings.zerog_relayer_key)

    def _web3(self) -> Web3:
        return Web3(
            Web3.HTTPProvider(
                self._settings.zerog_storage_rpc_url,
                request_kwargs={"timeout": 30},
            )
        )

    def _publish(
        self,
        *,
        package_name: str,
        version: str,
        nullifier: str,
        tier: int,
        artifact_digest: str,
        storage_root: str,
    ) -> PublishedAttestation:
        if not self.enabled:
            raise ZeroGAttestationError(
                "0G attestation registry is not configured (relayer key or contract missing)"
            )
        account = self._account()
        web3 = self._web3()
        contract = web3.eth.contract(
            address=Web3.to_checksum_address(self._settings.zerog_attestations_contract),
            abi=ATTEST_ABI,
        )
        function = contract.functions.attest(
            package_name,
            version,
            _bytes32(nullifier, field="nullifier"),
            tier,
            _bytes32(artifact_digest, field="artifact digest"),
            _bytes32(storage_root, field="storage root"),
        )
        transaction = function.build_transaction(
            {
                "from": account.address,
                "nonce": web3.eth.get_transaction_count(account.address, "pending"),
                "chainId": web3.eth.chain_id,
            }
        )
        signed = account.sign_transaction(transaction)
        tx_hash = web3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = web3.eth.wait_for_transaction_receipt(tx_hash, timeout=90, poll_latency=1)
        if receipt.status != 1:
            raise ZeroGAttestationError(f"0G attestation transaction {tx_hash.hex()} reverted")
        return PublishedAttestation(
            tx_hash=tx_hash.hex(),
            block_number=int(receipt.blockNumber),
        )

    async def publish(self, **values: Any) -> PublishedAttestation:
        async with self._nonce_lock:
            return await asyncio.to_thread(self._publish, **values)

    async def try_publish(self, **values: Any) -> PublishedAttestation | None:
        if not self.enabled:
            return None
        try:
            return await self.publish(**values)
        except Exception:
            log.warning(
                "0G attestation publication failed",
                package_name=values.get("package_name"),
                version=values.get("version"),
                exc_info=True,
            )
            return None
