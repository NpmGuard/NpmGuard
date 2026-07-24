/**
 * PlanLedger — per-account plan cards: plan pill, allowance meters, and the
 * upgrade / manage-billing action. Blackbox over rendered output + store-backed
 * effects (checkout/portal POSTs, busy state, billing-error line).
 *
 * Equivalence classes (input → observable behaviour):
 *   C1  no billing AND no billingError            → renders nothing (honest empty)
 *   C2  billing present but zero accounts         → section shows, no account cards / meters
 *   C3  a free account                            → plan pill + the two rendered buckets
 *                                                    (protectedRepos, publicRepoAudits) via usageLabel
 *   C4  clicking Upgrade on a free account         → POST /billing/checkout fires; busy label shows
 *   C5  a pro account                             → "Manage billing" fires POST /billing/portal
 *   C6  billingError seeded                        → the error surfaces as an alert (honest, not a card)
 *   C7  an unlimited bucket (remaining null)       → renders "∞", never a "0 left" style label
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderRoute, resetPanelStore, authedSeed } from "../../test/render.tsx";
import {
  setupPanelServer,
  server,
  http,
  HttpResponse,
  delay,
} from "../../test/panel-server.ts";
import { makeBilling, makeEntitlements, makeBucket } from "../../test/panel-fixtures.ts";
import { PlanLedger } from "./PlanLedger.tsx";

setupPanelServer();

beforeEach(() => {
  resetPanelStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PlanLedger", () => {
  it("C1: with no billing and no error the component renders nothing", () => {
    resetPanelStore(authedSeed({ billing: null, billingError: null }));
    const { container } = renderRoute(<PlanLedger />);
    expect(screen.queryByRole("region", { name: /plan and usage/i })).toBeNull();
    expect(container.querySelector(".panel-section")).toBeNull();
  });

  it("C2: billing with zero accounts shows the section but no account cards or meters", () => {
    resetPanelStore(authedSeed({ billing: makeBilling({ accounts: [] }) }));
    const { container } = renderRoute(<PlanLedger />);
    // Section header still renders (billing loaded), but there are no cards.
    expect(screen.getByText(/plan & usage/i)).toBeInTheDocument();
    expect(container.querySelector(".panel-account")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("C3: a free account shows its login, a free pill, and the two rendered buckets via usageLabel", () => {
    resetPanelStore(
      authedSeed({
        billing: makeBilling({
          accounts: [
            makeEntitlements({
              accountLogin: "acme-inc",
              plan: "free",
              protectedRepos: makeBucket({ used: 2, limit: 3 }),
              publicRepoAudits: makeBucket({ used: 1, limit: 2 }),
            }),
          ],
        }),
      }),
    );
    renderRoute(<PlanLedger />);

    expect(screen.getByText("acme-inc")).toBeInTheDocument();
    expect(screen.getByText("free")).toBeInTheDocument();

    const protectedMeter = screen.getByRole("progressbar", { name: "Protected repositories" });
    expect(protectedMeter).toHaveAttribute("aria-valuetext", "2 / 3");
    const publicMeter = screen.getByRole("progressbar", { name: "Public repository audits" });
    expect(publicMeter).toHaveAttribute("aria-valuetext", "1 / 2");

    // The component renders exactly these two meters (monthlyAudits is not surfaced here).
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);

    // Free account → the checkout CTA, not the manage-billing button.
    expect(screen.getByRole("button", { name: /upgrade to pro/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /manage billing/i })).toBeNull();
  });

  it("C4: clicking Upgrade fires POST /billing/checkout and shows the busy label", async () => {
    let checkoutHits = 0;
    server.use(
      http.post("/api/panel/billing/checkout", async () => {
        checkoutHits += 1;
        await delay(30); // hold the request open so the busy state is observable
        return HttpResponse.json({ url: "https://stripe.test/checkout", sessionId: "cs_test_1" });
      }),
    );
    resetPanelStore(
      authedSeed({
        billing: makeBilling({ accounts: [makeEntitlements({ plan: "free" })] }),
      }),
    );
    renderRoute(<PlanLedger />);

    const btn = screen.getByRole("button", { name: /upgrade to pro/i });
    fireEvent.click(btn);

    // While the POST is in flight the button flips to the busy label and disables.
    const busy = await screen.findByRole("button", { name: /redirecting/i });
    expect(busy).toBeDisabled();

    // The checkout action fired (its POST reached the boundary). We do NOT assert
    // the subsequent window.location.assign(url) navigation value (jsdom).
    await waitFor(() => expect(checkoutHits).toBe(1));
  });

  it("C5: a pro account shows Manage billing and clicking fires POST /billing/portal", async () => {
    let portalHits = 0;
    server.use(
      http.post("/api/panel/billing/portal", async () => {
        portalHits += 1;
        await delay(20);
        return HttpResponse.json({ url: "https://stripe.test/portal" });
      }),
    );
    resetPanelStore(
      authedSeed({
        billing: makeBilling({
          accounts: [makeEntitlements({ plan: "pro", accountLogin: "pro-org" })],
        }),
      }),
    );
    renderRoute(<PlanLedger />);

    expect(screen.getByText("pro")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upgrade to pro/i })).toBeNull();

    const btn = screen.getByRole("button", { name: /manage billing/i });
    fireEvent.click(btn);

    const busy = await screen.findByRole("button", { name: /opening/i });
    expect(busy).toBeDisabled();

    await waitFor(() => expect(portalHits).toBe(1));
  });

  it("C6: a seeded billingError surfaces as an honest alert, not a fabricated plan card", () => {
    resetPanelStore(
      authedSeed({ billing: null, billingError: "Could not load billing" }),
    );
    const { container } = renderRoute(<PlanLedger />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Could not load billing");
    // No account card was invented to fill the gap.
    expect(container.querySelector(".panel-account")).toBeNull();
  });

  it("C8: an exhausted bucket (at the limit, remaining 0) reads used=limit in the danger tone, never as if room remains", () => {
    resetPanelStore(
      authedSeed({
        billing: makeBilling({
          accounts: [
            makeEntitlements({
              plan: "free",
              // At the cap: 3 of 3 protected repos consumed, nothing left.
              protectedRepos: makeBucket({ used: 3, limit: 3, remaining: 0 }),
              // Still has room — the contrast bucket.
              publicRepoAudits: makeBucket({ used: 0, limit: 2, remaining: 2 }),
            }),
          ],
        }),
      }),
    );
    const { container } = renderRoute(<PlanLedger />);

    // The exhausted allowance reports its true count — 3 / 3, not a coerced 0.
    const protectedMeter = screen.getByRole("progressbar", { name: "Protected repositories" });
    expect(protectedMeter).toHaveAttribute("aria-valuetext", "3 / 3");

    // Exactly the exhausted bucket carries the danger fill; the bucket with room
    // does not. An exhausted allowance must never render as still-available.
    const dangerFills = container.querySelectorAll(".meter__fill--danger");
    expect(dangerFills).toHaveLength(1);
    const publicMeter = screen.getByRole("progressbar", { name: "Public repository audits" });
    expect(publicMeter.querySelector(".meter__fill--danger")).toBeNull();
    expect(protectedMeter.querySelector(".meter__fill--danger")).not.toBeNull();
  });

  it("C9: with checkout disabled the Upgrade CTA is rendered but disabled — no dead upgrade path is offered", () => {
    resetPanelStore(
      authedSeed({
        billing: makeBilling({
          checkoutEnabled: false,
          accounts: [makeEntitlements({ plan: "free" })],
        }),
      }),
    );
    renderRoute(<PlanLedger />);

    // The button is present (this is a free account) but must be non-actionable
    // when the server has no checkout path — offering a click that can't work
    // would be a dishonest affordance.
    const btn = screen.getByRole("button", { name: /upgrade to pro/i });
    expect(btn).toBeDisabled();
  });

  it("C7: an unlimited bucket (remaining null) renders ∞, never a 0-left label", () => {
    resetPanelStore(
      authedSeed({
        billing: makeBilling({
          accounts: [
            makeEntitlements({
              plan: "pro",
              // Pro/unlimited: consumed some, but no cap — must read used / ∞, not 0.
              protectedRepos: makeBucket({ used: 7, limit: 0, remaining: null }),
              publicRepoAudits: makeBucket({ used: 3, limit: 0, remaining: null }),
            }),
          ],
        }),
      }),
    );
    renderRoute(<PlanLedger />);

    const protectedMeter = screen.getByRole("progressbar", { name: "Protected repositories" });
    expect(protectedMeter).toHaveAttribute("aria-valuetext", "7 / ∞");
    const publicMeter = screen.getByRole("progressbar", { name: "Public repository audits" });
    expect(publicMeter).toHaveAttribute("aria-valuetext", "3 / ∞");

    // The unlimited label is the ∞ form; no "0 left" / "0 / 0" coercion.
    expect(within(protectedMeter).queryByText(/0 left/i)).toBeNull();
    expect(screen.getAllByText(/∞/).length).toBeGreaterThanOrEqual(2);
  });
});
