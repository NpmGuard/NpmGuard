import asyncio
from dataclasses import dataclass
from typing import Any, Literal

import stripe
from web3 import Web3

from .config import Settings

SupportedChain = Literal["base-sepolia", "base"]
AUDIT_EVENT_TOPIC = Web3.keccak(text="AuditRequested(string,string,address,uint256)").hex()
AUDIT_FEE_ABI = [
    {
        "type": "function",
        "name": "auditFee",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
    }
]


class ChainVerificationError(ValueError):
    pass


@dataclass(frozen=True)
class VerifiedPayment:
    package_name: str
    version: str
    requester: str
    fee_paid: int
    block_number: int
    explorer_url: str


def _chain(settings: Settings, chain: SupportedChain) -> tuple[str, str, str] | None:
    if chain == "base-sepolia":
        contract = settings.base_sepolia_contract
        return (
            (
                settings.base_sepolia_rpc_url or "https://sepolia.base.org",
                contract,
                "https://sepolia.basescan.org",
            )
            if contract
            else None
        )
    contract = settings.base_contract
    return (
        (settings.base_rpc_url or "https://mainnet.base.org", contract, "https://basescan.org")
        if contract
        else None
    )


def is_chain_configured(settings: Settings, chain: SupportedChain) -> bool:
    return _chain(settings, chain) is not None


def chain_contract(settings: Settings, chain: SupportedChain) -> str | None:
    configured = _chain(settings, chain)
    return configured[1] if configured else None


async def verify_audit_payment(
    settings: Settings, chain: SupportedChain, tx_hash: str, package_name: str, version: str
) -> VerifiedPayment:
    configured = _chain(settings, chain)
    if configured is None:
        raise ChainVerificationError(f"Chain {chain} is not configured (missing contract address)")
    rpc, contract, explorer = configured
    web3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 30}))
    try:
        receipt = await asyncio.to_thread(web3.eth.wait_for_transaction_receipt, tx_hash, 30, 2)
    except Exception as exc:
        raise ChainVerificationError(f"Could not fetch receipt for {tx_hash}: {exc}") from exc
    if receipt.status != 1:
        raise ChainVerificationError(f"Transaction {tx_hash} reverted")
    relevant = [log for log in receipt.logs if log["address"].lower() == contract.lower()]
    if not relevant:
        raise ChainVerificationError(
            f"Transaction {tx_hash} did not interact with audit contract {contract}"
        )
    match = None
    for log in relevant:
        topics = [topic.hex() for topic in log["topics"]]
        if not topics or topics[0].lower() != AUDIT_EVENT_TOPIC.lower() or len(topics) < 2:
            continue
        try:
            decoded_name, decoded_version, fee = web3.codec.decode(
                ["string", "string", "uint256"], bytes(log["data"])
            )
            requester = Web3.to_checksum_address("0x" + topics[1][-40:])
        except Exception:
            continue
        if decoded_name == package_name and decoded_version == version:
            match = (requester, int(fee))
            break
    if match is None:
        raise ChainVerificationError(
            f"No matching AuditRequested({package_name}, {version}) event in tx {tx_hash}"
        )
    return VerifiedPayment(
        package_name,
        version,
        match[0],
        match[1],
        int(receipt.blockNumber),
        f"{explorer}/tx/{tx_hash}",
    )


async def read_audit_fee(settings: Settings, chain: SupportedChain) -> int | None:
    configured = _chain(settings, chain)
    if configured is None:
        return None
    rpc, address, _ = configured
    web3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 10}))
    contract = web3.eth.contract(address=Web3.to_checksum_address(address), abi=AUDIT_FEE_ABI)
    return int(await asyncio.to_thread(contract.functions.auditFee().call))


def _field(value: Any, name: str, default: Any = None) -> Any:
    """Read a field from a dict or a stripe StripeObject (not dict-like since 15.x)."""
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _stripe(settings: Settings):
    if not settings.stripe_secret_key:
        raise RuntimeError("Stripe is not configured (NPMGUARD_STRIPE_SECRET_KEY missing)")
    stripe.api_key = settings.stripe_secret_key
    if settings.stripe_api_base:
        stripe.api_base = settings.stripe_api_base
    return stripe


async def create_checkout_session(
    settings: Settings, *, package_name: str, version: str, email: str | None, origin: str
) -> tuple[str, str]:
    client = _stripe(settings)
    parameters: dict[str, Any] = {
        "mode": "payment",
        "line_items": [
            {
                "price_data": {
                    "currency": "usd",
                    "unit_amount": settings.audit_price_cents,
                    "product_data": {
                        "name": "NpmGuard Security Audit",
                        "description": f"{package_name}@{version}",
                    },
                },
                "quantity": 1,
            }
        ],
        "metadata": {"packageName": package_name, "version": version},
        "allow_promotion_codes": True,
        "success_url": f"{origin}/audit?session_id={{CHECKOUT_SESSION_ID}}",
        "cancel_url": origin,
    }
    if email:
        parameters["customer_email"] = email
    session = await asyncio.to_thread(client.checkout.Session.create, **parameters)
    if not session.url:
        raise RuntimeError("Stripe did not return a checkout URL")
    return session.url, session.id


async def verify_checkout_session(settings: Settings, session_id: str) -> dict[str, Any]:
    client = _stripe(settings)
    session = await asyncio.to_thread(client.checkout.Session.retrieve, session_id)
    metadata = session.metadata or {}
    package_name = _field(metadata, "packageName")
    version = _field(metadata, "version")
    if not package_name or not version:
        raise RuntimeError("Checkout session missing package metadata")
    return {
        "paid": session.payment_status == "paid",
        "packageName": package_name,
        "version": version,
        "email": session.customer_email,
    }


def construct_webhook_event(settings: Settings, body: bytes, signature: str):
    if not settings.stripe_webhook_secret:
        raise RuntimeError("Stripe webhook secret not configured")
    return _stripe(settings).Webhook.construct_event(
        body, signature, settings.stripe_webhook_secret
    )
