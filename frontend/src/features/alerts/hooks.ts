/** The alerts read, and acking it.
 *
 * This is the resource the old `refresh()` degraded silently: on failure it kept
 * the previous snapshot, which on first load was `[]`, so `AlertsNotice`
 * rendered nothing and the user read *no threats* where the truth was *no
 * knowledge*. With its own query status that state is now representable, and
 * `AlertsNotice` renders a named degraded region instead. */

import type { Alert, AlertsResponse } from "@npmguard/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LoadState } from "../../components/ui/load-state.ts";
import { toLoadState } from "../../lib/query-state.ts";
import { useSignedIn } from "../session/hooks.ts";
import { fetchAlerts, markAlertsSeen } from "./api.ts";
import { alertsKeys } from "./keys.ts";

export function useAlerts(): LoadState<Alert[]> {
  const signedIn = useSignedIn();
  const query = useQuery({
    queryKey: alertsKeys.feed(),
    queryFn: fetchAlerts,
    enabled: signedIn,
    // The CACHE holds the envelope the engine sent; `select` unwraps it for the
    // view. Keeping the wire shape in the cache is what lets `setQueryData`
    // below write exactly what a refetch would write, so an optimistic patch and
    // a real response cannot disagree about shape.
    select: (response: AlertsResponse) => response.alerts,
  });
  return toLoadState(query, "Alerts feed");
}

export function useMarkAlertsSeen() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: markAlertsSeen,
    // Patch rather than refetch: the response's `updated` count exists precisely
    // so the client can settle its unseen count without a second round trip, and
    // `seen` is the only field the ack changes.
    onSuccess: () =>
      client.setQueryData<AlertsResponse>(alertsKeys.feed(), (feed) =>
        feed ? { alerts: feed.alerts.map((alert) => ({ ...alert, seen: true })) } : feed,
      ),
  });
}
