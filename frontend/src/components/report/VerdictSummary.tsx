/**
 * VerdictSummary — the toned headline card of a report: a large verdict badge,
 * the model's rationale, and the counts rail. Rendered by both the durable
 * Report page and the Live Audit verdict reveal.
 */

import type { CSSProperties } from "react";
import type { HypothesisCounts, Verdict } from "../../lib/engine-types.ts";
import { verdictTone } from "../../lib/report-helpers.ts";
import { CountsRail } from "./CountsRail.tsx";

export interface VerdictSummaryProps {
  verdict: Verdict;
  rationale: string;
  counts: HypothesisCounts;
}

export function VerdictSummary({ verdict, rationale, counts }: VerdictSummaryProps) {
  const tone = verdictTone(verdict); // "safe" | "danger"
  const accent = { "--accent": `var(--${tone})` } as CSSProperties;

  return (
    <section className="card card--accent report-verdict" style={accent}>
      <div className="report-verdict__top">
        <span className={`pill pill--${tone} report-verdict__badge`}>{verdict}</span>
      </div>
      {rationale ? <p className="report-verdict__rationale">{rationale}</p> : null}
      <CountsRail counts={counts} />
    </section>
  );
}
