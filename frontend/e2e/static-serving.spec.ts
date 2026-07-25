// S8 the engine's own static server — the shape production runs
// ── Scenario map (TESTING.md, Pillar B) ──────────────────────────────────────
// S8 [static]  Against the ENGINE origin with no vite in front of it, every
//              client route answers with the app on a HARD navigation, the
//              /audit/:id permalink included, while the API keeps answering on
//              the /api mirror.
//
// Why this project exists, and why the other 20 specs cannot replace it: they
// run against the vite dev server, which serves index.html for every path and
// proxies only /api. Production is nginx → engine :8000 → frontend/dist, where
// the engine's OWN routes are matched first — so a root API route with the same
// path as a page silently wins, and vite can never see it. When this spec was
// written, `/replays` and `/packages` returned JSON to a browser and
// `/audit/{id}` — the permalink the CLI prints as "Watch live" — returned
// `{"error":"Not found"}`. All three were green in the vite-backed suite.
//
// Locators are deliberately structural (the header nav, the page heading): the
// failure this guards against is a JSON body where HTML was expected, so what
// matters is that the app rendered at all.
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from "@playwright/test";
import { SAFE_DEMO, startDemoViaApi, TERMINAL_MS } from "./helpers.ts";

/** Every path in the client's route table that a user can reach by typing,
 * pasting or refreshing. Parameterised routes appear with a concrete value. */
const PAGES = [
  "/",
  "/scan",
  "/dashboard",
  "/packages",
  "/replays",
  "/how-it-works",
  "/cli",
  "/pay",
  "/package/chalk",
];

for (const path of PAGES) {
  test(`S8: ${path} serves the app on a hard navigation, not JSON`, async ({ page }) => {
    const response = await page.goto(path);

    expect(response?.status(), `${path} should 200`).toBe(200);
    expect(
      response?.headers()["content-type"],
      `${path} answered from an API route instead of the SPA`,
    ).toContain("text/html");
    // The shell rendered — a JSON body served as HTML would pass the header
    // check but has no nav.
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });
}

test("S8: the /audit/:id permalink survives a hard navigation", async ({ page, request }) => {
  const auditId = await startDemoViaApi(request, SAFE_DEMO);

  const response = await page.goto(`/audit/${auditId}`);

  expect(response?.status(), "the permalink must not 404").toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/html");
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  // Not merely HTML: the run itself is rebuilt from the durable log.
  await expect(page.getByText("SAFE").first()).toBeVisible({ timeout: TERMINAL_MS });
});

test("S8: the API still answers on the /api mirror", async ({ request }) => {
  for (const path of ["/api/replays", "/api/packages"]) {
    const response = await request.get(path);
    expect(response.status(), `${path} should 200`).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
  }
});

test("S8: a mistyped API path is a JSON 404, never the app shell", async ({ request }) => {
  const response = await request.get("/api/nope");

  expect(response.status()).toBe(404);
  expect(response.headers()["content-type"]).toContain("application/json");
});
