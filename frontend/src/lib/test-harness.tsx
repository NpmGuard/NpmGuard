/**
 * Shared test scaffolding for the query layer. Not a test file (vitest only
 * collects `*.test.*`), and not imported by app code.
 *
 * Two things every query-layer test needs and neither should re-derive:
 *
 *  - a `QueryClient` built from the REAL `createQueryClient()`, so the retry
 *    classification, the reauth redirect and the 402→paywall policy under test
 *    are the ones the app ships. Only retry COUNT is overridden, because
 *    "eventually gives up" is not what any of these tests are about and waiting
 *    for it makes them slow.
 *  - an absolute `apiBase`. `getJson("/api/…")` is fine in a browser but undici
 *    rejects a relative URL, so `apiBase()` is pinned to the jsdom origin while
 *    the msw handlers stay origin-relative. Same trick as `lib/api.test.ts`.
 */

import type {
  AccountEntitlements,
  Alert,
  AuditSet,
  BillingResponse,
  PanelRepo,
  SessionUser,
} from "@npmguard/shared";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { createQueryClient } from "./query-client.ts";

export function makeTestClient(): QueryClient {
  const client = createQueryClient();
  client.setDefaultOptions({
    queries: {
      // Keep the app's freshness window: it is what makes two observers of one
      // key share a single fetch, which is a property under test.
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: false,
    },
    mutations: { retry: false },
  });
  return client;
}

/** Pin `apiBase()` to an absolute URL for the duration of a suite. */
export function useAbsoluteApiBase(): void {
  window.__NPMGUARD_CONFIG__ = { apiBase: `${window.location.origin}/api` };
}

export function clearAbsoluteApiBase(): void {
  delete window.__NPMGUARD_CONFIG__;
}

export function Providers({
  client,
  children,
  initialEntries,
}: {
  client: QueryClient;
  children: ReactNode;
  /** Starting history for pages that read route params. */
  initialEntries?: string[];
}): ReactElement {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

export function renderWithClient(
  ui: ReactNode,
  options: { client?: QueryClient; initialEntries?: string[] } = {},
): RenderResult {
  const client = options.client ?? makeTestClient();
  return render(
    <Providers client={client} initialEntries={options.initialEntries}>
      {ui}
    </Providers>,
  );
}

// ---------------------------------------------------------------------------
// Wire fixtures
// ---------------------------------------------------------------------------
// Built at the CONTRACT's shape, with no casts. A fixture behind an
// `as unknown as PanelRepo` is a test asserting against a shape nothing
// produces — and since the API layer now `safeParse`s every response, a fixture
// that drifts from the schema fails these tests loudly rather than quietly
// passing.

export function auditSet(over: Partial<AuditSet> = {}): AuditSet {
  return {
    id: 1,
    origin: "repo_scan",
    trigger: "manual",
    status: "done",
    rollup: { outcome: "SAFE", total: 2, safe: 2, dangerous: 0, error: 0, pending: 0, cached: 1 },
    commitSha: "abc123",
    startedAt: "2026-07-25T11:00:00.000Z",
    finishedAt: "2026-07-25T11:05:00.000Z",
    ...over,
  };
}

export function panelRepo(over: Partial<PanelRepo> = {}): PanelRepo {
  return {
    id: 5,
    installationId: 1,
    owner: "acme",
    name: "widget",
    fullName: "acme/widget",
    private: false,
    defaultBranch: "main",
    protected: false,
    lastScan: null,
    ...over,
  };
}

export function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: 11,
    org: "acme",
    repoId: 5,
    packageName: "left-pad",
    version: "1.3.0",
    outcome: "DANGEROUS",
    origin: "repo_scan",
    message: "Credential exfiltration confirmed",
    seen: false,
    createdAt: "2026-07-25T11:06:00.000Z",
    ...over,
  };
}

export function entitlements(over: Partial<AccountEntitlements> = {}): AccountEntitlements {
  return {
    installationId: 1,
    accountLogin: "acme",
    plan: "free",
    subscriptionStatus: "inactive",
    protectedRepos: { used: 1, limit: 1, remaining: 0 },
    monthlyAudits: { used: 0, limit: 100, remaining: 100 },
    ...over,
  };
}

export function billingResponse(over: Partial<BillingResponse> = {}): BillingResponse {
  return {
    accounts: [entitlements()],
    plans: {
      free: { protectedRepos: 1, monthlyAudits: 100 },
      pro: { protectedRepos: 0, monthlyAudits: 0 },
    },
    checkoutEnabled: true,
    // `currency` is nullable on the wire, and the fixture exercises that null.
    price: { amount: 900, currency: null, interval: "month" },
    ...over,
  };
}

export const SESSION_USER: SessionUser = {
  id: 42,
  login: "octocat",
  name: "Octo Cat",
  email: null,
  avatarUrl: null,
};
