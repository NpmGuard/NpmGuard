import { describe, it, expect } from "vitest";
import type { Hypothesis, EvidenceRef } from "@npmguard/shared";
import { HypothesisGraph } from "../graph/hypothesis-graph.js";
import { deriveGraphVerdict } from "./verdict.js";

function baseline(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypId: overrides.hypId ?? "hyp_001",
    description: overrides.description ?? "test",
    claim: overrides.claim ?? { kind: "env_exfil", gating: null },
    focusFiles: overrides.focusFiles ?? ["a.js"],
    focusLines: overrides.focusLines ?? [{ file: "a.js", range: "1-10" }],
    experiment: overrides.experiment ?? [],
    severity: overrides.severity ?? "medium",
    parentHypId: overrides.parentHypId ?? null,
    childHypIds: overrides.childHypIds ?? [],
    state: overrides.state ?? "OPEN",
    createdBy: overrides.createdBy ?? "hypothesize",
    evidenceRefs: overrides.evidenceRefs ?? [],
    createdAt: overrides.createdAt ?? "2026-04-24T12:00:00.000Z",
    resolvedAt: overrides.resolvedAt ?? null,
    resolution: overrides.resolution ?? null,
  };
}

const ref: EvidenceRef = { kind: "run", id: "run_1", hash: "h1" };

// ---------------------------------------------------------------------------
// SAFE — the audit completed and found no malice (presumption of innocence)
// ---------------------------------------------------------------------------

describe("deriveGraphVerdict — SAFE", () => {
  it("empty graph → SAFE (nothing was suspected)", () => {
    const g = new HypothesisGraph("a1");
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("SAFE");
    expect(r.counts.total).toBe(0);
    expect(r.rationale).toMatch(/no suspicions/i);
  });

  it("every hypothesis REFUTED by its run → SAFE", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.add(baseline({ hypId: "h2" }));
    g.transition("h1", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h2", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("SAFE");
    expect(r.counts.refuted).toBe(2);
    expect(r.rationale).toMatch(/no malice/i);
  });
});

// ---------------------------------------------------------------------------
// DANGEROUS — a CONFIRMED payload with cited dynamic proof
// ---------------------------------------------------------------------------

describe("deriveGraphVerdict — DANGEROUS", () => {
  it("any CONFIRMED → DANGEROUS", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.add(baseline({ hypId: "h2" }));
    g.transition("h1", { to: "CONFIRMED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h2", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("DANGEROUS");
    expect(r.counts.confirmed).toBe(1);
    expect(r.confirmedHypIds).toEqual(["h1"]);
  });

  it("DANGEROUS wins alongside REFUTED siblings", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.add(baseline({ hypId: "h2" }));
    g.transition("h1", { to: "CONFIRMED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h2", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("DANGEROUS");
    expect(r.counts.confirmed).toBe(1);
    expect(r.counts.refuted).toBe(1);
  });

  it("reports multiple confirmedHypIds in insertion order", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "first" }));
    g.add(baseline({ hypId: "second" }));
    g.transition("first", { to: "CONFIRMED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("second", { to: "CONFIRMED", by: "worker:experimenter", evidenceRefs: [ref] });
    const r = deriveGraphVerdict(g);
    expect(r.confirmedHypIds).toEqual(["first", "second"]);
  });
});

// ---------------------------------------------------------------------------
// A verdict is issued ONLY over a completed audit — an unresolved or DEFERRED
// node means the pipeline should have raised an ERROR before reaching here.
// ---------------------------------------------------------------------------

describe("deriveGraphVerdict — only over a completed audit", () => {
  it("throws on an OPEN node", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    expect(() => deriveGraphVerdict(g)).toThrow(/audit did not complete/);
  });

  it("throws on an IN_PROGRESS node", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.transition("h1", { to: "IN_PROGRESS", by: "orchestrator" });
    expect(() => deriveGraphVerdict(g)).toThrow(/audit did not complete/);
  });

  it("throws on a DEFERRED node (machinery broke → the audit is an ERROR)", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.transition("h1", { to: "DEFERRED", by: "worker:experimenter", reason: "sensor failed" });
    expect(() => deriveGraphVerdict(g)).toThrow(/audit did not complete/);
  });
});

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

describe("deriveGraphVerdict — counts shape", () => {
  it("tallies confirmed + refuted over a resolved graph", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h_confirmed" }));
    g.add(baseline({ hypId: "h_refuted_1" }));
    g.add(baseline({ hypId: "h_refuted_2" }));
    g.transition("h_confirmed", { to: "CONFIRMED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h_refuted_1", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h_refuted_2", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });

    const r = deriveGraphVerdict(g);
    expect(r.counts).toEqual({
      total: 3,
      open: 0,
      inProgress: 0,
      confirmed: 1,
      refuted: 2,
      deferred: 0,
    });
    expect(r.verdict).toBe("DANGEROUS");
  });
});
