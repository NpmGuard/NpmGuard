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


# ---------------------------------------------------------------------------
# Repo-panel subscription billing (mode='subscription').
#
# Coexists with the one-off audit checkout above: the same Stripe SDK + the same
# ``settings.stripe_api_base`` test seam, but a recurring price and a
# ``metadata.kind == 'repo_pro_subscription'`` marker so the webhook can tell the
# two flows apart. The panel treats an installation as the billing account.
# ---------------------------------------------------------------------------

SUBSCRIPTION_KIND = "repo_pro_subscription"


def _stripe_object_id(value: Any) -> str | None:
    """A Stripe field that is either an id string or an expanded object → its id."""
    if not value:
        return None
    if isinstance(value, str):
        return value
    return _field(value, "id")


def _metadata_installation_id(metadata: Any) -> int | None:
    raw = _field(metadata or {}, "installationId")
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


async def create_repo_subscription_checkout(
    settings: Settings,
    *,
    installation_id: int,
    account_login: str,
    origin: str,
    email: str | None = None,
    customer_id: str | None = None,
) -> tuple[str, str]:
    """Create a Stripe **subscription** checkout for the Pro plan.

    ``metadata.kind == 'repo_pro_subscription'`` (on both the session and the
    subscription) is what :func:`handle_subscription_event` keys on. An existing
    Stripe customer is reused; otherwise the email pre-fills checkout and Stripe
    mints the customer. Returns ``(url, session_id)``.
    """
    if not settings.stripe_pro_price_id:
        raise RuntimeError(
            "Stripe Pro price is not configured (NPMGUARD_STRIPE_PRO_PRICE_ID missing)"
        )
    client = _stripe(settings)
    metadata = {
        "kind": SUBSCRIPTION_KIND,
        "installationId": str(installation_id),
        "accountLogin": account_login,
    }
    parameters: dict[str, Any] = {
        "mode": "subscription",
        "line_items": [{"price": settings.stripe_pro_price_id, "quantity": 1}],
        "client_reference_id": str(installation_id),
        "metadata": metadata,
        "subscription_data": {"metadata": metadata},
        "allow_promotion_codes": True,
        "success_url": f"{origin}/dashboard?billing=success",
        "cancel_url": f"{origin}/dashboard?billing=cancelled",
    }
    if customer_id:
        parameters["customer"] = customer_id
    elif email:
        parameters["customer_email"] = email
    session = await asyncio.to_thread(client.checkout.Session.create, **parameters)
    if not session.url:
        raise RuntimeError("Stripe did not return a subscription checkout URL")
    return session.url, session.id


async def create_repo_billing_portal(
    settings: Settings, *, customer_id: str, return_url: str
) -> str:
    """Open a Stripe billing-portal session for an existing customer → its URL."""
    client = _stripe(settings)
    session = await asyncio.to_thread(
        client.billing_portal.Session.create, customer=customer_id, return_url=return_url
    )
    if not session.url:
        raise RuntimeError("Stripe did not return a billing-portal URL")
    return session.url


async def repo_subscription_price(settings: Settings) -> dict[str, Any] | None:
    """Retrieve the Pro price → ``{amount, currency, interval}`` (``None`` when
    Stripe or the price id is not configured)."""
    if not settings.stripe_pro_price_id or not settings.stripe_secret_key:
        return None
    client = _stripe(settings)
    price = await asyncio.to_thread(client.Price.retrieve, settings.stripe_pro_price_id)
    recurring = _field(price, "recurring")
    return {
        "amount": _field(price, "unit_amount"),
        "currency": _field(price, "currency"),
        "interval": _field(recurring, "interval") if recurring else None,
    }


async def _persist_stripe_subscription(subscription: Any, billing_store: Any) -> bool:
    """Upsert a ``customer.subscription.*`` object against its installation.

    The installation is found first from ``metadata.installationId`` (set when we
    created the checkout), then by the stored ``stripe_subscription_id``. Returns
    ``True`` iff a linked installation was updated.
    """
    installation_id = _metadata_installation_id(_field(subscription, "metadata", {}) or {})
    subscription_id = _field(subscription, "id")
    if installation_id is None:
        installation_id = await billing_store.find_installation_for_subscription(subscription_id)
    if installation_id is None or not await billing_store.installation_exists(installation_id):
        return False
    await billing_store.upsert_subscription(
        installation_id=installation_id,
        customer_id=_stripe_object_id(_field(subscription, "customer")),
        subscription_id=subscription_id,
        status=_field(subscription, "status"),
    )
    return True


async def handle_subscription_event(
    settings: Settings, event: Any, billing_store: Any
) -> dict[str, Any] | None:
    """Process the subscription-billing Stripe events, mutating ``billing_store``.

    Handles ``checkout.session.completed`` (only when
    ``metadata.kind == 'repo_pro_subscription'``) plus
    ``customer.subscription.created/updated/deleted``. Returns a small dict
    describing what changed so the ``/webhooks/stripe`` handler can react, or
    ``None`` when the event is not ours (so the caller can fall through to the
    one-off audit branch). Coexists with the existing one-off checkout webhook.
    """
    event_type = _field(event, "type")
    obj = _field(_field(event, "data"), "object")

    if event_type == "checkout.session.completed":
        metadata = _field(obj, "metadata", {}) or {}
        if _field(metadata, "kind") != SUBSCRIPTION_KIND:
            return None  # a one-off audit checkout — not this handler's concern
        installation_id = _metadata_installation_id(metadata)
        subscription_id = _stripe_object_id(_field(obj, "subscription"))
        if installation_id is None or subscription_id is None:
            return None
        if not await billing_store.installation_exists(installation_id):
            return None
        client = _stripe(settings)
        subscription = await asyncio.to_thread(client.Subscription.retrieve, subscription_id)
        status = _field(subscription, "status") or "active"
        await billing_store.upsert_subscription(
            installation_id=installation_id,
            customer_id=_stripe_object_id(_field(obj, "customer")),
            subscription_id=subscription_id,
            status=status,
        )
        return {
            "kind": "subscription_activated",
            "installationId": installation_id,
            "subscriptionId": subscription_id,
            "status": status,
        }

    if event_type in ("customer.subscription.created", "customer.subscription.updated"):
        if await _persist_stripe_subscription(obj, billing_store):
            return {
                "kind": "subscription_synced",
                "subscriptionId": _field(obj, "id"),
                "status": _field(obj, "status"),
            }
        return None

    if event_type == "customer.subscription.deleted":
        subscription_id = _field(obj, "id")
        if await _persist_stripe_subscription(obj, billing_store):
            return {
                "kind": "subscription_deleted",
                "subscriptionId": subscription_id,
                "status": _field(obj, "status"),
            }
        if await billing_store.update_subscription_status(subscription_id, "canceled"):
            return {
                "kind": "subscription_deleted",
                "subscriptionId": subscription_id,
                "status": "canceled",
            }
        return None

    return None
