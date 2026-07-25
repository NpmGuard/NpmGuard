/**
 * CountsRail — a proportion bar over the hypothesis outcome counts, plus its
 * legend. Honest empty: when nothing was raised we say so, never a row of zeros.
 *
 * The colour rule is the same one `report-helpers.ts` states for the cards, and
 * it has to be, or the same investigation would be coloured two ways on one
 * screen: `confirmed` is the only red, `refuted` the only green, DEFERRED is the
 * `error` violet (§3.3 — a hypothesis we could not decide is a first-class
 * outcome, not a grey afterthought), and the two progress buckets are
 * achromatic because they are not outcomes at all.
 *
 * The legend is not decoration. §2.4 forbids colour-only encoding, so each
 * segment's meaning is carried by its labelled legend row; the bar alone would
 * be unreadable in greyscale, in `forced-colors`, and to a third of colourblind
 * readers for the red/green pair specifically.
 */

import type { HypothesisCounts } from "@npmguard/shared";
import { HATCH_NEUTRAL } from "../ui/hatch.ts";

export interface CountsRailProps {
  counts: HypothesisCounts;
}

type Seg = "confirmed" | "refuted" | "deferred" | "progress";

type Bucket = {
  key: keyof Omit<HypothesisCounts, "total">;
  label: string;
  seg: Seg;
};

// Most-consequential first (drives both the rail order and the legend order).
const BUCKETS: readonly Bucket[] = [
  { key: "confirmed", label: "Confirmed", seg: "confirmed" },
  { key: "deferred", label: "Could not decide", seg: "deferred" },
  { key: "refuted", label: "Refuted", seg: "refuted" },
  { key: "inProgress", label: "In progress", seg: "progress" },
  { key: "open", label: "Open", seg: "progress" },
];

const SEG_FILL: Record<Seg, string> = {
  confirmed: "bg-danger",
  deferred: "bg-error",
  refuted: "bg-safe",
  // Achromatic: still-running work is the progress axis and must never read as
  // a result. Hatched rather than flat, because "not yet known" is exactly what
  // the system's one no-signal texture means.
  progress: "bg-progress-track",
};

const DOT_FILL: Record<Seg, string> = {
  confirmed: "bg-danger",
  deferred: "bg-error",
  refuted: "bg-safe",
  progress: "bg-progress-hatch",
};

export function CountsRail({ counts }: CountsRailProps) {
  if (counts.total === 0) {
    return <p className="text-sm text-text-3">No hypotheses raised</p>;
  }

  const present = BUCKETS.filter((b) => counts[b.key] > 0);

  return (
    <div className="grid gap-2">
      <div
        role="img"
        // The TOTAL leads, then the breakdown. The denominator is the part §0
        // insists a verdict never appears without, and a label that listed only
        // the buckets would drop it.
        aria-label={`${counts.total} hypotheses: ${present
          .map((b) => `${counts[b.key]} ${b.label.toLowerCase()}`)
          .join(", ")}`}
        className="flex h-1.5 gap-0.5 overflow-hidden rounded-full"
      >
        {present.map((b) => (
          <span
            key={b.key}
            className={SEG_FILL[b.seg]}
            style={{
              flexGrow: counts[b.key],
              ...(b.seg === "progress" ? HATCH_NEUTRAL : null),
            }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {present.map((b) => (
          <li key={b.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT_FILL[b.seg]}`} />
            <span className="font-mono text-2xs tabular-nums text-text">{counts[b.key]}</span>
            <span className="text-2xs text-text-3">{b.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
