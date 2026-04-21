import type { Hypothesis, HypothesisSeverity } from "@npmguard/shared";
import type { HypothesisGraph } from "./hypothesis-graph.js";

const SEVERITY_ORDER: Record<HypothesisSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Pick the next OPEN hypothesis to dispatch, ranked by:
 *  1. Severity descending (critical > high > medium > low)
 *  2. Age ascending — older (earlier createdAt) first within the same severity
 *
 * Pure function: given the same graph state, always returns the same result.
 * Returns null when no OPEN hypotheses remain.
 */
export function nextOpen(graph: HypothesisGraph): Hypothesis | null {
  const opens = graph.filterByState("OPEN");
  if (opens.length === 0) return null;

  opens.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return a.createdAt.localeCompare(b.createdAt);
  });

  return opens[0]!;
}
