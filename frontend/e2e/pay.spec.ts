// S6 payment gate — the honest "no method configured" state
// ── Scenario map (TESTING.md, Pillar B) ──────────────────────────────────────
// S6 [payment]  /pay renders ONLY the methods GET /config/public advertises. The
//               default e2e harness runs with payment OFF (no Stripe key, no
//               chain), so /config/public advertises stripeEnabled:false + crypto:
//               null and the page must say so honestly — never render a card /
//               crypto CTA the engine can't honor.
//
// A full both-methods render (card + crypto tabs) needs a SEPARATELY-configured
// engine (stripe secret + base-sepolia chain env); that path is covered by the
// visual pass + the unit config-gating tests (PayCard branches on config), and
// would be added here as a second Playwright project with that env if wired.
// Here we prove the honest gate under the default (payment-off) engine.
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from "@playwright/test";

test("S6: with payment off, /pay honestly reports no configured method", async ({ page }) => {
  await page.goto("/pay?package=left-pad&version=1.0.0");

  // The package identity is echoed (nothing to pay for = nothing to render).
  await expect(page.getByRole("heading", { name: "left-pad@1.0.0" })).toBeVisible();
  // The honest gate: no advertised method → the factual empty, not a dead CTA.
  await expect(
    page.getByText("No payment method is configured on this engine."),
  ).toBeVisible();
  // No card / crypto call-to-action may render when nothing is advertised.
  await expect(page.getByRole("button", { name: /pay .* with card/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /pay .* with crypto/i })).toHaveCount(0);
});
