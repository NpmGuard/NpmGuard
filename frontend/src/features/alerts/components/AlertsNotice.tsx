/** Unseen-alerts banner: count, the first three alerts as
 * "pkg@ver is VERDICT", and a mark-as-seen action.
 *
 * THIS is the component the degraded-state bug lived in. The old store kept the
 * previous alerts snapshot when the fetch failed; on first load that snapshot was
 * `[]`, `unseen.length === 0` was therefore true, and this returned `null`. A
 * reader saw no banner and concluded *no threats* when the truth was *no
 * knowledge* — in a security product, the product lying.
 *
 * The fix is not a `try`/`catch` here; it is that the failure is now a state this
 * component can be handed. Three arms, and only one of them has alerts in scope:
 *
 *   loading  → nothing. A banner not yet drawn claims nothing.
 *   failed   → a named degraded region: "Alerts unavailable", hatched, with a
 *              retry — never silence.
 *   ok       → the banner if anything is unseen, nothing if not. This is the ONLY
 *              arm allowed to render silence, because here silence is true.
 *
 * Not a `<DataRegion>`: an alert banner has no visible empty state (the honest
 * empty rendering is no banner), and DataRegion requires empty copy that would
 * then be dead. The guarantee is unchanged — there is no `data` on the `failed`
 * arm, so the silent branch is unreachable from a failure. */

import type { Alert } from "@npmguard/shared";
import { TriangleAlert } from "lucide-react";
import { OutcomePill } from "../../../components/panel/tone.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import type { LoadState } from "../../../components/ui/load-state.ts";
import { useMarkAlertsSeen } from "../hooks.ts";

export function AlertsNotice({ state }: { state: LoadState<Alert[]> }) {
  const markSeen = useMarkAlertsSeen();

  if (state.status === "loading") return null;
  if (state.status === "failed") {
    return (
      <div className="panel-banner-gap">
        <DegradedRegion failure={state.failure} title="Alerts" />
      </div>
    );
  }

  const unseen = state.data.filter((alert) => !alert.seen);
  if (unseen.length === 0) return null;

  // Only DANGEROUS is ever raised (the type says so), so there is no second
  // tone to pick — the ternary that used to be here had an unreachable arm.
  const tone = "danger";

  return (
    <div className={`banner banner--${tone} panel-alerts`} role="status">
      <TriangleAlert size={15} strokeWidth={1.8} aria-hidden="true" />
      <div className="panel-alerts__body">
        <strong>
          {unseen.length} new {unseen.length === 1 ? "alert" : "alerts"}
        </strong>
        <ul className="panel-alerts__list">
          {unseen.slice(0, 3).map((alert) => (
            <li key={alert.id}>
              <span className="mono">
                {alert.packageName}@{alert.version}
              </span>{" "}
              is <OutcomePill outcome={alert.outcome} />
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="btn btn--sm"
        disabled={markSeen.isPending}
        onClick={() => markSeen.mutate()}
      >
        Mark as seen
      </button>
    </div>
  );
}
