import { Hono } from "hono";

import { getAccountEntitlements, getPlanCatalog } from "../caps.js";
import { config, STRIPE_ENABLED } from "../config.js";
import { getDb } from "../db.js";
import {
  createRepoBillingPortal,
  createRepoSubscriptionCheckout,
  repoSubscriptionPrice,
} from "../stripe.js";
import { requireUser, userHasInstallation } from "./panel.js";

export const billingRoutes = new Hono();

function parseInstallationId(value: unknown): number | null {
  const id = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

billingRoutes.get("/panel/billing", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  const installationIds = (
    getDb()
      .prepare("SELECT installation_id FROM user_installations WHERE user_id = ?")
      .all(user.id) as Array<{ installation_id: number }>
  ).map((row) => row.installation_id);

  let price: Awaited<ReturnType<typeof repoSubscriptionPrice>> = null;
  try {
    price = await repoSubscriptionPrice();
  } catch (err) {
    console.warn(
      "[billing] unable to load Stripe Pro price:",
      err instanceof Error ? err.message : err,
    );
  }

  return c.json({
    accounts: installationIds.map(getAccountEntitlements),
    plans: getPlanCatalog(),
    checkoutEnabled: STRIPE_ENABLED && !!config.stripeProPriceId,
    price,
  });
});

billingRoutes.post("/panel/billing/checkout", async (c) => {
  if (!STRIPE_ENABLED || !config.stripeProPriceId) {
    return c.json({ error: "Pro subscriptions are not configured" }, 501);
  }
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const installationId = parseInstallationId((body as { installationId?: unknown })?.installationId);
  if (!installationId || !userHasInstallation(user.id, installationId)) {
    return c.json({ error: "GitHub account not found" }, 404);
  }

  const entitlements = getAccountEntitlements(installationId);
  if (entitlements.plan === "pro") {
    return c.json({ error: `${entitlements.accountLogin} is already on Pro` }, 409);
  }

  try {
    const session = await createRepoSubscriptionCheckout({
      installationId,
      accountLogin: entitlements.accountLogin,
      email: user.email,
      origin: config.panelBaseUrl,
    });
    return c.json(session);
  } catch (err) {
    console.error(
      "[billing] subscription checkout creation failed:",
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: "Unable to start subscription checkout" }, 502);
  }
});

billingRoutes.post("/panel/billing/portal", async (c) => {
  const user = requireUser(c);
  if (!user) return c.json({ error: "Not signed in" }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const installationId = parseInstallationId((body as { installationId?: unknown })?.installationId);
  if (!installationId || !userHasInstallation(user.id, installationId)) {
    return c.json({ error: "GitHub account not found" }, 404);
  }

  try {
    const url = await createRepoBillingPortal({
      installationId,
      returnUrl: `${config.panelBaseUrl}/dashboard`,
    });
    return c.json({ url });
  } catch (err) {
    console.error(
      "[billing] portal creation failed:",
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: "Unable to open billing portal" }, 502);
  }
});
