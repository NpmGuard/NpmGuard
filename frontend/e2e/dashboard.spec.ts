// S9 dashboard honest login gate (no session, GitHub App unconfigured)
// ── Scenario map (TESTING.md, Pillar B) ──────────────────────────────────────
// S9 [dashboard gate]  With NO session and the engine's /me returning 503
//   ("GitHub App is not configured"), the panel store resolves user=null and
//   /dashboard MUST render the HONEST login gate — the "Connect your GitHub
//   workspace" heading and the "Sign in with GitHub" link — never a blank page
//   and never a fabricated workspace. The authed "Repository posture" repo grid
//   must NOT render. Assert STRUCTURE only.
// ─────────────────────────────────────────────────────────────────────────────

import { expect, test } from "@playwright/test";

test("S9: an unconfigured/unauthenticated /dashboard renders the honest login gate", async ({
  page,
}) => {
  await page.goto("/dashboard");

  // Honest gate: the connect heading + the GitHub sign-in link are visible.
  await expect(page.getByRole("heading", { name: "Connect your GitHub workspace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();

  // Never a fabricated workspace: the authed hero + repo grid must not render.
  await expect(page.getByRole("heading", { name: "Repository posture" })).toHaveCount(0);
});

// S9b [gate is a live door, not a decorative dead-end]  Visibility of the
// sign-in link is not enough: an honest gate whose "Sign in with GitHub" link
// points nowhere (or at a misconfigured route) LOOKS honest but cannot start
// the flow. The unit pillar only compares href against the same githubLoginUrl()
// constant the component emits, so only this real-engine pass can prove the
// built app's link resolves to the engine's actual OAuth entry. Also re-assert,
// beyond the hero heading, that NO authed workspace control (Refresh) leaks.
test("S9b: the login gate's GitHub link targets the real engine OAuth entry, and no authed control leaks", async ({
  page,
}) => {
  await page.goto("/dashboard");

  const link = page.getByRole("link", { name: "Sign in with GitHub" });
  await expect(link).toBeVisible();
  // The link must actually go to the engine's full-page login redirect
  // (/api/auth/github/login) — a live door, not "#" or a client route.
  await expect(link).toHaveAttribute("href", /\/api\/auth\/github\/login$/);

  // Honest-verdict invariant: not one piece of authed workspace chrome renders
  // over the anonymous session — the hero "Refresh" action must be absent.
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0);
});
