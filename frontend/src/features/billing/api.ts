/** Billing endpoints. The installation IS the billing account (F-E1), so every
 * body here is keyed by `installationId` and never by user. */

import {
  BillingCheckoutResponseSchema,
  BillingPortalResponseSchema,
  BillingResponseSchema,
} from "@npmguard/shared";
import { apiBase } from "../../lib/config.ts";
import { getWire, postWire } from "../../lib/wire.ts";

export function fetchBilling() {
  return getWire(`${apiBase()}/panel/billing`, BillingResponseSchema, "GET /panel/billing");
}

export function startProCheckout(installationId: number) {
  return postWire(
    `${apiBase()}/panel/billing/checkout`,
    BillingCheckoutResponseSchema,
    "POST /panel/billing/checkout",
    { installationId },
    "Could not start checkout",
  );
}

export function openBillingPortal(installationId: number) {
  return postWire(
    `${apiBase()}/panel/billing/portal`,
    BillingPortalResponseSchema,
    "POST /panel/billing/portal",
    { installationId },
    "Could not open the billing portal",
  );
}
