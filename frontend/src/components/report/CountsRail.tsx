/**
 * CountsRail — a proportion bar over the hypothesis outcome counts.
 * Confirmed / refuted / deferred / in-progress / open render as tone segments.
 * Honest empty: when nothing was raised, we say so — never a row of zeros.
 */

import type { HypothesisCounts } from "../../lib/engine-types.ts";

export interface CountsRailProps {
  counts: HypothesisCounts;
}

type Bucket = {
  key: keyof Omit<HypothesisCounts, "total">;
  label: string;
  seg: "danger" | "safe" | "suspect" | "running" | "unknown";
};

// Most-consequential first (drives both the rail order and the legend order).
const BUCKETS: readonly Bucket[] = [
  { key: "confirmed", label: "Confirmed", seg: "danger" },
  { key: "refuted", label: "Refuted", seg: "safe" },
  { key: "deferred", label: "Deferred", seg: "suspect" },
  { key: "inProgress", label: "In progress", seg: "running" },
  { key: "open", label: "Open", seg: "unknown" },
];

export function CountsRail({ counts }: CountsRailProps) {
  if (counts.total === 0) {
    return <p className="report-counts__empty subtext">No hypotheses raised</p>;
  }

  const present = BUCKETS.filter((b) => counts[b.key] > 0);

  return (
    <div className="report-counts">
      <div className="rail" role="img" aria-label={`${counts.total} hypotheses`}>
        {present.map((b) => (
          <span
            key={b.key}
            className={`rail__seg rail__seg--${b.seg}`}
            style={{ flexGrow: counts[b.key] }}
          />
        ))}
      </div>
      <ul className="report-counts__legend">
        {present.map((b) => (
          <li key={b.key} className="report-counts__item">
            <span className={`dot dot--${b.seg}`} aria-hidden="true" />
            <span className="report-counts__num mono">{counts[b.key]}</span>
            <span className="microtext">{b.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
