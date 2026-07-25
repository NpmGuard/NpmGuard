/**
 * The query client, and the two pieces of HTTP policy that are genuinely
 * cross-cutting.
 *
 * Caching, dedupe, staleness, polling and retry are CONFIGURATION here, not
 * code. Nothing in this file wraps react-query; a wrapper that adds nothing over
 * the library is a god store with a new name.
 *
 * Layering note: this module is the composition root for HTTP policy, which is
 * why it is the one file under `lib/` that reaches into `features/`. The
 * alternative is repeating the same two `onError` bodies in eleven hooks, and
 * "the same policy, restated per call site" is the god-store failure mode one
 * level down.
 */

import type { BillingResponse } from "@npmguard/shared";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { billingKeys } from "../features/billing/keys.ts";
import { patchEntitlements } from "../features/billing/entitlements.ts";
import { githubLoginUrl } from "../features/session/api.ts";
import { usePanelUi } from "../stores/panelStore.ts";
import { ApiError, capBody, isReauth } from "./api-base.ts";
import { ContractViolationError } from "./wire.ts";

/**
 * Whether retrying could possibly change the answer.
 *
 * The default (retry everything three times) is wrong for this API in both
 * directions: it delays a 404 by three round trips, and it hides nothing about a
 * 500. Each `false` below is a claim that the response is a deterministic
 * function of the request.
 */
export function retryable(error: unknown): boolean {
  // Drift is deterministic: the same payload violates the same schema.
  if (error instanceof ContractViolationError) return false;
  if (error instanceof ApiError) {
    // 503 = the GitHub App is unconfigured on this deployment. Every panel route
    // refuses, and will keep refusing until someone edits the server's env.
    if (error.status === 503) return false;
    // 408 request timeout / 429 rate limited are the two 4xx that a later
    // attempt can legitimately answer differently.
    if (error.status === 408 || error.status === 429) return true;
    return error.status >= 500;
  }
  // A transport failure (offline, DNS, aborted) — the one case where the same
  // request really may succeed next time.
  return true;
}

function handleError(error: unknown): void {
  // An expired GitHub token is not an error to render, it is a flow to restart.
  // Handled here so no route has to remember — a per-call-site check is one a
  // branch will eventually be added without.
  if (isReauth(error)) {
    window.location.href = githubLoginUrl();
  }
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Panel reads are cheap to keep and expensive to make (`/panel/repos`
        // paginates live GitHub and probes for lockfiles). 30s of freshness is
        // what turns a navigation between the dashboard and a repo page into
        // zero requests — the thing a hand-rolled `bootedRef` boolean can only
        // approximate.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (attempt, error) => attempt < 2 && retryable(error),
        // A tab left open on the dashboard should not re-paginate GitHub every
        // time it regains focus; an explicit refresh and a mount both still do.
        refetchOnWindowFocus: false,
      },
      mutations: {
        // A mutation is a user's intent, submitted once. Retrying a "start scan"
        // that timed out could enqueue a second set.
        retry: false,
      },
    },
    queryCache: new QueryCache({ onError: handleError }),
    mutationCache: new MutationCache({
      onError: (error) => {
        handleError(error);
        // A cap is one fact with two consequences, so it is handled once here
        // rather than in each of the four mutations that can 402: open the
        // paywall, AND patch the ledger from the fresh entitlements the 402
        // carries. Doing it per-mutation is how you end up with the handler in
        // four places and a fifth that forgot.
        const cap = capBody(error);
        if (cap) {
          usePanelUi.getState().openPaywall(cap);
          client.setQueryData<BillingResponse>(billingKeys.overview(), (billing) =>
            patchEntitlements(billing, cap.entitlements),
          );
        }
      },
    }),
  });
  return client;
}
