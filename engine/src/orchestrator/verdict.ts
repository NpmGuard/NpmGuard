import assert from "node:assert";
import type { HypothesisGraph } from "../graph/hypothesis-graph.js";
import type { Hypothesis, HypothesisCounts, VerdictEnum } from "@npmguard/shared";

/**
 * The verdict of a completed audit, derived from the resolved hypothesis graph.
 * The graph is the single truth-producing artifact; this pure function is the
 * authoritative reducer over its two possible outcomes.
 */
export type GraphVerdict = VerdictEnum;

export interface GraphVerdictReport {
  verdict: GraphVerdict;
  rationale: string;
  counts: HypothesisCounts;
  confirmedHypIds: string[];
}

function bucket(hypotheses: readonly Hypothesis[]): HypothesisCounts {
  const counts = {
    total: hypotheses.length,
    open: 0,
    inProgress: 0,
    confirmed: 0,
    refuted: 0,
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
      case "DEFERRED":
        counts.deferred += 1;
        break;
    }
  }
  return counts;
}

/**
 * Derive the verdict of a completed audit:
 *   any CONFIRMED → DANGEROUS (cited dynamic proof)
 *   else          → SAFE      (every suspicion ran and showed no malice)
 *
 * INVARIANT: the graph is fully resolved to CONFIRMED/REFUTED. An unresolved
 * node (OPEN/IN_PROGRESS) or a DEFERRED one means the audit did not complete —
 * the pipeline raises AuditIncompleteError before this runs, so those states
 * cannot reach here. A verdict is only ever issued over a completed audit.
 */
export function deriveGraphVerdict(graph: HypothesisGraph): GraphVerdictReport {
  const hypotheses = graph.all();
  for (const h of hypotheses) {
    assert(
      h.state === "CONFIRMED" || h.state === "REFUTED",
      `deriveGraphVerdict: unresolved node ${h.hypId} (${h.state}) — audit did not complete`,
    );
  }

  const counts = bucket(hypotheses);
  const confirmedHypIds = hypotheses.filter((h) => h.state === "CONFIRMED").map((h) => h.hypId);

  if (counts.confirmed > 0) {
    return {
      verdict: "DANGEROUS",
      rationale: `${counts.confirmed} confirmed hypothes${counts.confirmed === 1 ? "is" : "es"} with cited dynamic evidence.`,
      counts,
      confirmedHypIds,
    };
  }

  return {
    verdict: "SAFE",
    rationale:
      counts.total === 0
        ? "No suspicions were raised."
        : `All ${counts.total} suspicion${counts.total === 1 ? "" : "s"} ran and showed no malice.`,
    counts,
    confirmedHypIds,
  };
}
