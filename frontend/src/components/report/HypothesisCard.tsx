/**
 * HypothesisCard — one hypothesis node, carrying its claim label, severity tag,
 * resolution state pill, description and focus files.
 * Status lives on the datum (hyp.state / hyp.severity) — never in component state.
 *
 * The colour rule is NOT here: `report-helpers.ts` owns it, because the live
 * stream (`audit/HypothesisList`) renders the same node and the two must not
 * disagree about what red means. See the header there — severity is the severity
 * of a CLAIM, so it earns a hue only once the claim is CONFIRMED.
 */

import type { CSSProperties } from "react";
import type { Hypothesis } from "@npmguard/shared";
import {
  claimLabel,
  hypothesisAccentVar,
  hypothesisSeverityTagClass,
  hypothesisStatePillClass,
  STATE_LABELS,
} from "../../lib/report-helpers.ts";

export interface HypothesisCardProps {
  hyp: Hypothesis;
}

export function HypothesisCard({ hyp }: HypothesisCardProps) {
  const accent = { "--accent": hypothesisAccentVar(hyp.state, hyp.severity) } as CSSProperties;

  return (
    <article className="card card--accent report-hyp" style={accent}>
      <header className="report-hyp__head">
        <span className="report-hyp__claim">{claimLabel(hyp.claim.kind)}</span>
        <span className={hypothesisSeverityTagClass(hyp.state, hyp.severity)}>{hyp.severity}</span>
        <span className={hypothesisStatePillClass(hyp.state)}>{STATE_LABELS[hyp.state]}</span>
      </header>

      {hyp.description ? <p className="report-hyp__desc subtext">{hyp.description}</p> : null}

      {hyp.resolution?.reason ? (
        <p className="report-hyp__reason microtext">
          <span className="report-hyp__reason-label mono">{hyp.resolution.by || "resolved"}</span>
          {hyp.resolution.reason}
        </p>
      ) : null}

      {hyp.focusFiles.length > 0 ? (
        <div className="report-hyp__files">
          {hyp.focusFiles.map((file) => (
            <span key={file} className="tag mono">
              {file}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}
