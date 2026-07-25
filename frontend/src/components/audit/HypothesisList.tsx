/**
 * HypothesisList — store.hypotheses (the fold's HypothesisView[]) as accent
 * cards. The state pill updates in place by hypId; the resolution reason appears
 * once resolved. Status lives on the datum. This is the live-stream view — the
 * durable report reuses report/HypothesisCard (full node), and BOTH read the
 * colour rule from `report-helpers.ts` so a hypothesis cannot look like a threat
 * live and a non-threat in the report.
 */

import type { CSSProperties } from "react";
import { useAuditStore } from "../../stores/auditStore.ts";
import type { HypothesisView } from "../../lib/audit-fold.ts";
import {
  byImportanceDesc,
  claimLabel,
  hypothesisAccentVar,
  hypothesisSeverityTagClass,
  hypothesisStatePillClass,
  STATE_LABELS,
} from "../../lib/report-helpers.ts";

export function HypothesisList() {
  const hypotheses = useAuditStore((s) => s.hypotheses);

  if (hypotheses.length === 0) {
    return <p className="subtext audit-side__empty">No hypotheses raised yet</p>;
  }

  const ordered = byImportanceDesc<HypothesisView>(hypotheses);

  return (
    <ul className="audit-hyps">
      {ordered.map((h) => {
        const accent = { "--accent": hypothesisAccentVar(h.state, h.severity) } as CSSProperties;
        return (
          <li key={h.hypId}>
            <article className="card card--accent audit-hyp" style={accent}>
              <div className="audit-hyp__head">
                <span className="audit-hyp__claim">{claimLabel(h.claim)}</span>
                <span className={hypothesisSeverityTagClass(h.state, h.severity)}>{h.severity}</span>
                <span className={hypothesisStatePillClass(h.state)}>{STATE_LABELS[h.state]}</span>
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
