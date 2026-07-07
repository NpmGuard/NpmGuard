import { Hono } from "hono";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";

import { config, GITHUB_APP_ENABLED } from "../config.js";
import { encryptSecret } from "../crypto.js";
import { getDb, nowIso } from "../db.js";
import { githubApp, userOctokit } from "../github/app.js";
import {
  createSession,
  deleteSession,
  getSessionUser,
  SESSION_COOKIE,
} from "../session.js";

// GitHub sign-in (spec §4 decision 1 — the Vercel pattern): OAuth on top of
// the GitHub App establishes WHO the user is; repo access comes from App
// installations, listed in routes/panel.ts.

export const authRoutes = new Hono();

const STATE_COOKIE = "ng_oauth_state";

const secureCookies = config.panelBaseUrl.startsWith("https");

function notConfigured(c: Context) {
  return c.json({ error: "GitHub App is not configured on this server" }, 503);
}

authRoutes.get("/auth/github/login", (c) => {
  if (!GITHUB_APP_ENABLED) return notConfigured(c);

  const state = randomBytes(16).toString("hex");
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  const { url } = githubApp().oauth.getWebFlowAuthorizationUrl({
    state,
    redirectUrl: `${config.panelBaseUrl}/api/auth/github/callback`,
  });
  return c.redirect(url);
});

authRoutes.get("/auth/github/callback", async (c) => {
  if (!GITHUB_APP_ENABLED) return notConfigured(c);

  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/" });

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.json({ error: "OAuth state mismatch — restart the sign-in flow" }, 400);
  }

  try {
    const { authentication } = await githubApp().oauth.createToken({ code });

    const octo = userOctokit(authentication.token);
    const { data: ghUser } = await octo.rest.users.getAuthenticated();

    // Prefer the primary verified email (needs the App's "Email addresses:
    // read" account permission); fall back to the public profile email.
    let email = ghUser.email ?? null;
    try {
      const { data: emails } = await octo.rest.users.listEmailsForAuthenticatedUser();
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? email;
    } catch {
      // App lacks the email permission — non-fatal, alerts fall back gracefully
    }

    const refreshToken =
      "refreshToken" in authentication ? (authentication.refreshToken ?? null) : null;
    const tokenExpiresAt =
      "expiresAt" in authentication ? (authentication.expiresAt ?? null) : null;

    getDb()
      .prepare(
        `INSERT INTO users (id, login, name, email, avatar_url, access_token_enc, refresh_token_enc, token_expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           login = excluded.login,
           name = excluded.name,
           email = excluded.email,
           avatar_url = excluded.avatar_url,
           access_token_enc = excluded.access_token_enc,
           refresh_token_enc = excluded.refresh_token_enc,
           token_expires_at = excluded.token_expires_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        ghUser.id,
        ghUser.login,
        ghUser.name ?? null,
        email,
        ghUser.avatar_url ?? null,
        encryptSecret(authentication.token),
        refreshToken ? encryptSecret(refreshToken) : null,
        tokenExpiresAt,
        nowIso(),
      );

    const session = createSession(ghUser.id);
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "Lax",
      path: "/",
      expires: new Date(session.expiresAt),
    });

    return c.redirect(`${config.panelBaseUrl}/dashboard`);
  } catch (err) {
    console.error("[auth] callback failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "GitHub sign-in failed" }, 502);
  }
});

authRoutes.get("/me", (c) => {
  const user = getSessionUser(getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ error: "Not signed in" }, 401);
  return c.json({ user });
});

authRoutes.post("/auth/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) deleteSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});
