/** Unseen-alerts banner: count, the first three alerts as
 * "pkg@ver is VERDICT", and a mark-as-seen action. */

import { TriangleAlert } from "lucide-react";
import { usePanelStore } from "../../stores/panelStore.ts";
import { OutcomePill } from "./tone.tsx";

export function AlertsNotice() {
  const alerts = usePanelStore((s) => s.alerts);
  const markAlertsSeen = usePanelStore((s) => s.markAlertsSeen);

  const unseen = alerts.filter((alert) => !alert.seen);
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
              is <OutcomePill outcome={alert.verdict} />
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => void markAlertsSeen().catch(() => undefined)}
      >
        Mark as seen
      </button>
    </div>
  );
}
