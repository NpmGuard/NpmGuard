/** Query keys for the alerts feed. See session/keys.ts for why these are
 * factories rather than inline arrays. */
export const alertsKeys = {
  all: ["alerts"] as const,
  /** GET /panel/alerts — org-scoped, newest first. */
  feed: () => [...alertsKeys.all, "feed"] as const,
};
