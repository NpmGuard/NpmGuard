/**
 * VerdictSummary — the headline card of a report: the verdict, its mandatory
 * caveat and coverage, the model's rationale, and the counts rail. Rendered by
 * both the durable Report page and the Live Audit verdict reveal.
 *
 * The verdict is `VerdictHeadline`, not a locally-styled badge, and that is the
 * load-bearing part: §3.3 requires the large verdict to carry its caveat ("No
 * confirmed threat found. Not a proof of absence.") and its coverage counts as
 * part of the COMPONENT, so no surface can render a big green SAFE and forget
 * them. This card used to render `pill--{tone}` with the bare word and nothing
 * else — precisely the overstatement §0 calls a credibility failure.
 */

import type { HypothesisCounts, VerdictEnum } from "@npmguard/shared";
import { CountsRail } from "./CountsRail.tsx";
import { Card } from "../ui/card.tsx";
import { VerdictHeadline } from "../ui/verdict-stamp.tsx";

export interface VerdictSummaryProps {
  verdict: VerdictEnum;
  rationale: string;
  counts: HypothesisCounts;
}

export function VerdictSummary({ verdict, rationale, counts }: VerdictSummaryProps) {
  return (
    <Card
      // Only DANGEROUS earns the 3px rule. `Card` has no `safe` arm by design
      // (§0 rule 1) — the absence of a rule IS the SAFE treatment.
      severity={verdict === "DANGEROUS" ? "danger" : undefined}
      className="grid gap-3 p-4"
    >
      <VerdictHeadline outcome={verdict} counts={counts} />
      {rationale ? <p className="text-sm text-text">{rationale}</p> : null}
      {/* The rail is a breakdown OF the coverage line above it. With nothing
          raised there is no breakdown to draw, and `VerdictHeadline` has already
          said so in words — rendering the rail's own empty here made a SAFE
          report say "no hypotheses" three times in four lines. */}
      {counts.total > 0 ? <CountsRail counts={counts} /> : null}
    </Card>
  );
}
