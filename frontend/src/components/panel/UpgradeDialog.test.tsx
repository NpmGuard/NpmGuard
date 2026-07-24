/**
 * UpgradeDialog — the paywall modal driven by store.paywall (a 402 CapExceededBody
 * that carries fresh entitlements, so the exhausted meter renders without a
 * second request). Blackbox over rendered copy + store-backed effects
 * (startProCheckout POST, closePaywall clearing store.paywall).
 *
 * Equivalence classes (input → observable behaviour):
 *   C1  resource "protected_repos"      → protection-limit title + copy + the exhausted
 *                                         protectedRepos meter (used/limit) is shown
 *   C2  resource "public_repo_audits"   → free-repo-allowance title + copy + the exhausted
 *                                         publicRepoAudits meter is shown
 *   C3  resource "monthly_audits"       → monthly-budget title + copy + the exhausted
 *                                         monthlyAudits meter; copy carries no fabricated limit
 *   C4  honest resource naming          → the dialog names the REAL hit resource, never a
 *                                         generic message nor a different resource's title
 *   C5  click "Continue to Stripe"      → POST /panel/billing/checkout fires; busy label
 *                                         shows; the returned url is navigated to
 *   C6  checkout not configured          → CTA disabled + an honest "not configured" line
 *   C7  close via the X (Close) button   → closePaywall clears store.paywall
 *   C8  close via the "Not now" footer   → closePaywall clears store.paywall
 *   C9  close via backdrop mousedown     → closePaywall clears store.paywall
 *   C10 no paywall in store              → renders nothing (honest empty, no fabricated dialog)
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderRoute, resetPanelStore, authedSeed } from "../../test/render.tsx";
import {
  setupPanelServer,
  server,
  http,
  HttpResponse,
  delay,
} from "../../test/panel-server.ts";
import { makeCapBody, makeEntitlements, makeBilling, makeBucket } from "../../test/panel-fixtures.ts";
import type { CapResource } from "../../lib/engine-types.ts";
import { usePanelStore } from "../../stores/panelStore.ts";
import { UpgradeDialog } from "./UpgradeDialog.tsx";

setupPanelServer();

beforeEach(() => {
  resetPanelStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A 402 cap body whose entitlements have the HIT resource's bucket exhausted. */
function capFor(resource: CapResource) {
  const overrides =
    resource === "protected_repos"
      ? { protectedRepos: makeBucket({ used: 3, limit: 3, remaining: 0 }) }
      : resource === "public_repo_audits"
        ? { publicRepoAudits: makeBucket({ used: 2, limit: 2, remaining: 0 }) }
        : { monthlyAudits: makeBucket({ used: 50, limit: 50, remaining: 0 }) };
  return makeCapBody(resource, {
    entitlements: makeEntitlements({ accountLogin: "acme-inc", ...overrides }),
  });
}

describe("UpgradeDialog", () => {
  it("C1: protected_repos names the protection limit and shows the exhausted protectedRepos meter", () => {
    resetPanelStore(authedSeed({ paywall: capFor("protected_repos"), billing: makeBilling() }));
    renderRoute(<UpgradeDialog />);

    expect(
      screen.getByRole("heading", { name: /protection limit reached/i }),
    ).toBeInTheDocument();
    // Resource-appropriate copy carries the real Free limit (3).
    expect(screen.getByText(/protects up to 3 repositories/i)).toBeInTheDocument();

    const meter = screen.getByRole("progressbar", { name: "Protected repositories" });
    expect(meter).toHaveAttribute("aria-valuetext", "3 / 3"); // used === limit ⇒ exhausted
    // The account whose allowance was hit is named.
    expect(screen.getByText("acme-inc")).toBeInTheDocument();
  });

  it("C2: public_repo_audits names the free-repo allowance and shows the exhausted publicRepoAudits meter", () => {
    resetPanelStore(authedSeed({ paywall: capFor("public_repo_audits"), billing: makeBilling() }));
    renderRoute(<UpgradeDialog />);

    expect(
      screen.getByRole("heading", { name: /free repository allowance used/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/free includes 2 distinct public repositories/i)).toBeInTheDocument();

    const meter = screen.getByRole("progressbar", { name: "Public repository audits" });
    expect(meter).toHaveAttribute("aria-valuetext", "2 / 2");
  });

  it("C3: monthly_audits names the monthly budget and shows the exhausted monthlyAudits meter", () => {
    resetPanelStore(authedSeed({ paywall: capFor("monthly_audits"), billing: makeBilling() }));
    renderRoute(<UpgradeDialog />);

    expect(
      screen.getByRole("heading", { name: /monthly audit budget reached/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/new package audits pause until the next billing month/i),
    ).toBeInTheDocument();

    const meter = screen.getByRole("progressbar", { name: "Audits this month" });
    expect(meter).toHaveAttribute("aria-valuetext", "50 / 50");
  });

  it("C4: the dialog names the REAL hit resource, not a generic or mismatched title", () => {
    resetPanelStore(authedSeed({ paywall: capFor("monthly_audits"), billing: makeBilling() }));
    renderRoute(<UpgradeDialog />);

    // The honest verdict: the monthly-budget title is present, and neither of the
    // other resources' titles is fabricated in its place.
    expect(
      screen.getByRole("heading", { name: /monthly audit budget reached/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /protection limit reached/i })).toBeNull();
    expect(screen.queryByRole("heading", { name: /free repository allowance used/i })).toBeNull();
  });

  it("C5: clicking Continue to Stripe fires POST /billing/checkout and shows the busy label", async () => {
    let checkoutHits = 0;
    server.use(
      http.post("/api/panel/billing/checkout", async () => {
        checkoutHits += 1;
        await delay(30); // hold the request open so the busy label is observable
        return HttpResponse.json({ url: "https://stripe.test/checkout", sessionId: "cs_test_1" });
      }),
    );
    resetPanelStore(authedSeed({ paywall: capFor("protected_repos"), billing: makeBilling() }));
    renderRoute(<UpgradeDialog />);

    const cta = screen.getByRole("button", { name: /continue to stripe/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);

    // In-flight: the CTA flips to the busy label and disables.
    const busy = await screen.findByRole("button", { name: /redirecting/i });
    expect(busy).toBeDisabled();

    // The checkout action fired (its POST reached the boundary). We do NOT assert
    // the subsequent window.location.assign(url) navigation value (jsdom).
    await waitFor(() => expect(checkoutHits).toBe(1));
  });

  it("C6: when checkout is not configured the CTA is disabled and an honest notice shows", () => {
    resetPanelStore(
      authedSeed({
        paywall: capFor("protected_repos"),
        billing: makeBilling({ checkoutEnabled: false }),
      }),
    );
    renderRoute(<UpgradeDialog />);

    expect(screen.getByRole("button", { name: /continue to stripe/i })).toBeDisabled();
    expect(screen.getByText(/checkout is not configured on this server/i)).toBeInTheDocument();
  });

  it("C7: the X (Close) button calls closePaywall, clearing store.paywall", () => {
    resetPanelStore(authedSeed({ paywall: capFor("protected_repos"), billing: makeBilling() }));
    renderRoute(<UpgradeDialog />);

    expect(usePanelStore.getState().paywall).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(usePanelStore.getState().paywall).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("C8: the 'Not now' footer button calls closePaywall, clearing store.paywall", () => {
    resetPanelStore(authedSeed({ paywall: capFor("public_repo_audits"), billing: makeBilling() }));
    renderRoute(<UpgradeDialog />);

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    expect(usePanelStore.getState().paywall).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("C9: a backdrop mousedown calls closePaywall, clearing store.paywall", () => {
    resetPanelStore(authedSeed({ paywall: capFor("monthly_audits"), billing: makeBilling() }));
    const { container } = renderRoute(<UpgradeDialog />);

    const scrim = container.querySelector(".scrim");
    expect(scrim).not.toBeNull();
    // mousedown must originate on the scrim itself (target === currentTarget) to close.
    fireEvent.mouseDown(scrim as Element);

    expect(usePanelStore.getState().paywall).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("C11: a Free limit of 1 renders SINGULAR copy (repository, not repositories)", () => {
    // protected_repos at limit 1 — the boundary the copy's limit===1 ternary exists for.
    resetPanelStore(
      authedSeed({
        paywall: makeCapBody("protected_repos", {
          entitlements: makeEntitlements({
            protectedRepos: makeBucket({ used: 1, limit: 1, remaining: 0 }),
          }),
        }),
        billing: makeBilling(),
      }),
    );
    const { unmount } = renderRoute(<UpgradeDialog />);

    expect(screen.getByText(/protects up to 1 repository with/i)).toBeInTheDocument();
    // The plural must NOT leak at the boundary.
    expect(screen.queryByText(/protects up to 1 repositories/i)).toBeNull();
    unmount();

    // public_repo_audits at limit 1 — the same boundary on the other resource's copy.
    resetPanelStore(
      authedSeed({
        paywall: makeCapBody("public_repo_audits", {
          entitlements: makeEntitlements({
            publicRepoAudits: makeBucket({ used: 1, limit: 1, remaining: 0 }),
          }),
        }),
        billing: makeBilling(),
      }),
    );
    renderRoute(<UpgradeDialog />);

    expect(screen.getByText(/free includes 1 distinct public repository\./i)).toBeInTheDocument();
    expect(screen.queryByText(/1 distinct public repositories/i)).toBeNull();
  });

  it("C10: with no paywall in the store the component renders nothing", () => {
    resetPanelStore(authedSeed({ paywall: null, billing: makeBilling() }));
    const { container } = renderRoute(<UpgradeDialog />);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.querySelector(".scrim")).toBeNull();
  });
});
