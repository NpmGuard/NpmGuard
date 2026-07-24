// S7 expired session + scoped-name routing edge
// ── Scenario map (TESTING.md, Pillar B) ──────────────────────────────────────
// S7 [expired]  /audit/<random-uuid> → the connectToSession probe 404s → an
//               honest "session expired / not found" state renders, never a
//               blank view and never a fabricated SAFE audit.
// Edge [scoped] /package/@scope/pkg keeps its slash (splat route, never
//               encodeURIComponent'd) — an unseeded scoped name resolves to the
//               honest 404 with the scoped identity intact, proving the routing.
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from "@playwright/test";

// This e2e FOUND a real app bug (the 404 probe set the honest error but also
// reset hasStarted:false, so HomeOrAudit fell back to <Landing/> and the error
// was never shown). FIXED in src: HomeOrAudit now surfaces `error`, and AuditView
// renders a dedicated honest empty-state for an error-with-no-streamed-content.
test(
  "S7: an expired/unknown audit session shows an honest state, never a blank view",
  async ({ page }) => {
    // A well-formed but non-existent session id — the engine's report probe 404s.
    await page.goto("/audit/00000000-0000-4000-8000-000000000000");

    // Honest "expired / not found" — the store sets this on the 404 probe.
    await expect(page.getByText(/expired or was not found/i)).toBeVisible();
    // Never a fabricated verdict from a missing session.
    await expect(page.getByText("SAFE", { exact: true })).toHaveCount(0);
    await expect(page.getByText("DANGEROUS", { exact: true })).toHaveCount(0);
  },
);

test("Edge: a scoped package name routes with its slash intact", async ({ page }) => {
  await page.goto("/package/@scope/pkg");

  // Splat route kept "@scope/pkg" whole → honest 404 for the scoped identity.
  await expect(page.getByText(/No audit report for/)).toBeVisible();
  await expect(page.getByText("@scope/pkg").first()).toBeVisible();
});
