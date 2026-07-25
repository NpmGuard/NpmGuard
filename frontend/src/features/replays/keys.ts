/** Query keys for the replay gallery. See session/keys.ts for why these are
 * factories rather than inline arrays. */
export const replayKeys = {
  all: ["replays"] as const,
  /** GET /replays */
  list: () => [...replayKeys.all, "list"] as const,
};
