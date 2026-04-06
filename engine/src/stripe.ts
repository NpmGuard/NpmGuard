import Stripe from "stripe";
import { config } from "./config.js";

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (!config.stripeSecretKey) {
    throw new Error("Stripe is not configured (NPMGUARD_STRIPE_SECRET_KEY missing)");
  }
  if (!stripeInstance) {
    stripeInstance = new Stripe(config.stripeSecretKey);
  }
  return stripeInstance;
}

export async function createCheckoutSession(params: {
  packageName: string;
  version: string;
  email?: string;
  origin: string;
}): Promise<{ url: string; sessionId: string }> {
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: config.auditPriceCents,
          product_data: {
            name: "NpmGuard Security Audit",
            description: `${params.packageName}@${params.version}`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      packageName: params.packageName,
      version: params.version,
    },
    ...(params.email && { customer_email: params.email }),
    success_url: `${params.origin}/audit?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: params.origin,
  });

  if (!session.url) {
    throw new Error("Stripe did not return a checkout URL");
  }

  return { url: session.url, sessionId: session.id };
}

export async function verifyCheckoutSession(sessionId: string): Promise<{
  paid: boolean;
  packageName: string;
  version: string;
  email: string | null;
}> {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionId);

  const packageName = session.metadata?.packageName;
  const version = session.metadata?.version;

  if (!packageName || !version) {
    throw new Error("Checkout session missing package metadata");
  }

  return {
    paid: session.payment_status === "paid",
    packageName,
    version,
    email: session.customer_email ?? null,
  };
}

export function constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
  if (!config.stripeWebhookSecret) {
    throw new Error("Stripe webhook secret not configured");
  }
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}
