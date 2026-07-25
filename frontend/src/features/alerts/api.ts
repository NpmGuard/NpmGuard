/** The alerts feed. Org-scoped, not repo-scoped: an alert is raised against an
 * installation account, and carries the repo it was found through. */

import { AlertsResponseSchema, AlertsSeenResponseSchema } from "@npmguard/shared";
import { apiBase } from "../../lib/config.ts";
import { getWire, postWire } from "../../lib/wire.ts";

export function fetchAlerts() {
  return getWire(`${apiBase()}/panel/alerts`, AlertsResponseSchema, "GET /panel/alerts");
}

export function markAlertsSeen() {
  return postWire(
    `${apiBase()}/panel/alerts/seen`,
    AlertsSeenResponseSchema,
    "POST /panel/alerts/seen",
  );
}
