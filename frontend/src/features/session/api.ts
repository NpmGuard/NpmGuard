/**
 * Identity + workspace endpoints. The session is an HttpOnly same-origin
 * cookie, so a plain fetch carries it — there is no token for the client to
 * hold, and no Authorization header to build.
 *
 * Installations live here rather than in `features/repos` because they are a
 * property of the signed-in identity's workspace: `/panel/orgs` answers "what
 * can this person act on", and `installUrl` is server-built because it encodes
 * the App slug the client must not know.
 */

import { OrgsResponseSchema, SessionResponseSchema, type SessionUser } from "@npmguard/shared";
import { ApiError, isReauth, postJson } from "../../lib/api-base.ts";
import { apiBase } from "../../lib/config.ts";
import { getWire } from "../../lib/wire.ts";

/** What a session read can conclude. Both fields are FACTS, not failures:
 * "nobody is signed in" and "this deployment has no GitHub App" are answers,
 * and rendering either as a broken page would be the lie N-3 forbids. */
export interface PanelSession {
  user: SessionUser | null;
  /** False on 503: every panel route refuses while the App is unconfigured, so
   * the honest UI is "this server has no GitHub App", not a sign-in button that
   * cannot work. Previously unhandled entirely. */
  appEnabled: boolean;
}

/**
 * A signed-out caller gets 401, never `{user: null}` — absence of a session is
 * a status, not a payload (shared/src/panel.ts). So the 401 is translated here,
 * once, into the fact it represents.
 *
 * A *reauth* 401 is deliberately NOT translated: the stored GitHub token has
 * expired, the fix is to restart the OAuth flow, and swallowing it as
 * "signed out" would render a sign-in button that silently does nothing on
 * click. It rethrows and the global error policy redirects.
 */
export async function fetchSession(): Promise<PanelSession> {
  try {
    const { user } = await getWire(`${apiBase()}/me`, SessionResponseSchema, "GET /me");
    return { user, appEnabled: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401 && !isReauth(err)) {
      return { user: null, appEnabled: true };
    }
    if (err instanceof ApiError && err.status === 503) {
      return { user: null, appEnabled: false };
    }
    throw err;
  }
}

export function logout(): Promise<{ ok: true }> {
  return postJson(`${apiBase()}/auth/logout`);
}

/** Full-page navigation target, not a fetch — the engine 302s to GitHub. */
export function githubLoginUrl(): string {
  return `${apiBase()}/auth/github/login`;
}

export function fetchInstallations() {
  return getWire(`${apiBase()}/panel/orgs`, OrgsResponseSchema, "GET /panel/orgs");
}
