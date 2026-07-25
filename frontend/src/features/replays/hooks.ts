import type { ReplayEntry, ReplayGalleryResponse } from "@npmguard/shared";
import { useQuery } from "@tanstack/react-query";
import type { LoadState } from "../../components/ui/load-state.ts";
import { toLoadState } from "../../lib/query-state.ts";
import { fetchReplays } from "./api.ts";
import { replayKeys } from "./keys.ts";

/** The gallery. No `enabled` guard and no polling: the list is public, and it
 * only changes when an audit finishes — which the person watching one is already
 * looking at from the audit view. */
export function useReplays(): LoadState<ReplayEntry[]> {
  const query = useQuery({
    queryKey: replayKeys.list(),
    queryFn: fetchReplays,
    staleTime: 30_000,
    select: (response: ReplayGalleryResponse) => response.replays,
  });
  return toLoadState(query, "Replays");
}
