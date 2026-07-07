import * as fs from "node:fs";
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

import { config, GITHUB_APP_ENABLED } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { getDb, nowIso } from "../db.js";

// GitHub App client (spec §5.3). @octokit/app handles App JWT signing,
// installation-token minting + caching, and the OAuth web flow. The CLI
// stays crypto-dep-minimal — everything here is engine-side only.

let app: App | null = null;

export function githubApp(): App {
  if (!GITHUB_APP_ENABLED) {
    throw new Error("GitHub App is not configured (see NPMGUARD_GITHUB_* env vars)");
  }
  if (!app) {
    const privateKey = fs.readFileSync(config.githubAppPrivateKeyPath!, "utf-8");
    app = new App({
      appId: config.githubAppId!,
      privateKey,
      oauth: {
        clientId: config.githubClientId!,
        clientSecret: config.githubClientSecret!,
      },
      Octokit,
    });
  }
  return app;
}

/** Octokit authenticated as an installation — tokens are minted and cached
 *  internally by @octokit/app until expiry (~1h). Never persisted. */
export async function installationOctokit(installationId: number): Promise<Octokit> {
  return (await githubApp().getInstallationOctokit(installationId)) as unknown as Octokit;
}

/** Octokit authenticated as a user (OAuth token). */
export function userOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

let cachedSlug: string | null = null;

/** App slug (e.g. "npmguard") — derived once from GET /app, used to build the
 *  https://github.com/apps/<slug>/installations/new install link. */
export async function appSlug(): Promise<string> {
  if (!cachedSlug) {
    const { data } = await githubApp().octokit.request("GET /app");
    cachedSlug = (data as { slug: string }).slug;
  }
  return cachedSlug;
}

interface UserTokenRow {
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
}

/**
 * Decrypted user OAuth token, refreshing via the App's refresh token when
 * expired (GitHub Apps with token expiration enabled issue 8h tokens).
 * Returns null when there is no usable token — callers should surface a
 * "sign in again" state, not throw.
 */
export async function getUserAccessToken(userId: number): Promise<string | null> {
  const db = getDb();
  const row = db
    .prepare("SELECT access_token_enc, refresh_token_enc, token_expires_at FROM users WHERE id = ?")
    .get(userId) as UserTokenRow | undefined;
  if (!row?.access_token_enc) return null;

  const notExpired = !row.token_expires_at || row.token_expires_at > nowIso();
  if (notExpired) return decryptSecret(row.access_token_enc);

  if (!row.refresh_token_enc) return null;
  try {
    const { authentication } = await githubApp().oauth.refreshToken({
      refreshToken: decryptSecret(row.refresh_token_enc),
    });
    db.prepare(
      `UPDATE users SET access_token_enc = ?, refresh_token_enc = ?, token_expires_at = ?, updated_at = ? WHERE id = ?`,
    ).run(
      encryptSecret(authentication.token),
      authentication.refreshToken ? encryptSecret(authentication.refreshToken) : null,
      "expiresAt" in authentication ? (authentication.expiresAt ?? null) : null,
      nowIso(),
      userId,
    );
    return authentication.token;
  } catch (err) {
    console.warn(
      `[github] token refresh failed for user ${userId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
