import type { Hypothesis } from "@npmguard/shared";
import { HypothesisGraph } from "../graph/hypothesis-graph.js";

export interface BuildGraphResult {
  graph: HypothesisGraph;
  /** Count of candidate hypotheses that merged into an existing node. */
  mergedCount: number;
  /** Count of candidate hypotheses added as new nodes. */
  addedCount: number;
}

/**
 * Build a HypothesisGraph from an ordered list of triage-emitted hypotheses.
 * Later emitters (workers, cross-run correlator) will use the same dedup-on-add
 * path. Adding is stable: first occurrence wins its hypId; duplicates fold
 * their focus into the survivor.
 */
export function buildGraphFromHypotheses(
  auditId: string,
  hypotheses: Hypothesis[],
): BuildGraphResult {
  const graph = new HypothesisGraph(auditId);
  let mergedCount = 0;
  let addedCount = 0;
  for (const h of hypotheses) {
    const { merged } = graph.addOrMerge(h);
    if (merged) mergedCount += 1;
    else addedCount += 1;
  }
  return { graph, mergedCount, addedCount };
}
