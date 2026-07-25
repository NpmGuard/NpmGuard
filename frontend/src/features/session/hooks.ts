/**
 * Session + workspace reads.
 *
 * `useSession` is called from the header and from every gated page. That is safe
 * and deliberate: react-query dedupes by key, so N components observing one key
 * make ONE request and share one cache entry. A global store can only
 * approximate this with a `fetchMe()` action plus a `userLoaded` boolean every
 * consumer has to remember to check.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrgsResponse } from "@npmguard/shared";
import type { LoadState } from "../../components/ui/load-state.ts";
import { toLoadState } from "../../lib/query-state.ts";
import { fetchInstallations, fetchSession, logout, type PanelSession } from "./api.ts";
import { sessionKeys } from "./keys.ts";

export function useSession(): LoadState<PanelSession> {
  const query = useQuery({
    queryKey: sessionKeys.me(),
    queryFn: fetchSession,
    // The session outlives any single page and changes only by signing in or
    // out — both of which are explicit and invalidate it themselves.
    staleTime: 5 * 60_000,
  });
  return toLoadState(query, "Your GitHub session");
}

/** True once we KNOW there is a signed-in user. Deliberately not "not signed
 * out": while the session read is in flight the answer is unknown, and gating
 * panel fetches on `false` keeps them from firing a burst of 401s on boot. */
export function useSignedIn(): boolean {
  const session = useSession();
  return session.status === "ok" && session.data.user !== null;
}

export function useInstallations(): LoadState<OrgsResponse> {
  const signedIn = useSignedIn();
  const query = useQuery({
    queryKey: sessionKeys.installations(),
    queryFn: fetchInstallations,
    enabled: signedIn,
  });
  return toLoadState(query, "Your GitHub workspace");
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: logout,
    // `clear()` rather than a field-by-field reset: a list of named fields has to
    // be extended every time a read is added, and the one that gets forgotten
    // survives the logout. Dropping the whole cache cannot go stale.
    onSettled: () => client.clear(),
  });
}
