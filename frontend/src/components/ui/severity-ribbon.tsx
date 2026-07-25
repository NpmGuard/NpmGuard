/** SeverityRibbon — plain. Repo/org posture rollup.
 *
 * One segmented bar, segments in outcome order `DANGEROUS · ERROR · SAFE ·
 * pending`, each labelled with its count (§3.2).
 *
 * The load-bearing detail: **pending is a hatched neutral segment**, so an
 * in-flight scan cannot read as green. That is the ribbon's whole reason to exist
 * as a component rather than four divs — the ordering and the pending texture are
 * the two things that stop a posture bar from overstating a clean result, and
 * both are the kind of thing a hand-rolled instance gets right once and then
 * loses in the next refactor.
 *
 * Widths are proportional, which means a single DANGEROUS dep among 340 gets a
 * hairline segment. `min-w` keeps a non-zero count visible: a segment you cannot
 * see is a count you cannot read, and the one dangerous dep is the entire point
 * of the screen.
 *
 * Zero-count segments are dropped rather than rendered at zero width — a label
 * with no bar is noise, and "0 dangerous" belongs in the summary line beneath,
 * which is the caller's copy. */

import { cn } from "../../lib/cn.ts";
import { HATCH_NEUTRAL } from "./hatch.ts";

export type SeverityRibbonProps = {
  dangerous: number;
  error: number;
  safe: number;
  /** Not yet concluded. Hatched neutral — progress is achromatic (§2.2). */
  pending: number;
  className?: string;
};

type Segment = {
  key: "dangerous" | "error" | "safe" | "pending";
  count: number;
  label: string;
  className: string;
  hatched?: boolean;
};

export function SeverityRibbon({
  dangerous,
  error,
  safe,
  pending,
  className,
}: SeverityRibbonProps) {
  const total = dangerous + error + safe + pending;

  // Order is fixed and is not sorted by count: DANGEROUS is always leftmost so
  // the eye lands on it first, even when it is the smallest segment.
  const ordered: Segment[] = [
    { key: "dangerous", count: dangerous, label: "dangerous", className: "bg-danger-wash text-danger-text" },
    { key: "error", count: error, label: "could not conclude", className: "bg-error-wash text-error-text" },
    { key: "safe", count: safe, label: "no threat found", className: "bg-safe-wash text-safe-text" },
    { key: "pending", count: pending, label: "running", className: "text-progress-ink", hatched: true },
  ];
  const segments = ordered.filter((segment) => segment.count > 0);

  if (total === 0) {
    // Nothing concluded and nothing pending. Hatched, because "no signal" is what
    // this is — but callers should generally render an `EmptyState` or a
    // `DegradedState` around it rather than shipping a bare mystery bar.
    return (
      <div
        aria-hidden="true"
        style={HATCH_NEUTRAL}
        className={cn("h-8 w-full rounded-sm border border-border-faint", className)}
      />
    );
  }

  return (
    // A real list, so the counts are navigable and the bar is not one opaque
    // `aria-label` blob. `role="img"` with a summary string would read faster but
    // would make the individual counts unreachable.
    <ul className={cn("flex w-full items-stretch gap-0.5", className)}>
      {segments.map((segment) => (
        <li
          key={segment.key}
          data-segment={segment.key}
          style={{
            // `flexBasis` in percent + `flexGrow: 0` gives honest proportions;
            // `minWidth` keeps a 1-in-340 segment clickable and readable.
            flexBasis: `${(segment.count / total) * 100}%`,
            flexGrow: 0,
            minWidth: "3.5rem",
            ...(segment.hatched ? HATCH_NEUTRAL : undefined),
          }}
          className={cn(
            "flex flex-col items-center justify-center rounded-sm border px-1 py-1",
            segment.hatched ? "border-border-faint" : "border-transparent",
            segment.className,
          )}
        >
          <span className="font-mono text-sm tabular-nums leading-none">{segment.count}</span>
          <span className="mt-0.5 truncate text-2xs leading-none">{segment.label}</span>
        </li>
      ))}
    </ul>
  );
}
