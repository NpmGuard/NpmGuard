import { Hono } from "hono";

import { config, PAYMENT_REQUIRED, STRIPE_ENABLED } from "../config.js";
import { getChainContractAddress, isChainConfigured, readAuditFee } from "../chain.js";
import { NpmGuardError } from "../errors.js";
import { createEmitFn, createSession, finalizeSession } from "../events.js";
import { getPayment, recordPayment } from "../payment-map.js";
import { resolveTarballUrl } from "../phases/resolve.js";
import { runAudit } from "../pipeline.js";
import { saveReport } from "../report-store.js";
import { constructWebhookEvent, createCheckoutSession, verifyCheckoutSession } from "../stripe.js";
import { CheckoutRequest } from "./validation.js";

export const paymentRoutes = new Hono();

// ---------------------------------------------------------------------------
// Stripe checkout
// ---------------------------------------------------------------------------

paymentRoutes.post("/checkout", async (c) => {
  if (!STRIPE_ENABLED) {
    return c.json({ error: "Stripe payments not configured" }, 501);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = CheckoutRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: parsed.error.format() }, 400);
  }

  const version = parsed.data.version || "latest";

  // Validate that the package+version actually exists on npm BEFORE charging
  if (!parsed.data.packageName.startsWith("test-pkg-")) {
    try {
      await resolveTarballUrl(parsed.data.packageName, version);
    } catch {
      return c.json(
        { error: `Package ${parsed.data.packageName}@${version} not found on npm` },
        404,
      );
    }
  }

  const origin = c.req.header("Origin")
    || c.req.header("Referer")?.replace(/\/+$/, "")
    || "https://npmguard.com";

  try {
    const { url, sessionId } = await createCheckoutSession({
      packageName: parsed.data.packageName,
      version,
      email: parsed.data.email,
      origin,
    });
    return c.json({ url, sessionId });
  } catch (err) {
    console.error("[checkout] Stripe session creation failed:", err);
    return c.json({ error: "Payment system error" }, 500);
  }
});

paymentRoutes.get("/checkout/:sessionId/status", async (c) => {
  if (!STRIPE_ENABLED) {
    return c.json({ error: "Stripe payments not configured" }, 501);
  }

  const sessionId = c.req.param("sessionId");

  // Check if webhook already started an audit for this session
  const existing = getPayment(sessionId);
  if (existing) {
    return c.json({
      paid: true,
      packageName: existing.packageName,
      version: existing.version,
      auditId: existing.auditId,
    });
  }

  try {
    const verification = await verifyCheckoutSession(sessionId);
    return c.json({
      paid: verification.paid,
      packageName: verification.packageName,
      version: verification.version,
    });
  } catch (err) {
    console.error("[checkout-status] verification failed:", err);
    return c.json({ error: "Invalid session" }, 400);
  }
});

// ---------------------------------------------------------------------------
// Stripe webhook — can start an audit independently of /audit/stream.
// Shares payment-map state with the streaming endpoint so races don't
// double-start the same audit.
// ---------------------------------------------------------------------------

paymentRoutes.post("/webhooks/stripe", async (c) => {
  if (!STRIPE_ENABLED || !config.stripeWebhookSecret) {
    return c.json({ error: "Webhook not configured" }, 501);
  }

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "Missing signature" }, 400);
  }

  let rawBody: string;
  try {
    rawBody = await c.req.text();
  } catch {
    return c.json({ error: "Cannot read body" }, 400);
  }

  let event: import("stripe").Stripe.Event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    console.warn(
      "[webhook] signature verification failed:",
      err instanceof Error ? err.message : err,
    );
    return c.json({ error: "Invalid signature" }, 400);
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const stripeSession = event.data.object;
      const { packageName, version } = stripeSession.metadata || {};
      console.log(
        `[webhook] checkout.session.completed: ${stripeSession.id} for ${packageName}@${version}`,
      );

      if (!packageName) {
        console.warn(
          `[webhook] checkout.session.completed missing metadata: ${stripeSession.id}`,
        );
        break;
      }

      const existing = getPayment(stripeSession.id);
      if (existing) {
        console.log(`[webhook] audit already started: ${existing.auditId}`);
        break;
      }

      // Client hasn't returned yet — start the audit from the webhook
      console.log(
        `[webhook] starting audit for ${packageName}@${version} (session ${stripeSession.id})`,
      );
      try {
        const auditSession = createSession(packageName);
        const emit = createEmitFn(auditSession.auditId, auditSession.emitter);
        recordPayment(stripeSession.id, auditSession.auditId, packageName, version || "latest");

        runAudit(packageName, emit, auditSession.auditId, version || undefined)
          .then(({ report, cleanup }) => {
            finalizeSession(auditSession.auditId, report);
            saveReport(packageName, version || "latest", report);
            cleanup();
          })
          .catch((err) => {
            console.error(`[webhook] audit failed for ${packageName}:`, err);
            const message = err instanceof Error ? err.message : "Unknown error";
            const code = err instanceof NpmGuardError ? err.code : "NPMGUARD-9999";
            emit("audit_error", { error: message, code, retryable: false });
            finalizeSession(auditSession.auditId, null, message);
          });
      } catch (err) {
        console.error(`[webhook] failed to start audit for ${packageName}:`, err);
        // Return 500 so Stripe retries the webhook later
        return c.json({ error: "Failed to start audit" }, 500);
      }
      break;
    }
    default:
      console.log(`[webhook] unhandled event type: ${event.type}`);
  }

  return c.json({ received: true });
});

// ---------------------------------------------------------------------------
// Public config aggregator — what payment paths the client can use.
// Combines Stripe flag + on-chain fee read, with graceful fallback when the
// chain isn't configured or the RPC fails.
// ---------------------------------------------------------------------------

paymentRoutes.get("/config/public", async (c) => {
  const base = {
    paymentRequired: PAYMENT_REQUIRED,
    paymentEnabled: PAYMENT_REQUIRED,
    stripeEnabled: STRIPE_ENABLED,
    priceCents: config.auditPriceCents,
  };

  if (!isChainConfigured("base-sepolia")) {
    return c.json({ ...base, crypto: null });
  }

  try {
    const fee = await readAuditFee("base-sepolia");
    const contract = getChainContractAddress("base-sepolia");
    return c.json({
      ...base,
      crypto: {
        chain: "base-sepolia",
        chainId: 84532,
        contract,
        auditFeeWei: fee !== null ? fee.toString() : null,
      },
    });
  } catch (err) {
    console.warn(
      "[config] failed to read auditFee:",
      err instanceof Error ? err.message : err,
    );
    return c.json({ ...base, crypto: null });
  }
});
