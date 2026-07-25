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
 * arm, so the silent branch is unreachable from a failure.
 *
 * ── PRESENTATION ────────────────────────────────────────────────────────────
 *
 * DECISION the brief left open — §3.3 inventories `AlertFeedRow` but not the
 * banner that summarises the feed. This is the ONE region in the panel where the
 * `danger` slot is right for the whole surface: every alert raised is a DANGEROUS
 * outcome, so the region IS a claim NpmGuard is making about packages, which is
 * exactly what §0 rule 3 reserves red for. Contrast its two neighbours, both of
 * which were wrong in red and are not any more — a failed read (`DegradedRegion`,
 * `error` violet) and a refused mutation (the `error` notice in `RepoCard`).
 *
 * §2.4's glyph + word + colour needs no extra work here: the count is the word,
 * the triangle is the glyph, and each row carries its own `OutcomePill`. */

import type { Alert } from "@npmguard/shared";
import { TriangleAlert } from "lucide-react";
import { OutcomePill } from "../../../components/panel/tone.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import type { LoadState } from "../../../components/ui/load-state.ts";
import { useMarkAlertsSeen } from "../hooks.ts";

export function AlertsNotice({ state }: { state: LoadState<Alert[]> }) {
  const markSeen = useMarkAlertsSeen();

  if (state.status === "loading") return null;
  if (state.status === "failed") {
    return <DegradedRegion failure={state.failure} title="Alerts" />;
  }

  const unseen = state.data.filter((alert) => !alert.seen);
  if (unseen.length === 0) return null;

  return (
    <div
      role="status"
      className={
        "flex items-start justify-between gap-3 rounded-md border px-3.5 py-2.5 " +
        "border-danger-border bg-danger-wash text-danger-text"
      }
    >
      <TriangleAlert aria-hidden="true" strokeWidth={1.8} className="mt-0.5 size-icon shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <strong className="text-sm font-semibold">
          {unseen.length} new {unseen.length === 1 ? "alert" : "alerts"}
        </strong>
        <ul className="flex flex-col gap-1 text-xs">
          {unseen.slice(0, 3).map((alert) => (
            <li key={alert.id} className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono">
                {alert.packageName}@{alert.version}
              </span>{" "}
              is <OutcomePill outcome={alert.outcome} />
            </li>
          ))}
        </ul>
      </div>
      {/* `outline`, not `primary`: acknowledging is secondary to the finding it
          sits beside, and a filled accent button inside a danger wash competes
          with the one thing the reader is meant to look at. */}
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={markSeen.isPending}
        onClick={() => markSeen.mutate()}
      >
        Mark as seen
      </Button>
    </div>
  );
}
