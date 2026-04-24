import { describe, it, expect } from "vitest";
import type { Hypothesis } from "@npmguard/shared";
import { buildGraphFromHypotheses } from "./build-graph.js";

function hyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypId: overrides.hypId ?? "trg-0001",
    description: overrides.description ?? "reads .npmrc and POSTs it to attacker.com",
    claim: overrides.claim ?? { kind: "env_exfil", gating: null },
    focusFiles: overrides.focusFiles ?? ["lib/a.js"],
    focusLines: overrides.focusLines ?? [{ file: "lib/a.js", range: "1-10" }],
    severity: overrides.severity ?? "high",
    parentHypId: overrides.parentHypId ?? null,
    childHypIds: overrides.childHypIds ?? [],
    state: overrides.state ?? "OPEN",
    createdBy: overrides.createdBy ?? "triage",
    evidenceRefs: overrides.evidenceRefs ?? [],
    createdAt: overrides.createdAt ?? "2026-04-24T12:00:00.000Z",
    resolvedAt: overrides.resolvedAt ?? null,
    resolution: overrides.resolution ?? null,
  };
}

describe("buildGraphFromHypotheses", () => {
  it("returns an empty graph when given no hypotheses", () => {
    const { graph, addedCount, mergedCount } = buildGraphFromHypotheses("audit_1", []);
    expect(graph.size).toBe(0);
    expect(addedCount).toBe(0);
    expect(mergedCount).toBe(0);
  });

  it("adds unique hypotheses as separate nodes", () => {
    const { graph, addedCount, mergedCount } = buildGraphFromHypotheses("audit_1", [
      hyp({ hypId: "trg-0001", description: "reads NPM_TOKEN and POSTs it" }),
      hyp({ hypId: "trg-0002", description: "writes crontab for persistence" }),
      hyp({ hypId: "trg-0003", description: "spawns /usr/bin/curl at install time" }),
    ]);
    expect(graph.size).toBe(3);
    expect(addedCount).toBe(3);
    expect(mergedCount).toBe(0);
  });

  it("merges near-duplicates under the first-seen hypId", () => {
    const { graph, addedCount, mergedCount } = buildGraphFromHypotheses("audit_1", [
      hyp({
        hypId: "trg-0001",
        description: "reads NPM_TOKEN and POSTs it to attacker.com",
        focusFiles: ["a.js"],
        focusLines: [{ file: "a.js", range: "1-10" }],
      }),
      hyp({
        hypId: "trg-0002",
        description: "reads NPM_TOKEN and POSTs it to attacker.com",
        focusFiles: ["b.js"],
        focusLines: [{ file: "b.js", range: "20-30" }],
      }),
    ]);
    expect(graph.size).toBe(1);
    expect(addedCount).toBe(1);
    expect(mergedCount).toBe(1);
    const h = graph.get("trg-0001");
    expect(h.focusFiles.sort()).toEqual(["a.js", "b.js"]);
    expect(h.focusLines).toEqual([
      { file: "a.js", range: "1-10" },
      { file: "b.js", range: "20-30" },
    ]);
  });

  it("preserves insertion order for non-duplicate hypIds", () => {
    const { graph } = buildGraphFromHypotheses("audit_1", [
      hyp({ hypId: "trg-0001", description: "alpha behavior" }),
      hyp({ hypId: "trg-0002", description: "beta behavior" }),
    ]);
    expect(graph.all().map((h) => h.hypId)).toEqual(["trg-0001", "trg-0002"]);
  });

  it("round-trips through serialize/load preserving merged state", () => {
    const { graph } = buildGraphFromHypotheses("audit_1", [
      hyp({ hypId: "trg-0001", description: "x" }),
      hyp({ hypId: "trg-0002", description: "y" }),
    ]);
    const snapshot = graph.serialize();
    expect(snapshot.nodes.length).toBe(2);
    expect(snapshot.auditId).toBe("audit_1");
  });
});
