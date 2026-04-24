import type { HypothesisGraph } from "../graph/hypothesis-graph.js";
import type { Hypothesis } from "@npmguard/shared";

/**
 * The hypothesis-graph-derived verdict. Distinct from the cross-process
 * `VerdictEnum` (SAFE | DANGEROUS) which is exposed on AuditReport today;
 * this one is richer and will replace it once the workers land and the
 * graph starts containing terminal states.
 */
export type GraphVerdict = "SAFE" | "SUSPECT" | "DANGEROUS" | "UNKNOWN";

export interface GraphVerdictReport {
  verdict: GraphVerdict;
  rationale: string;
  counts: {
    total: number;
    open: number;
    inProgress: number;
    confirmed: number;
    refuted: number;
    inconclusive: number;
    deferred: number;
  };
  confirmedHypIds: string[];
}

function bucket(hypotheses: readonly Hypothesis[]): GraphVerdictReport["counts"] {
  const counts = {
    total: hypotheses.length,
    open: 0,
    inProgress: 0,
    confirmed: 0,
    refuted: 0,
    inconclusive: 0,
    deferred: 0,
  };
  for (const h of hypotheses) {
    switch (h.state) {
      case "OPEN":
        counts.open += 1;
        break;
      case "IN_PROGRESS":
        counts.inProgress += 1;
        break;
      case "CONFIRMED":
        counts.confirmed += 1;
        break;
      case "REFUTED":
        counts.refuted += 1;
        break;
      case "INCONCLUSIVE":
        counts.inconclusive += 1;
        break;
      case "DEFERRED":
        counts.deferred += 1;
        break;
    }
  }
  return counts;
}

/**
 * Derive a verdict from a hypothesis graph.
 *
 * Rules, applied top-down:
 *  - any CONFIRMED → DANGEROUS
 *  - empty graph OR every node REFUTED → SAFE
 *  - no terminal states yet (any OPEN/IN_PROGRESS) → SUSPECT
 *  - all resolved with no CONFIRMED but at least one INCONCLUSIVE/DEFERRED
 *    → UNKNOWN (couldn't prove, couldn't disprove)
 *
 * The returned `rationale` is a short one-sentence explanation suitable for
 * a report header; `counts` is for per-state display; `confirmedHypIds`
 * gives downstream a direct pointer to the nodes justifying DANGEROUS.
 */
export function deriveGraphVerdict(graph: HypothesisGraph): GraphVerdictReport {
  const hypotheses = graph.all();
  const counts = bucket(hypotheses);
  const confirmedHypIds = hypotheses
    .filter((h) => h.state === "CONFIRMED")
    .map((h) => h.hypId);

  if (counts.confirmed > 0) {
    return {
      verdict: "DANGEROUS",
      rationale: `${counts.confirmed} confirmed hypothes${counts.confirmed === 1 ? "is" : "es"} with dynamic evidence.`,
      counts,
      confirmedHypIds,
    };
  }

  if (counts.total === 0) {
    return {
      verdict: "SAFE",
      rationale: "No hypotheses were emitted during triage.",
      counts,
      confirmedHypIds,
    };
  }

  if (counts.refuted === counts.total) {
    return {
      verdict: "SAFE",
      rationale: `All ${counts.total} hypothes${counts.total === 1 ? "is was" : "es were"} refuted by evidence.`,
      counts,
      confirmedHypIds,
    };
  }

  if (counts.open > 0 || counts.inProgress > 0) {
    const pending = counts.open + counts.inProgress;
    return {
      verdict: "SUSPECT",
      rationale: `${pending} hypothes${pending === 1 ? "is" : "es"} still pending (${counts.open} open, ${counts.inProgress} in-progress).`,
      counts,
      confirmedHypIds,
    };
  }

  // All resolved, no CONFIRMED, some INCONCLUSIVE/DEFERRED
  const unresolved = counts.inconclusive + counts.deferred;
  return {
    verdict: "UNKNOWN",
    rationale: `${unresolved} hypothes${unresolved === 1 ? "is" : "es"} could neither be confirmed nor refuted (${counts.inconclusive} inconclusive, ${counts.deferred} deferred).`,
    counts,
    confirmedHypIds,
  };
}
