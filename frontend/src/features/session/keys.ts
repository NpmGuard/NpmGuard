/** Query keys for the identity + workspace reads.
 *
 * A FACTORY, not inline string arrays at the call sites. Two reasons that are
 * not style: an inline `["repos"]` in a hook and an inline `["repos"]` in an
 * invalidation are two copies of one fact, and a typo in either silently
 * produces a cache miss (a second fetch) or a missed invalidation (stale UI)
 * with no error anywhere. And `sessionKeys.all` gives every read in this feature
 * one prefix, so `invalidateQueries({queryKey: sessionKeys.all})` means what it
 * says. */
export const sessionKeys = {
  all: ["session"] as const,
  /** GET /me — the signed-in identity, or the fact that there isn't one. */
  me: () => [...sessionKeys.all, "me"] as const,
  /** GET /panel/orgs — the installations this identity can act on. */
  installations: () => [...sessionKeys.all, "installations"] as const,
};
