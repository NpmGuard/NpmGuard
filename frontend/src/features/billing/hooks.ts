/** Billing reads + the two Stripe redirects. */

import type { BillingResponse } from "@npmguard/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { LoadState } from "../../components/ui/load-state.ts";
import { toLoadState } from "../../lib/query-state.ts";
import { useSignedIn } from "../session/hooks.ts";
import { fetchBilling, openBillingPortal, startProCheckout } from "./api.ts";
import { billingKeys } from "./keys.ts";

/**
 * @param awaitingWebhook after a successful Stripe checkout the redirect races
 *   the `customer.subscription.*` webhook, so the entitlements may still read as
 *   unpaid for a second or two. Polling stops the moment any account reports a
 *   live subscription — a stop condition on the FACT we are waiting for, rather
 *   than the old "poll six times and hope" counter. `subscriptionActive` is the
 *   engine's own derivation, so this never re-decides which of Stripe's statuses
 *   count as paid.
 */
export function useBilling(options?: { awaitingWebhook?: boolean }): LoadState<BillingResponse> {
  const signedIn = useSignedIn();
  const query = useQuery({
    queryKey: billingKeys.overview(),
    queryFn: fetchBilling,
    enabled: signedIn,
    refetchInterval: options?.awaitingWebhook
      ? (q) => (q.state.data?.accounts.some((a) => a.subscriptionActive) ? false : 1800)
      : false,
  });
  return toLoadState(query, "Plan & usage");
}

/** Both Stripe entry points end in a full-page navigation, so there is nothing
 * to invalidate on success — the browser leaves. The mutation exists for its
 * `isPending` (which row is redirecting) and its `error`. */
export function useStartProCheckout() {
  return useMutation({
    mutationFn: startProCheckout,
    onSuccess: ({ url }) => window.location.assign(url),
  });
}

export function useOpenBillingPortal() {
  return useMutation({
    mutationFn: openBillingPortal,
    onSuccess: ({ url }) => window.location.assign(url),
  });
}
