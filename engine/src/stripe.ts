import Stripe from "stripe";
import { config } from "./config.js";
import { getBillingAccount } from "./billing.js";

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
    allow_promotion_codes: true,
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

export async function createRepoSubscriptionCheckout(params: {
  installationId: number;
  accountLogin: string;
  email?: string | null;
  origin: string;
}): Promise<{ url: string; sessionId: string }> {
  if (!config.stripeProPriceId) {
    throw new Error("Stripe Pro price is not configured (NPMGUARD_STRIPE_PRO_PRICE_ID missing)");
  }
  const stripe = getStripe();
  const billing = getBillingAccount(params.installationId);
  const metadata = {
    kind: "repo_pro_subscription",
    installationId: String(params.installationId),
    accountLogin: params.accountLogin,
  };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: config.stripeProPriceId, quantity: 1 }],
    client_reference_id: String(params.installationId),
    metadata,
    subscription_data: { metadata },
    allow_promotion_codes: true,
    ...(billing?.stripe_customer_id
      ? { customer: billing.stripe_customer_id }
      : params.email
        ? { customer_email: params.email }
        : {}),
    success_url: `${params.origin}/dashboard?billing=success`,
    cancel_url: `${params.origin}/dashboard?billing=cancelled`,
  });
  if (!session.url) throw new Error("Stripe did not return a subscription checkout URL");
  return { url: session.url, sessionId: session.id };
}

export async function createRepoBillingPortal(params: {
  installationId: number;
  returnUrl: string;
}): Promise<string> {
  const billing = getBillingAccount(params.installationId);
  if (!billing?.stripe_customer_id) throw new Error("No Stripe customer exists for this account");
  const session = await getStripe().billingPortal.sessions.create({
    customer: billing.stripe_customer_id,
    return_url: params.returnUrl,
  });
  return session.url;
}

export async function repoSubscriptionPrice(): Promise<{
  amount: number | null;
  currency: string;
  interval: string | null;
} | null> {
  if (!config.stripeProPriceId || !config.stripeSecretKey) return null;
  const price = await getStripe().prices.retrieve(config.stripeProPriceId);
  return {
    amount: price.unit_amount,
    currency: price.currency,
    interval: price.recurring?.interval ?? null,
  };
}

export function constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
  if (!config.stripeWebhookSecret) {
    throw new Error("Stripe webhook secret not configured");
  }
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
}
