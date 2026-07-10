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
    createdBy: overrides.createdBy ?? "triage",
    evidenceRefs: overrides.evidenceRefs ?? [],
    createdAt: overrides.createdAt ?? "2026-04-24T12:00:00.000Z",
    resolvedAt: overrides.resolvedAt ?? null,
    resolution: overrides.resolution ?? null,
  };
}

const ref: EvidenceRef = { kind: "run", id: "run_1", hash: "h1" };

// ---------------------------------------------------------------------------
// SAFE
// ---------------------------------------------------------------------------

describe("deriveGraphVerdict — SAFE", () => {
  it("returns SAFE with a clear rationale when the graph is empty", () => {
    const g = new HypothesisGraph("a1");
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("SAFE");
    expect(r.counts.total).toBe(0);
    expect(r.rationale).toMatch(/no hypotheses/i);
  });

  it("returns SAFE when every hypothesis has been REFUTED", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.add(baseline({ hypId: "h2" }));
    g.transition("h1", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h2", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("SAFE");
    expect(r.counts.refuted).toBe(2);
    expect(r.rationale).toMatch(/refuted/i);
  });
});

// ---------------------------------------------------------------------------
// DANGEROUS
// ---------------------------------------------------------------------------

describe("deriveGraphVerdict — DANGEROUS", () => {
  it("returns DANGEROUS when any hypothesis is CONFIRMED", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.add(baseline({ hypId: "h2" }));
    g.transition("h1", { to: "CONFIRMED", by: "worker:experimenter", evidenceRefs: [ref] });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("DANGEROUS");
    expect(r.counts.confirmed).toBe(1);
    expect(r.confirmedHypIds).toEqual(["h1"]);
  });

  it("DANGEROUS wins even if other nodes are REFUTED or OPEN", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.add(baseline({ hypId: "h2" }));
    g.add(baseline({ hypId: "h3" }));
    g.transition("h1", { to: "CONFIRMED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h2", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    // h3 stays OPEN
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("DANGEROUS");
    expect(r.counts.confirmed).toBe(1);
    expect(r.counts.refuted).toBe(1);
    expect(r.counts.open).toBe(1);
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
// SUSPECT
// ---------------------------------------------------------------------------

describe("deriveGraphVerdict — SUSPECT", () => {
  it("returns SUSPECT when hypotheses remain OPEN (no workers ran yet)", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.add(baseline({ hypId: "h2" }));
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("SUSPECT");
    expect(r.counts.open).toBe(2);
    expect(r.rationale).toMatch(/pending/i);
  });

  it("returns SUSPECT when some nodes are IN_PROGRESS", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.transition("h1", { to: "IN_PROGRESS", by: "orchestrator" });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("SUSPECT");
    expect(r.counts.inProgress).toBe(1);
  });

  it("returns SUSPECT when mix of OPEN + REFUTED (something still pending)", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.add(baseline({ hypId: "h2" }));
    g.transition("h1", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("SUSPECT");
    expect(r.counts.open).toBe(1);
    expect(r.counts.refuted).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN
// ---------------------------------------------------------------------------

describe("deriveGraphVerdict — UNKNOWN", () => {
  it("returns UNKNOWN when all nodes are INCONCLUSIVE", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.transition("h1", {
      to: "INCONCLUSIVE",
      by: "worker:experimenter",
      reason: "sandbox network blocked, could not reach attacker domain",
    });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.counts.inconclusive).toBe(1);
  });

  it("returns UNKNOWN when all nodes are DEFERRED", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.transition("h1", {
      to: "DEFERRED",
      by: "orchestrator",
      reason: "requires browser runtime not yet supported",
    });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.counts.deferred).toBe(1);
  });

  it("returns UNKNOWN when a mix of INCONCLUSIVE + REFUTED with no CONFIRMED or OPEN", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h1" }));
    g.add(baseline({ hypId: "h2" }));
    g.transition("h1", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h2", {
      to: "INCONCLUSIVE",
      by: "worker:experimenter",
      reason: "dry-run skipped",
    });
    const r = deriveGraphVerdict(g);
    expect(r.verdict).toBe("UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

describe("deriveGraphVerdict — counts shape", () => {
  it("tallies every state bucket", () => {
    const g = new HypothesisGraph("a1");
    g.add(baseline({ hypId: "h_open" }));
    g.add(baseline({ hypId: "h_in_progress" }));
    g.add(baseline({ hypId: "h_confirmed" }));
    g.add(baseline({ hypId: "h_refuted" }));
    g.add(baseline({ hypId: "h_inconclusive" }));
    g.add(baseline({ hypId: "h_deferred" }));

    g.transition("h_in_progress", { to: "IN_PROGRESS", by: "orchestrator" });
    g.transition("h_confirmed", { to: "CONFIRMED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h_refuted", { to: "REFUTED", by: "worker:experimenter", evidenceRefs: [ref] });
    g.transition("h_inconclusive", { to: "INCONCLUSIVE", by: "worker:experimenter", reason: "x" });
    g.transition("h_deferred", { to: "DEFERRED", by: "orchestrator", reason: "x" });

    const r = deriveGraphVerdict(g);
    expect(r.counts).toEqual({
      total: 6,
      open: 1,
      inProgress: 1,
      confirmed: 1,
      refuted: 1,
      inconclusive: 1,
      deferred: 1,
    });
    // CONFIRMED wins
    expect(r.verdict).toBe("DANGEROUS");
  });
});
