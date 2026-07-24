"""Subscription-billing state over ``billing_accounts``.

Port of the TS ``billing.ts`` (state) — the counterpart to the Stripe SDK calls
in :mod:`npmguard.payments`. An installation is the billing account, so every
row is keyed by ``installation_id``.

Division of labour:

- **entitlements** (plan, quota buckets) live in :mod:`npmguard.panel.caps` —
  ``BillingStore`` only exposes the raw Stripe linkage (customer / subscription
  ids + ``subscription_status``). ``caps`` reads ``subscription_status`` to
  resolve ``plan='pro'`` iff it is ``active``/``trialing``.
- the Stripe API calls (checkout, portal, price, webhook fan-out) live in
  :mod:`npmguard.payments`; ``handle_subscription_event`` there mutates this
  store through the duck-typed methods below.

Writes use the portable read-then-write upsert idiom (mirroring the other panel
stores) rather than a dialect-specific ``ON CONFLICT``, so behaviour is
identical on sqlite and postgres.
"""

from __future__ import annotations

import asyncio
from typing import Any

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import async_sessionmaker

from kit_spine import now_iso

from ..config import Settings
from .tables import billing_accounts, installations


def checkout_enabled(settings: Settings) -> bool:
    """Whether Pro subscription checkout can be offered — the ``checkoutEnabled``
    flag in the ``/panel/billing`` response. Requires BOTH a Stripe secret key
    and a configured recurring price id."""
    return bool(settings.stripe_secret_key and settings.stripe_pro_price_id)


class BillingStore:
    """DB-backed Stripe linkage for each installation (``billing_accounts``)."""

    def __init__(self, sessions: async_sessionmaker) -> None:
        self._sessions = sessions

    async def get_billing_account(self, installation_id: int) -> dict[str, Any] | None:
        """The billing row for an installation, or ``None`` when never linked."""
        async with self._sessions() as session:
            row = (
                (
                    await session.execute(
                        sa.select(
                            billing_accounts.c.installation_id,
                            billing_accounts.c.stripe_customer_id,
                            billing_accounts.c.stripe_subscription_id,
                            billing_accounts.c.subscription_status,
                        ).where(billing_accounts.c.installation_id == installation_id)
                    )
                )
                .mappings()
                .one_or_none()
            )
        return dict(row) if row is not None else None

    async def installation_exists(self, installation_id: int) -> bool:
        """Whether the installation is known — a webhook must never write a
        billing row for an installation the App no longer has."""
        async with self._sessions() as session:
            row = (
                await session.execute(
                    sa.select(sa.literal(1))
                    .select_from(installations)
                    .where(installations.c.id == installation_id)
                    .limit(1)
                )
            ).first()
        return row is not None

    async def find_installation_for_subscription(self, subscription_id: str | None) -> int | None:
        """Reverse-lookup an installation from a Stripe subscription id."""
        if not subscription_id:
            return None
        async with self._sessions() as session:
            return (
                await session.execute(
                    sa.select(billing_accounts.c.installation_id).where(
                        billing_accounts.c.stripe_subscription_id == subscription_id
                    )
                )
            ).scalar_one_or_none()

    async def upsert_subscription(
        self,
        *,
        installation_id: int,
        customer_id: str | None,
        subscription_id: str,
        status: str,
    ) -> None:
        """Insert or update the installation's subscription linkage.

        ``customer_id`` is COALESCE'd (a ``None`` on update keeps the stored
        customer) — a ``customer.subscription.updated`` event carries the
        customer, but some payloads may not, and losing it would break the
        billing portal. ``subscription_id`` and ``status`` always overwrite.
        """
        now = now_iso()
        async with self._sessions() as session, session.begin():
            existing = (
                (
                    await session.execute(
                        sa.select(billing_accounts.c.stripe_customer_id).where(
                            billing_accounts.c.installation_id == installation_id
                        )
                    )
                )
                .mappings()
                .one_or_none()
            )
            if existing is None:
                await session.execute(
                    billing_accounts.insert().values(
                        installation_id=installation_id,
                        stripe_customer_id=customer_id,
                        stripe_subscription_id=subscription_id,
                        subscription_status=status,
                        created_at=now,
                        updated_at=now,
                    )
                )
            else:
                await session.execute(
                    billing_accounts.update()
                    .where(billing_accounts.c.installation_id == installation_id)
                    .values(
                        stripe_customer_id=(
                            customer_id
                            if customer_id is not None
                            else existing["stripe_customer_id"]
                        ),
                        stripe_subscription_id=subscription_id,
                        subscription_status=status,
                        updated_at=now,
                    )
                )

    async def update_subscription_status(self, subscription_id: str, status: str) -> bool:
        """Set the status for a subscription id → ``True`` iff a row matched."""
        async with self._sessions() as session, session.begin():
            result = await session.execute(
                billing_accounts.update()
                .where(billing_accounts.c.stripe_subscription_id == subscription_id)
                .values(subscription_status=status, updated_at=now_iso())
            )
        return result.rowcount > 0

    async def get_or_create_customer(
        self, settings: Settings, installation_id: int, *, email: str | None = None
    ) -> str:
        """Return the installation's Stripe customer id, creating one if absent.

        Imported lazily to avoid a circular import (``payments`` has no panel
        dependencies). The new customer id is persisted so the billing portal and
        future checkouts reuse it.
        """
        existing = await self.get_billing_account(installation_id)
        if existing and existing["stripe_customer_id"]:
            return existing["stripe_customer_id"]

        from ..payments import _stripe  # local import: payments must stay panel-free

        client = _stripe(settings)
        customer = await asyncio.to_thread(
            client.Customer.create,
            email=email,
            metadata={"installationId": str(installation_id)},
        )
        customer_id = customer.id
        now = now_iso()
        async with self._sessions() as session, session.begin():
            if existing is None:
                await session.execute(
                    billing_accounts.insert().values(
                        installation_id=installation_id,
                        stripe_customer_id=customer_id,
                        subscription_status="inactive",
                        created_at=now,
                        updated_at=now,
                    )
                )
            else:
                await session.execute(
                    billing_accounts.update()
                    .where(billing_accounts.c.installation_id == installation_id)
                    .values(stripe_customer_id=customer_id, updated_at=now)
                )
        return customer_id


__all__ = ["BillingStore", "checkout_enabled"]
