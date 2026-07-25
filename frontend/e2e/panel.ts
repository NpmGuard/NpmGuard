/**
 * Panel e2e helpers: sign-in, and the one control-plane call.
 *
 * Sign-in drives the REAL OAuth round trip (engine → stub authorize → engine
 * callback → `/dashboard`) rather than injecting a cookie. `ng_session` is an
 * opaque server-side session with the GitHub token AES-GCM encrypted at rest, so
 * hand-seeding it means hand-writing `gh_users` + `gh_sessions` rows — engine-
 * owned state, and the drift that follows is exactly what this codebase spends
 * its effort deleting. The round trip is slower and proves more.
 */

import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { GITHUB_STUB_URL } from "./panel-fixture.ts";

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

/**
 * Fire the engine's own DANGEROUS-verdict fan-out for one pair.
 *
 * The alert producer runs inside `PanelScanWorker` at the moment a real audit
 * lands a DANGEROUS verdict, and a real audit needs docker + a live LLM — both
 * out of scope for Phase 3, and under `NPMGUARD_MOCK_LLM` a concluding audit
 * could only ever be SAFE anyway. A dep that is a cache HIT never runs a job, so
 * it never reaches the hook either. The harness therefore calls the hook itself,
 * out of process, with the arguments the worker would pass; exposure and the
 * rows are still computed and written by the engine's code against the
 * `repo_deps` index the browser's own scan produced.
 */
export async function fanOutDangerous(
  request: APIRequestContext,
  pkg: { name: string; version: string },
): Promise<number> {
  const res = await request.post(`${GITHUB_STUB_URL}/fixture/dangerous-fanout`, {
    data: { packageName: pkg.name, version: pkg.version, origin: "repo_scan" },
  });
  expect(res.ok(), `dangerous fan-out for ${pkg.name} should succeed`).toBeTruthy();
  const { alerts } = (await res.json()) as { alerts: number };
  return alerts;
}
