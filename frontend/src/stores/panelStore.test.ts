/**
 * Unit: the GitHub panel domain store — panelStore.ts.
 *
 * The store sits over a mocked panel-api (each route is a vi.fn) and the REAL
 * api-base helpers (capBody/isReauth), so the failure branches are driven by
 * constructing genuine ApiError instances the way the HTTP layer would throw.
 *
 * Input classes (the HTTP-boundary branches the store must dispatch on by
 * status/body, never by message text):
 *  P1  401 reauth → redirect        — an expired OAuth token ({reauth:true}) hard-
 *                                     redirects to the GitHub login URL.
 *  P2  402 cap → paywall + patch     — a cap body opens the paywall AND patches the
 *                                     matching billing account's entitlements IN PLACE
 *                                     (other accounts untouched).
 *  P3  409 with scanId → success     — "already running" is not an error: the store
 *                                     returns the in-flight scanId and clears no state.
 *  P4  optimistic protect            — success flips repo.protected locally; a non-cap
 *                                     failure records a repoActionError and rolls back;
 *                                     a cap failure opens the paywall with NO action error.
 *
 * Blackbox: assert store state + return values after awaiting each action.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/api-base.ts";
import type {
  AccountEntitlements,
  BillingResponse,
  CapExceededBody,
  PanelRepo,
  UsageBucket,
} from "../lib/engine-types.ts";

vi.mock("../lib/panel-api.ts", () => ({
  fetchMe: vi.fn(),
  logout: vi.fn(),
  githubLoginUrl: vi.fn(() => "/api/auth/github/login"),
  fetchOrgs: vi.fn(),
  fetchRepos: vi.fn(),
  fetchAlerts: vi.fn(),
  markAlertsSeen: vi.fn(),
  fetchBilling: vi.fn(),
  startProCheckout: vi.fn(),
  openBillingPortal: vi.fn(),
  triggerRepoScan: vi.fn(),
  enableProtect: vi.fn(),
  disableProtect: vi.fn(),
  resyncRepo: vi.fn(),
  fetchRepoDetail: vi.fn(),
  fetchPublicScans: vi.fn(),
  fetchPublicScanDetail: vi.fn(),
  startPublicRepoScan: vi.fn(),
  scanEventsUrl: vi.fn((id: number) => `/api/panel/scan/${id}/events`),
}));

import * as panelApi from "../lib/panel-api.ts";
import { usePanelStore } from "./panelStore.ts";

const bucket = (used: number, limit: number, remaining: number | null): UsageBucket => ({
  used,
  limit,
  remaining,
});

const entitlements = (
  installationId: number,
  plan: "free" | "pro",
  protectedRepos: UsageBucket,
): AccountEntitlements => ({
  installationId,
  accountLogin: `org-${installationId}`,
  plan,
  subscriptionStatus: "active",
  protectedRepos,
  publicRepoAudits: bucket(0, 3, 3),
  monthlyAudits: bucket(0, 100, 100),
});

const repo = (id: number, prot: boolean): PanelRepo =>
  ({
    id,
    githubRepoId: id * 10,
    owner: "acme",
    name: `repo-${id}`,
    fullName: `acme/repo-${id}`,
    htmlUrl: `https://github.com/acme/repo-${id}`,
    installationId: 1,
    accountLogin: "acme",
    private: false,
    defaultBranch: "main",
    protected: prot,
    lockfilePath: "package-lock.json",
    scan: null,
    rollup: { total: 0, safe: 0, suspect: 0, dangerous: 0, unknown: 0, verdict: "UNKNOWN" },
  }) as unknown as PanelRepo;

const capExceeded = (installationId: number, ent: AccountEntitlements): CapExceededBody => ({
  error: "Protected-repository limit reached",
  cap: true,
  resource: "protected_repos",
  installationId,
  entitlements: ent,
});

// A pristine slice of store state for each test.
function resetStore() {
  usePanelStore.setState({
    user: null,
    userLoaded: false,
    installations: [],
    installUrl: null,
    repos: [],
    alerts: [],
    billing: null,
    billingError: null,
    billingBusyInstallationId: null,
    publicScans: [],
    publicScanBusy: false,
    publicScanError: null,
    loading: false,
    error: null,
    repoActionErrors: {},
    paywall: null,
  });
}

let originalLocation: Location;

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  originalLocation = window.location;
  // Stub window.location so href assignment is observable (jsdom would other-
  // wise log a Not-Implemented navigation).
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { href: "", assign: vi.fn() } as unknown as Location,
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

describe("panelStore — P1 401 reauth → redirect", () => {
  it("P1: a {reauth:true} 401 from orgs hard-redirects to the GitHub login URL", async () => {
    vi.mocked(panelApi.fetchOrgs).mockRejectedValue(
      new ApiError(401, { reauth: true }, "unauthorized"),
    );
    await usePanelStore.getState().refresh();
    expect(panelApi.githubLoginUrl).toHaveBeenCalled();
    expect(window.location.href).toBe("/api/auth/github/login");
    // redirecting, not an inline error
    expect(usePanelStore.getState().error).toBeNull();
    // repos is never fetched once orgs re-auths
    expect(panelApi.fetchRepos).not.toHaveBeenCalled();
  });

  it("P1: a non-reauth failure surfaces an inline error, no redirect", async () => {
    vi.mocked(panelApi.fetchOrgs).mockRejectedValue(new ApiError(500, { message: "boom" }, "boom"));
    await usePanelStore.getState().refresh();
    expect(window.location.href).toBe("");
    expect(usePanelStore.getState().error).toBe("boom");
    expect(usePanelStore.getState().loading).toBe(false);
  });
});

describe("panelStore — P2 402 cap → paywall + entitlements patched in place", () => {
  it("P2: a cap on triggerScan opens the paywall and patches only the matching account", async () => {
    const before1 = entitlements(1, "free", bucket(1, 1, 0));
    const before2 = entitlements(2, "free", bucket(0, 1, 1));
    const billing: BillingResponse = {
      accounts: [before1, before2],
      plans: {
        free: { protectedRepos: 1, publicRepoAudits: 3, monthlyAudits: 100 },
        pro: { protectedRepos: 0, publicRepoAudits: 0, monthlyAudits: 0 },
      },
      checkoutEnabled: true,
      price: { amount: 900, currency: "usd", interval: "month" },
    };
    usePanelStore.setState({ billing });

    // fresh entitlements for account 2 come back inside the cap body
    const patched2 = entitlements(2, "free", bucket(1, 1, 0));
    vi.mocked(panelApi.triggerRepoScan).mockRejectedValue(
      new ApiError(402, capExceeded(2, patched2), "cap"),
    );

    const result = await usePanelStore.getState().triggerScan(55);

    expect(result).toBeNull();
    const state = usePanelStore.getState();
    expect(state.paywall).toEqual(capExceeded(2, patched2));
    // account 2 replaced in place; account 1 untouched; order preserved
    expect(state.billing?.accounts[0]).toBe(before1);
    expect(state.billing?.accounts[1]).toEqual(patched2);
    // a cap is not a repo action error
    expect(state.repoActionErrors[55]).toBeUndefined();
  });
});

describe("panelStore — P3 409 with scanId → treated as success", () => {
  it("P3: an already-running 409 returns the in-flight scanId and sets no error", async () => {
    vi.mocked(panelApi.startPublicRepoScan).mockRejectedValue(
      new ApiError(409, { error: "already running", scanId: 77 }, "conflict"),
    );
    vi.mocked(panelApi.fetchPublicScans).mockResolvedValue({ scans: [] });

    const result = await usePanelStore.getState().startPublicRepoScan("acme/widget", 1);

    expect(result).toBe(77);
    const state = usePanelStore.getState();
    expect(state.publicScanError).toBeNull();
    expect(state.publicScanBusy).toBe(false);
    // the success path still refreshes the public-scan list
    expect(panelApi.fetchPublicScans).toHaveBeenCalled();
  });

  it("P3: a real failure (no scanId) surfaces publicScanError and returns null", async () => {
    vi.mocked(panelApi.startPublicRepoScan).mockRejectedValue(
      new ApiError(422, { message: "no lockfile" }, "no lockfile"),
    );
    const result = await usePanelStore.getState().startPublicRepoScan("acme/widget", 1);
    expect(result).toBeNull();
    expect(usePanelStore.getState().publicScanError).toBe("no lockfile");
    expect(usePanelStore.getState().publicScanBusy).toBe(false);
  });
});

describe("panelStore — P4 optimistic protect", () => {
  it("P4: enabling protection flips repo.protected locally and resolves true", async () => {
    usePanelStore.setState({ repos: [repo(5, false), repo(6, false)] });
    vi.mocked(panelApi.enableProtect).mockResolvedValue({ ok: true });

    const ok = await usePanelStore.getState().setProtect(5, true);

    expect(ok).toBe(true);
    const repos = usePanelStore.getState().repos;
    expect(repos.find((r) => r.id === 5)?.protected).toBe(true);
    expect(repos.find((r) => r.id === 6)?.protected).toBe(false); // untouched
    expect(panelApi.enableProtect).toHaveBeenCalledWith(5);
  });

  it("P4: disabling protection uses the DELETE route and flips protected off", async () => {
    usePanelStore.setState({ repos: [repo(5, true)] });
    vi.mocked(panelApi.disableProtect).mockResolvedValue({ ok: true });

    const ok = await usePanelStore.getState().setProtect(5, false);

    expect(ok).toBe(true);
    expect(usePanelStore.getState().repos[0].protected).toBe(false);
    expect(panelApi.disableProtect).toHaveBeenCalledWith(5);
    expect(panelApi.enableProtect).not.toHaveBeenCalled();
  });

  it("P4: a non-cap failure records a repoActionError, leaves protected unchanged, resolves false", async () => {
    usePanelStore.setState({ repos: [repo(5, false)] });
    vi.mocked(panelApi.enableProtect).mockRejectedValue(new ApiError(500, { message: "boom" }, "boom"));

    const ok = await usePanelStore.getState().setProtect(5, true);

    expect(ok).toBe(false);
    const state = usePanelStore.getState();
    expect(state.repos[0].protected).toBe(false); // no optimistic flip on failure
    expect(state.repoActionErrors[5]).toEqual({ action: "protect", message: "boom" });
    expect(state.paywall).toBeNull();
  });

  it("P4: a cap failure opens the paywall with NO repo action error", async () => {
    usePanelStore.setState({ repos: [repo(5, false)] });
    const cap = capExceeded(1, entitlements(1, "free", bucket(1, 1, 0)));
    vi.mocked(panelApi.enableProtect).mockRejectedValue(new ApiError(402, cap, "cap"));

    const ok = await usePanelStore.getState().setProtect(5, true);

    expect(ok).toBe(false);
    const state = usePanelStore.getState();
    expect(state.paywall).toEqual(cap);
    expect(state.repoActionErrors[5]).toBeUndefined();
    expect(state.repos[0].protected).toBe(false);
  });
});
