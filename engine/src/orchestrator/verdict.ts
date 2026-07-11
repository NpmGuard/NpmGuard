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
 *   any CONFIRMED → DANGEROUS (cited dynamic proof — precedence over everything)
 *   else          → SAFE      (every suspicion ran and showed no malice)
 *
 * DANGEROUS wins even if a sibling hypothesis could not be evaluated: proven
 * malice is proven regardless of what else flaked. Only when NOTHING is
 * confirmed does a DEFERRED node block the verdict — and the pipeline raises
 * AuditIncompleteError before this runs in that case, so a SAFE here stands over
 * a fully-refuted graph. OPEN/IN_PROGRESS never reach the verdict; the
 * orchestrator resolves every node.
 */
export function deriveGraphVerdict(graph: HypothesisGraph): GraphVerdictReport {
  const hypotheses = graph.all();
  const counts = bucket(hypotheses);
  const confirmedHypIds = hypotheses.filter((h) => h.state === "CONFIRMED").map((h) => h.hypId);

  assert(
    counts.open === 0 && counts.inProgress === 0,
    `deriveGraphVerdict: ${counts.open + counts.inProgress} unresolved node(s) — dispatch did not finish`,
  );

  if (counts.confirmed > 0) {
    return {
      verdict: "DANGEROUS",
      rationale: `${counts.confirmed} confirmed hypothes${counts.confirmed === 1 ? "is" : "es"} with cited dynamic evidence.`,
      counts,
      confirmedHypIds,
    };
  }

  // No confirmed → SAFE requires every suspicion to have RUN and refuted. A
  // DEFERRED (unevaluated) node means we could not clear it — the pipeline raises
  // AuditIncompleteError before reaching here, so this asserts an all-refuted graph.
  assert(
    counts.deferred === 0,
    `deriveGraphVerdict: SAFE with ${counts.deferred} unevaluated node(s) — pipeline should have raised`,
  );

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
