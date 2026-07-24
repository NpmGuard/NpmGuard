/**
 * HypothesisList — store.hypotheses (the fold's HypothesisView[]) as severity-
 * toned accent cards. The state pill updates in place by hypId (OPEN/IN_PROGRESS
 * → running, CONFIRMED → danger, REFUTED → safe, DEFERRED → suspect); the
 * resolution reason appears once resolved. Status lives on the datum. This is the
 * live-stream view — the durable report reuses report/HypothesisCard (full node).
 */

import type { CSSProperties } from "react";
import { useAuditStore } from "../../stores/auditStore.ts";
import type { HypothesisView } from "../../lib/audit-fold.ts";
import type { HypothesisState } from "../../lib/engine-types.ts";
import { bySeverityDesc, claimLabel, STATE_LABELS } from "../../lib/report-helpers.ts";

function severityAccent(severity: string): string {
  if (severity === "critical" || severity === "high") return "var(--danger)";
  if (severity === "medium") return "var(--suspect)";
  return "var(--tone-paper-accent)";
}

function severityTagClass(severity: string): string {
  if (severity === "critical" || severity === "high") return "tag tag--danger";
  if (severity === "medium") return "tag tag--suspect";
  return "tag";
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

export function HypothesisList() {
  const hypotheses = useAuditStore((s) => s.hypotheses);

  if (hypotheses.length === 0) {
    return <p className="subtext audit-side__empty">No hypotheses raised yet</p>;
  }

  const ordered = bySeverityDesc<HypothesisView>(hypotheses);

  return (
    <ul className="audit-hyps">
      {ordered.map((h) => {
        const accent = { "--accent": severityAccent(h.severity) } as CSSProperties;
        return (
          <li key={h.hypId}>
            <article className="card card--accent audit-hyp" style={accent}>
              <div className="audit-hyp__head">
                <span className="audit-hyp__claim">{claimLabel(h.claim)}</span>
                <span className={severityTagClass(h.severity)}>{h.severity}</span>
                <span className={`pill pill--${stateTone(h.state)}`}>{STATE_LABELS[h.state]}</span>
              </div>
              {h.file ? <span className="tag mono audit-hyp__file">{h.file}</span> : null}
              {h.reason ? <p className="microtext audit-hyp__reason">{h.reason}</p> : null}
            </article>
          </li>
        );
      })}
    </ul>
  );
}
