// S5 registry list + verdict filter + row navigation + reason-aware empty
// ── Scenario map (TESTING.md, Pillar B) ──────────────────────────────────────
// S5 [registry]  /packages lists the seeded audited packages with an "N shown"
//                count; the verdict filter narrows the list; a row navigates to
//                its durable report; a search that matches nothing renders a
//                reason-aware, honest empty state (never a fake SAFE row).
// Seeded (global-setup.ts): chalk@5.6.2 SAFE, npm-telemetry-helper@2.0.1 DANGEROUS.
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from "@playwright/test";
import { DANGEROUS_PKG, SAFE_PKG } from "./helpers.ts";

test("S5: the registry lists both seeded packages with an accurate count", async ({ page }) => {
  await page.goto("/packages");

  await expect(page.getByRole("link", { name: `view full audit of ${SAFE_PKG.name}` })).toBeVisible();
  await expect(
    page.getByRole("link", { name: `view full audit of ${DANGEROUS_PKG.name}` }),
  ).toBeVisible();
  // The honest "N shown" count reflects exactly the seeded rows.
  await expect(page.locator(".pg-registry-count")).toHaveText(/2\s+shown/i);
});

test("S5: the verdict filter narrows the list to the matching verdict", async ({ page }) => {
  await page.goto("/packages");
  await expect(page.getByRole("link", { name: `view full audit of ${SAFE_PKG.name}` })).toBeVisible();

  // Filter to SAFE → only chalk survives; the DANGEROUS row is hidden.
  await page.getByLabel("filter by verdict").selectOption("SAFE");
  await expect(page.getByRole("link", { name: `view full audit of ${SAFE_PKG.name}` })).toBeVisible();
  await expect(
    page.getByRole("link", { name: `view full audit of ${DANGEROUS_PKG.name}` }),
  ).toHaveCount(0);
  await expect(page.locator(".pg-registry-count")).toHaveText(/1\s+shown/i);

  // Filter to DANGEROUS → the mirror image.
  await page.getByLabel("filter by verdict").selectOption("DANGEROUS");
  await expect(
    page.getByRole("link", { name: `view full audit of ${DANGEROUS_PKG.name}` }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: `view full audit of ${SAFE_PKG.name}` })).toHaveCount(0);
});

test("S5: a registry row navigates to its durable report", async ({ page }) => {
  await page.goto("/packages");
  await page.getByRole("link", { name: `view full audit of ${SAFE_PKG.name}` }).click();

  await page.waitForURL(new RegExp(`/package/${SAFE_PKG.name}`));
  await expect(page.locator(".report-verdict__badge")).toHaveText("SAFE");
});

test("S5: a search matching nothing shows a reason-aware empty, never a fake SAFE", async ({
  page,
}) => {
  await page.goto("/packages");
  await expect(page.getByRole("link", { name: `view full audit of ${SAFE_PKG.name}` })).toBeVisible();

  await page.getByLabel("filter audited packages by name").fill("no-such-package-zzz");

  // Reason-aware: names WHY it's empty (the search term), not a bare "empty".
  await expect(page.getByText(/No audited package matches/)).toBeVisible();
  await expect(page.getByText("no-such-package-zzz").first()).toBeVisible();
  await expect(page.locator(".pg-registry-count")).toHaveText(/0\s+shown/i);
  // The honest empty must never fabricate a verdict row.
  await expect(page.getByText("SAFE", { exact: true })).toHaveCount(0);
});
