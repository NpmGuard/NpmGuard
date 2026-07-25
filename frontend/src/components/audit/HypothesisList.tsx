/**
 * HypothesisList — store.hypotheses (the fold's HypothesisView[]) as cards.
 * The state stamp updates in place by hypId; the resolution reason appears once
 * resolved. Status lives on the datum. This is the live-stream view — the
 * durable report reuses report/HypothesisCard (full node), and BOTH read the
 * colour rule from `report-helpers.ts` so a hypothesis cannot look like a threat
 * live and a non-threat in the report.
 *
 * On the token layer the two views also share the STAMP itself
 * (`ui/verdict-stamp.tsx::HypothesisStateStamp`), so the only thing that can
 * differ between the live view and the durable one is the data.
 */

import { useAuditStore } from "../../stores/auditStore.ts";
import type { HypothesisView } from "../../lib/audit-fold.ts";
import {
  byImportanceDesc,
  claimLabel,
  hypothesisRule,
  hypothesisSeverityTone,
  hypothesisTone,
  STATE_LABELS,
} from "../../lib/report-helpers.ts";
import { Badge } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import { HypothesisStateStamp } from "../ui/verdict-stamp.tsx";

export function HypothesisList() {
  const hypotheses = useAuditStore((s) => s.hypotheses);

  if (hypotheses.length === 0) {
    // Deliberately not `EmptyState`: this is a live stream that has not produced
    // anything YET, which is the progress axis rather than a settled empty read.
    // The full achromatic empty treatment would imply the investigation had
    // concluded with nothing to say.
    return <p className="px-4 py-3 text-sm text-text-3">No hypotheses raised yet</p>;
  }

  const ordered = byImportanceDesc<HypothesisView>(hypotheses);

  return (
    <ul className="grid gap-2 p-3">
      {ordered.map((h) => (
        <li key={h.hypId}>
          <Card severity={hypothesisRule(h.state)} className="grid gap-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-sm font-medium text-text">
                {claimLabel(h.claim)}
              </span>
              <Badge tone={hypothesisSeverityTone(h.state, h.severity)}>{h.severity}</Badge>
              <HypothesisStateStamp
                state={h.state}
                tone={hypothesisTone(h.state)}
                label={STATE_LABELS[h.state]}
              />
            </div>
            {h.file ? (
              <span className="justify-self-start">
                <Badge mono>{h.file}</Badge>
              </span>
            ) : null}
            {h.reason ? <p className="text-2xs text-text-3">{h.reason}</p> : null}
          </Card>
        </li>
      ))}
    </ul>
  );
}
