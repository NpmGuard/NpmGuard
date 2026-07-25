/**
 * Panel e2e helpers: sign-in.
 *
 * Sign-in drives the REAL OAuth round trip (engine → stub authorize → engine
 * callback → `/dashboard`) rather than injecting a cookie. `ng_session` is an
 * opaque server-side session with the GitHub token AES-GCM encrypted at rest, so
 * hand-seeding it means hand-writing `gh_users` + `gh_sessions` rows — engine-
 * owned state, and the drift that follows is exactly what this codebase spends
 * its effort deleting. The round trip is slower and proves more.
 */

import { expect, type Page } from "@playwright/test";

/** A scan whose one cache-MISS dep is retried `MAX_ATTEMPTS` times against the
 * stub's delayed registry. Generous, and a ceiling rather than a sleep — every
 * wait below is an `expect` that polls. */
export const SCAN_TERMINAL_MS = 60_000;

/** Full sign-in through the stub, ending on a signed-in `/dashboard`. */
export async function signIn(page: Page): Promise<void> {
  // A full-page navigation, not a fetch: the engine 302s to GitHub and the whole
  // chain has to run in the browser for the cookies to land on the app origin.
  await page.goto("/api/auth/github/login");
  await page.waitForURL("**/dashboard");
  // The workspace heading only renders on the signed-in arm — the signed-out and
  // "no GitHub App on this server" arms render entirely different cards, so this
  // is the assertion that tells a broken session from a broken selector.
  await expect(page.getByRole("heading", { name: "Repository posture" })).toBeVisible();
}
