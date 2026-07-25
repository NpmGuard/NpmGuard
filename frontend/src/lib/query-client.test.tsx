/**
 * Unit: the central HTTP policy — query-client.ts.
 *
 * These are the three behaviours the deleted `panelStore.test.ts` covered as
 * store branches (P1 reauth, P2 cap→paywall+patch, and retry policy). They are
 * still the contract; they have simply moved from five hand-written `catch`
 * blocks to one place, and that is exactly why they are worth testing here: the
 * old version checked `isReauth` in two of five branches of `refresh()` and
 * nowhere else, and nothing could have caught the omission.
 *
 * Input classes:
 *  P1  401 reauth → redirect  — an expired GitHub token hard-redirects to the OAuth
 *                               entry point, from a QUERY and from a MUTATION alike.
 *                               A plain 401 (signed out) must NOT redirect.
 *  P2  402 cap → paywall + patch — a cap opens the paywall AND replaces the matching
 *                               account's entitlements IN PLACE from the fresh copy
 *                               the 402 carries. Other accounts are untouched and the
 *                               order is preserved, because the ledger is a list a
 *                               person reads.
 *  P3  patch is a no-op without a ledger — a cap that arrives before the billing read
 *                               must not fabricate a one-account ledger.
 *  P4  retry classification   — drift and "App not configured" are terminal; 5xx, 408
 *                               and 429 are worth another attempt; a plain 4xx is not.
 *
 * Blackbox: real `QueryClient` from `createQueryClient()`, msw at the boundary,
 * assertions on `window.location.href`, the UI store and the query cache.
 */

import type { BillingResponse } from "@npmguard/shared";
import { useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { useEffect } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanelUi } from "../stores/panelStore.ts";
import { billingKeys } from "../features/billing/keys.ts";
import { enableProtect } from "../features/repos/api.ts";
import { fetchInstallations } from "../features/session/api.ts";
import { ApiError } from "./api-base.ts";
import { createQueryClient, retryable } from "./query-client.ts";
import {
  billingResponse,
  clearAbsoluteApiBase,
  entitlements,
  makeTestClient,
  Providers,
  useAbsoluteApiBase,
} from "./test-harness.tsx";
import { ContractViolationError } from "./wire.ts";

const server = setupServer();

// Captured BEFORE any test stubs `window.location`. msw resolves a relative
// handler path against the current location, and these tests deliberately
// replace it with a blank-href stub so a redirect is observable — so the handler
// paths have to be absolute or nothing matches.
const ORIGIN = window.location.origin;

let originalLocation: Location;

beforeAll(() => {
  useAbsoluteApiBase();
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  clearAbsoluteApiBase();
});

let client: QueryClient;

beforeEach(() => {
  client = makeTestClient();
  usePanelUi.setState({ paywall: null });
  originalLocation = window.location;
  // Stub location so an assignment is observable instead of a jsdom
  // "Not implemented: navigation" log.
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "", origin: ORIGIN, assign: vi.fn() } as unknown as Location,
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

/** Fires one query on mount. */
function QueryProbe() {
  useQuery({ queryKey: ["probe"], queryFn: fetchInstallations });
  return null;
}

/** Fires one mutation on mount. */
function MutationProbe({ onSettled }: { onSettled: () => void }) {
  const mutation = useMutation({ mutationFn: () => enableProtect(5) });
  useEffect(() => {
    mutation.mutate(undefined, { onSettled });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe("query policy — P1 401 reauth redirects", () => {
  it("P1: a {reauth:true} 401 on a query hard-redirects to the GitHub login URL", async () => {
    server.use(
      http.get(`${ORIGIN}/api/panel/orgs`, () =>
        HttpResponse.json({ error: "token expired", reauth: true }, { status: 401 }),
      ),
    );
    render(
      <Providers client={client}>
        <QueryProbe />
      </Providers>,
    );
    await waitFor(() => expect(window.location.href).toBe(`${ORIGIN}/api/auth/github/login`));
  });

  it("P1: a {reauth:true} 401 on a MUTATION redirects too — one policy, both paths", async () => {
    server.use(
      http.post(`${ORIGIN}/api/panel/repo/5/protect`, () =>
        HttpResponse.json({ error: "token expired", reauth: true }, { status: 401 }),
      ),
    );
    const settled = vi.fn();
    render(
      <Providers client={client}>
        <MutationProbe onSettled={settled} />
      </Providers>,
    );
    await waitFor(() => expect(settled).toHaveBeenCalled());
    expect(window.location.href).toBe(`${ORIGIN}/api/auth/github/login`);
  });

  it("P1: a PLAIN 401 does not redirect — signed out is not an expired token", async () => {
    server.use(
      http.get(`${ORIGIN}/api/panel/orgs`, () => HttpResponse.json({ error: "Not signed in" }, { status: 401 })),
    );
    render(
      <Providers client={client}>
        <QueryProbe />
      </Providers>,
    );
    // Nothing to wait for except the absence of a navigation; wait for the query
    // to settle by observing the cache.
    await waitFor(() => expect(client.getQueryState(["probe"])?.status).toBe("error"));
    expect(window.location.href).toBe("");
  });
});

describe("query policy — P2 402 cap opens the paywall and patches the ledger in place", () => {
  it("P2: the matching account is replaced from the 402's fresh entitlements; others untouched", async () => {
    const before1 = entitlements({ installationId: 1, protectedRepos: { used: 0, limit: 1, remaining: 1 } });
    const before2 = entitlements({ installationId: 2, protectedRepos: { used: 0, limit: 1, remaining: 1 } });
    client.setQueryData<BillingResponse>(
      billingKeys.overview(),
      billingResponse({ accounts: [before1, before2] }),
    );

    // Fresh entitlements for account 2 arrive INSIDE the cap body.
    const patched2 = entitlements({
      installationId: 2,
      protectedRepos: { used: 1, limit: 1, remaining: 0 },
    });
    server.use(
      http.post(`${ORIGIN}/api/panel/repo/5/protect`, () =>
        HttpResponse.json(
          {
            error: "Protected-repository limit reached",
            cap: true,
            resource: "protected_repos",
            installationId: 2,
            entitlements: patched2,
          },
          { status: 402 },
        ),
      ),
    );

    const settled = vi.fn();
    render(
      <Providers client={client}>
        <MutationProbe onSettled={settled} />
      </Providers>,
    );
    await waitFor(() => expect(settled).toHaveBeenCalled());

    const paywall = usePanelUi.getState().paywall;
    expect(paywall?.resource).toBe("protected_repos");
    expect(paywall?.installationId).toBe(2);

    const ledger = client.getQueryData<BillingResponse>(billingKeys.overview());
    // In place, order preserved: account 1 is the same object it was.
    expect(ledger?.accounts[0]).toBe(before1);
    expect(ledger?.accounts[1]).toEqual(patched2);
  });

  it("P3: a cap with no ledger cached patches nothing rather than fabricating one", async () => {
    server.use(
      http.post(`${ORIGIN}/api/panel/repo/5/protect`, () =>
        HttpResponse.json(
          {
            error: "Monthly audit budget reached",
            cap: true,
            resource: "monthly_audits",
            installationId: 1,
            entitlements: entitlements(),
          },
          { status: 402 },
        ),
      ),
    );
    const settled = vi.fn();
    render(
      <Providers client={client}>
        <MutationProbe onSettled={settled} />
      </Providers>,
    );
    await waitFor(() => expect(settled).toHaveBeenCalled());

    expect(usePanelUi.getState().paywall?.resource).toBe("monthly_audits");
    expect(client.getQueryData(billingKeys.overview())).toBeUndefined();
  });
});

describe("query policy — P4 retry classification", () => {
  it("P4: drift is terminal — the same payload violates the same schema", () => {
    expect(retryable(new ContractViolationError("GET /panel/repos", "x", {}))).toBe(false);
  });

  it("P4: 503 App-not-configured is terminal — it needs a server env change, not a retry", () => {
    expect(retryable(new ApiError(503, { error: "GitHub App is not configured" }, "x"))).toBe(false);
  });

  it("P4: 5xx, 408 and 429 are retryable; other 4xx are not", () => {
    expect(retryable(new ApiError(500, {}, "x"))).toBe(true);
    expect(retryable(new ApiError(502, {}, "x"))).toBe(true);
    expect(retryable(new ApiError(408, {}, "x"))).toBe(true);
    expect(retryable(new ApiError(429, {}, "x"))).toBe(true);
    expect(retryable(new ApiError(404, {}, "x"))).toBe(false);
    expect(retryable(new ApiError(402, {}, "x"))).toBe(false);
    expect(retryable(new ApiError(422, {}, "x"))).toBe(false);
  });

  it("P4: a transport failure is retryable — the one case where the same request may succeed", () => {
    expect(retryable(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("P4: the shipped client is what these tests classify with", () => {
    // Guards against the policy being configured on a client the app never builds.
    expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
  });
});
