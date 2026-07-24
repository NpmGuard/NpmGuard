"""Billing routes: Pro subscription checkout + portal + entitlements view.

Port of the TS ``routes/billing.ts``. Wire shapes are §1d of the port plan:

- ``GET  /panel/billing``          → 200 ``BillingResponse`` (accounts / plans /
  ``checkoutEnabled`` / ``price``). 401 not-signed-in. 503 App-disabled.
- ``POST /panel/billing/checkout`` → 200 ``{url, sessionId}`` (Stripe
  subscription checkout). 501 not-configured. 401. 404 unknown installation.
  409 already Pro. 502 Stripe failure.
- ``POST /panel/billing/portal``   → 200 ``{url}``. 401. 404 no-customer /
  unknown installation. 502 Stripe failure.

Every route is gated on ``settings.github_app_enabled`` (503 when off), exactly
like the other panel routers. Entitlements come from ``panel.caps``; this router
only orchestrates the Stripe SDK calls in ``npmguard.payments``.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
import structlog
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from npmguard.panel.billing import checkout_enabled
from npmguard.panel.routes._common import current_user, require_enabled, runtime_of
from npmguard.panel.tables import user_installations
from npmguard.payments import (
    create_repo_billing_portal,
    create_repo_subscription_checkout,
    repo_subscription_price,
)

log = structlog.get_logger("npmguard.panel.billing")

router = APIRouter()


def _not_signed_in() -> JSONResponse:
    return JSONResponse({"error": "Not signed in"}, status_code=401)


def _parse_installation_id(value: Any) -> int | None:
    """Accept a positive integer installation id (int or numeric string)."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


async def _user_has_installation(runtime: Any, user_id: int, installation_id: int) -> bool:
    async with runtime.sessionmaker() as session:
        row = (
            await session.execute(
                sa.select(sa.literal(1))
                .select_from(user_installations)
                .where(
                    user_installations.c.user_id == user_id,
                    user_installations.c.installation_id == installation_id,
                )
                .limit(1)
            )
        ).first()
    return row is not None


async def _installation_id_from_body(request: Request) -> tuple[int | None, JSONResponse | None]:
    """Parse ``{installationId}`` from the JSON body.

    Returns ``(installation_id, None)`` on success, or ``(None, error_response)``
    with a 400 for malformed JSON.
    """
    try:
        body = await request.json()
    except Exception:
        return None, JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return None, JSONResponse({"error": "Invalid JSON body"}, status_code=400)
    return _parse_installation_id(body.get("installationId")), None


@router.get("/panel/billing")
async def panel_billing(request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    settings = runtime.settings
    installation_ids = await runtime.panel_installations.list_installation_ids(user["id"])
    accounts = [
        await runtime.panel_caps.entitlements(installation_id)
        for installation_id in installation_ids
    ]

    price: dict[str, Any] | None = None
    try:
        price = await repo_subscription_price(settings)
    except Exception as err:  # noqa: BLE001 - price is best-effort; never fatal
        log.warning("unable to load Stripe Pro price", error=str(err))

    return JSONResponse(
        {
            "accounts": accounts,
            "plans": runtime.panel_caps.plan_catalog(),
            "checkoutEnabled": checkout_enabled(settings),
            "price": price,
        }
    )


@router.post("/panel/billing/checkout")
async def panel_billing_checkout(request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    settings = runtime.settings
    if not checkout_enabled(settings):
        return JSONResponse(
            {"error": "Pro subscriptions are not configured"}, status_code=501
        )
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    installation_id, error = await _installation_id_from_body(request)
    if error is not None:
        return error
    if installation_id is None or not await _user_has_installation(
        runtime, user["id"], installation_id
    ):
        return JSONResponse({"error": "GitHub account not found"}, status_code=404)

    entitlements = await runtime.panel_caps.entitlements(installation_id)
    if entitlements["plan"] == "pro":
        return JSONResponse(
            {"error": f"{entitlements['accountLogin']} is already on Pro"}, status_code=409
        )

    try:
        billing = await runtime.panel_billing.get_billing_account(installation_id)
        customer_id = billing["stripe_customer_id"] if billing else None
        url, session_id = await create_repo_subscription_checkout(
            settings,
            installation_id=installation_id,
            account_login=entitlements["accountLogin"],
            email=user.get("email"),
            origin=settings.panel_base_url,
            customer_id=customer_id,
        )
    except Exception:
        log.exception("subscription checkout creation failed", installation_id=installation_id)
        return JSONResponse(
            {"error": "Unable to start subscription checkout"}, status_code=502
        )
    return JSONResponse({"url": url, "sessionId": session_id})


@router.post("/panel/billing/portal")
async def panel_billing_portal(request: Request) -> Response:
    runtime = runtime_of(request)
    if (disabled := require_enabled(runtime)) is not None:
        return disabled
    settings = runtime.settings
    user = await current_user(request, runtime)
    if user is None:
        return _not_signed_in()

    installation_id, error = await _installation_id_from_body(request)
    if error is not None:
        return error
    if installation_id is None or not await _user_has_installation(
        runtime, user["id"], installation_id
    ):
        return JSONResponse({"error": "GitHub account not found"}, status_code=404)

    billing = await runtime.panel_billing.get_billing_account(installation_id)
    if not billing or not billing["stripe_customer_id"]:
        return JSONResponse(
            {"error": "No billing account exists for this installation"}, status_code=404
        )

    try:
        url = await create_repo_billing_portal(
            settings,
            customer_id=billing["stripe_customer_id"],
            return_url=f"{settings.panel_base_url}/dashboard",
        )
    except Exception:
        log.exception("billing portal creation failed", installation_id=installation_id)
        return JSONResponse({"error": "Unable to open billing portal"}, status_code=502)
    return JSONResponse({"url": url})


__all__ = ["router"]
