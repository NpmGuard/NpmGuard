/** StaleChip — data that loaded but is old.
 *
 * The third fact in the §3.4 trio, and the one most often collapsed into the
 * other two. Stale data is *real* data: it is not empty (there is something
 * here) and it is not degraded (the read that produced it succeeded). Rendering
 * it as either loses information the reader needs — "313 deps clean, as of two
 * days ago" is a materially different statement from "313 deps clean".
 *
 * Achromatic like `EmptyState`, because staleness is a position on the progress
 * axis (§2.2: the progress axis gets no hue) and not an outcome. If it needs a
 * colour it has stopped being staleness and become a failure. */

import { RotateCw } from "lucide-react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export type StaleChipProps = {
  /** Rendered verbatim after "as of" — a formatted clock time or date, mono. */
  asOf: string;
  /** Absent renders no refresh affordance rather than a dead one. */
  onRefresh?: () => void;
  className?: string;
};

export function StaleChip({ asOf, onRefresh, className }: StaleChipProps) {
  return (
    <span
      data-state="stale"
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border border-border px-1.5 py-0.5",
        "bg-sunken text-2xs text-text-3",
        className,
      )}
    >
      <span>
        as of <span className="font-mono tabular-nums text-text-2">{asOf}</span>
      </span>
      {onRefresh ? (
        <>
          <span aria-hidden="true" className="text-border-strong">
            ·
          </span>
          <button
            type="button"
            onClick={onRefresh}
            className={cn(
              "inline-flex items-center gap-0.5 rounded-xs text-accent-text hover:underline",
              FOCUS_RING,
            )}
          >
            <RotateCw aria-hidden="true" className="size-3" />
            refresh
          </button>
        </>
      ) : null}
    </span>
  );
}
