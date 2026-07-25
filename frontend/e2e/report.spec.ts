// S4 durable report render + honest 404
// ── Scenario map (TESTING.md, Pillar B) ──────────────────────────────────────
// S4 [durable]  /package/<name>?version= renders the persisted schemaVersion-2
//               report (verdict pill, counts rail, hypotheses, files, timing).
//               A bogus name → an honest .empty-state 404 — NOT an error, and
//               NEVER a fabricated SAFE verdict.
// Reports are SEEDED by panel-fixture.ts from the demo recordings' `report`
// field, under PUBLIC names (chalk@5.6.2 SAFE, npm-telemetry-helper@2.0.1
// DANGEROUS). Assert STRUCTURE, never captured prose.
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from "@playwright/test";
import { DANGEROUS_PKG, SAFE_PKG } from "./helpers.ts";

test("S4: the durable DANGEROUS report renders the full schemaVersion-2 view", async ({ page }) => {
  await page.goto(`/package/${DANGEROUS_PKG.name}?version=${DANGEROUS_PKG.version}`);

  // Verdict pill + counts rail + confirmed hypothesis + files + timing.
  await expect(page.locator("[data-verdict]")).toHaveText("DANGEROUS");
  await expect(page.getByRole("img", { name: /^14 hypotheses/ })).toBeVisible();
  await expect(page.getByText("Credential theft").first()).toBeVisible();
  await expect(page.getByText("Files analyzed")).toBeVisible();
  await expect(page.getByText(/Completed in/)).toBeVisible();
  // The report carries the package identity from the route (the seed is a rename).
  await expect(page.getByText(`${DANGEROUS_PKG.name}`, { exact: false }).first()).toBeVisible();
});

test("S4: the durable SAFE report renders honest no-threat structure", async ({ page }) => {
  await page.goto(`/package/${SAFE_PKG.name}?version=${SAFE_PKG.version}`);

  await expect(page.locator("[data-verdict]")).toHaveText("SAFE");
  // ★ §0's caveat. SAFE does not mean "this package is safe" — it means "this
  // audit found nothing it could confirm", and overstating a clean result is
  // the credibility failure the whole design direction is built to avoid. The
  // caveat belongs to `VerdictHeadline`, so a page CANNOT ship SAFE without it;
  // this asserts the guarantee actually reaches the rendered page.
  await expect(page.getByText("Not a proof of absence")).toBeVisible();
  // SAFE with zero hypotheses raised states its coverage honestly, never a row
  // of zeros and never a bare verdict with no denominator.
  await expect(page.getByText("No hypotheses were raised for this package.")).toBeVisible();
  await expect(page.getByText("Files analyzed")).toBeVisible();
  await expect(page.getByText("DANGEROUS", { exact: true })).toHaveCount(0);
});

test("S4: a package with no report shows an honest 404, never a fake SAFE", async ({ page }) => {
  await page.goto("/package/definitely-not-a-real-package-xyz");

  // Honest empty state (missing), not an error banner, not a fabricated verdict.
  await expect(page.getByText(/No audit report for/)).toBeVisible();
  await expect(page.getByText("definitely-not-a-real-package-xyz").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /audit definitely-not-a-real-package-xyz/i })).toBeVisible();
  await expect(page.getByText("SAFE", { exact: true })).toHaveCount(0);
  await expect(page.getByText("DANGEROUS", { exact: true })).toHaveCount(0);
});
