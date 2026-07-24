/**
 * HypothesisCard — one hypothesis node, toned by severity, carrying its claim
 * label, severity tag, resolution state pill, description and focus files.
 * Status lives on the datum (hyp.state / hyp.severity) — never in component state.
 */

import type { CSSProperties } from "react";
import type { Hypothesis, HypothesisSeverity, HypothesisState } from "../../lib/engine-types.ts";
import { claimLabel, STATE_LABELS } from "../../lib/report-helpers.ts";

export interface HypothesisCardProps {
  hyp: Hypothesis;
}

function severityAccent(severity: HypothesisSeverity): string {
  switch (severity) {
    case "critical":
    case "high":
      return "var(--danger)";
    case "medium":
      return "var(--suspect)";
    case "low":
      return "var(--tone-paper-accent)";
  }
}

function severityTagClass(severity: HypothesisSeverity): string {
  switch (severity) {
    case "critical":
    case "high":
      return "tag tag--danger";
    case "medium":
      return "tag tag--suspect";
    case "low":
      return "tag";
  }
}

function stateTone(state: HypothesisState): "danger" | "safe" | "suspect" | "running" {
  switch (state) {
    case "CONFIRMED":
      return "danger";
    case "REFUTED":
      return "safe";
    case "DEFERRED":
      return "suspect";
    case "OPEN":
    case "IN_PROGRESS":
      return "running";
  }
}

export function HypothesisCard({ hyp }: HypothesisCardProps) {
  const accent = { "--accent": severityAccent(hyp.severity) } as CSSProperties;

  return (
    <article className="card card--accent report-hyp" style={accent}>
      <header className="report-hyp__head">
        <span className="report-hyp__claim">{claimLabel(hyp.claim.kind)}</span>
        <span className={severityTagClass(hyp.severity)}>{hyp.severity}</span>
        <span className={`pill pill--${stateTone(hyp.state)}`}>{STATE_LABELS[hyp.state]}</span>
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
