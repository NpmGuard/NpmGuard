import { describe, it, expect } from "vitest";
import { HypothesisGraph } from "./hypothesis-graph.js";
import { nextOpen } from "./priority-queue.js";
import type { Hypothesis, HypothesisSeverity } from "@npmguard/shared";

function h(
  overrides: Partial<Hypothesis> &
    Pick<Hypothesis, "hypId" | "severity" | "createdAt"> & { state?: Hypothesis["state"] },
): Hypothesis {
  return {
    hypId: overrides.hypId,
    description: overrides.description ?? `hyp ${overrides.hypId}`,
    claim: overrides.claim ?? { kind: "env_exfil", gating: null },
    focusFiles: overrides.focusFiles ?? [],
    focusLines: overrides.focusLines ?? [],
    experiment: overrides.experiment ?? [],
    severity: overrides.severity,
    parentHypId: null,
    childHypIds: [],
    state: overrides.state ?? "OPEN",
    createdBy: "triage",
    evidenceRefs: [],
    createdAt: overrides.createdAt,
    resolvedAt: null,
    resolution: null,
  };
}

describe("nextOpen", () => {
  it("returns null for an empty graph", () => {
    const g = new HypothesisGraph("a");
    expect(nextOpen(g)).toBeNull();
  });

  it("returns null when no OPEN hypotheses remain", () => {
    const g = new HypothesisGraph("a");
    g.add(h({ hypId: "1", severity: "high", createdAt: "2026-01-01T00:00:00Z", state: "IN_PROGRESS" }));
    expect(nextOpen(g)).toBeNull();
  });

  it("returns the only OPEN hypothesis", () => {
    const g = new HypothesisGraph("a");
    g.add(h({ hypId: "solo", severity: "medium", createdAt: "2026-01-01T00:00:00Z" }));
    expect(nextOpen(g)?.hypId).toBe("solo");
  });

  it("prefers higher severity over age", () => {
    const g = new HypothesisGraph("a");
    g.add(h({ hypId: "old_low", severity: "low", createdAt: "2026-01-01T00:00:00Z" }));
    g.add(h({ hypId: "new_critical", severity: "critical", createdAt: "2026-04-01T00:00:00Z" }));
    g.add(h({ hypId: "mid_high", severity: "high", createdAt: "2026-02-01T00:00:00Z" }));
    expect(nextOpen(g)?.hypId).toBe("new_critical");
  });

  it("breaks severity ties by oldest createdAt", () => {
    const g = new HypothesisGraph("a");
    g.add(h({ hypId: "newer", severity: "high", createdAt: "2026-02-01T00:00:00Z" }));
    g.add(h({ hypId: "older", severity: "high", createdAt: "2026-01-01T00:00:00Z" }));
    expect(nextOpen(g)?.hypId).toBe("older");
  });

  it("ignores IN_PROGRESS / terminal nodes", () => {
    const g = new HypothesisGraph("a");
    g.add(h({ hypId: "ip", severity: "critical", createdAt: "2026-01-01T00:00:00Z", state: "IN_PROGRESS" }));
    g.add(h({ hypId: "op", severity: "low", createdAt: "2026-02-01T00:00:00Z" }));
    expect(nextOpen(g)?.hypId).toBe("op");
  });

  it("is deterministic (same graph → same next)", () => {
    const g = new HypothesisGraph("a");
    const severities: HypothesisSeverity[] = ["high", "medium", "high", "low"];
    for (let i = 0; i < severities.length; i++) {
      g.add(
        h({
          hypId: `hyp_${i}`,
          severity: severities[i]!,
          createdAt: `2026-0${i + 1}-01T00:00:00Z`,
        }),
      );
    }
    const first = nextOpen(g);
    const second = nextOpen(g);
    expect(first?.hypId).toBe(second?.hypId);
  });
});
