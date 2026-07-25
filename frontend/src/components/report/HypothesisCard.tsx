/**
 * HypothesisCard — one hypothesis node, carrying its claim label, severity chip,
 * resolution state stamp, description and focus files.
 * Status lives on the datum (hyp.state / hyp.severity) — never in component state.
 *
 * The colour rule is NOT here: `report-helpers.ts` owns it, because the live
 * stream (`audit/HypothesisList`) renders the same node and the two must not
 * disagree about what red means. See the header there — severity is the severity
 * of a CLAIM, so it earns a hue only once the claim is CONFIRMED, and DEFERRED
 * is a prominent `error`-violet outcome rather than a greyed-out afterthought
 * (§3.3 / F-I5: showing what the tool could NOT prove is as persuasive as a
 * catch).
 */

import type { Hypothesis } from "@npmguard/shared";
import {
  claimLabel,
  hypothesisRule,
  hypothesisSeverityTone,
  hypothesisTone,
  STATE_LABELS,
} from "../../lib/report-helpers.ts";
import { Badge } from "../ui/badge.tsx";
import { Card } from "../ui/card.tsx";
import { HypothesisStateStamp } from "../ui/verdict-stamp.tsx";

export interface HypothesisCardProps {
  hyp: Hypothesis;
}

export function HypothesisCard({ hyp }: HypothesisCardProps) {
  return (
    <Card severity={hypothesisRule(hyp.state)} className="grid gap-2.5 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-medium text-text">
          {claimLabel(hyp.claim.kind)}
        </span>
        <Badge tone={hypothesisSeverityTone(hyp.state, hyp.severity)}>{hyp.severity}</Badge>
        <HypothesisStateStamp
          state={hyp.state}
          tone={hypothesisTone(hyp.state)}
          label={STATE_LABELS[hyp.state]}
        />
      </header>

      {hyp.description ? <p className="text-sm text-text-2">{hyp.description}</p> : null}

      {hyp.resolution?.reason ? (
        <p className="text-2xs text-text-3">
          {/* Who resolved it, in mono: the resolver is a machine-authored fact
              (§2.7), and naming it is what makes the reason auditable. */}
          <span className="mr-1.5 font-mono text-text-2">{hyp.resolution.by || "resolved"}</span>
          {hyp.resolution.reason}
        </p>
      ) : null}

      {hyp.focusFiles.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {hyp.focusFiles.map((file) => (
            <Badge key={file} mono>
              {file}
            </Badge>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
