import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { HypothesisGraph, HypothesisGraphError } from "./hypothesis-graph.js";
import type { Hypothesis, EvidenceRef } from "@npmguard/shared";

/** Deterministic clock for reproducible tests. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms;
    },
    current: () => t,
  };
}

function baselineHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypId: overrides.hypId ?? "hyp_001",
    description: overrides.description ?? "lib/init.js:42 reads NPM_TOKEN",
    claim: overrides.claim ?? { kind: "env_exfil", gating: null },
    focusFiles: overrides.focusFiles ?? ["lib/init.js"],
    focusLines: overrides.focusLines ?? [{ file: "lib/init.js", range: "42-58" }],
    severity: overrides.severity ?? "high",
    parentHypId: overrides.parentHypId ?? null,
    childHypIds: overrides.childHypIds ?? [],
    state: overrides.state ?? "OPEN",
    createdBy: overrides.createdBy ?? "triage",
    evidenceRefs: overrides.evidenceRefs ?? [],
    createdAt: overrides.createdAt ?? "2026-04-18T10:00:00.000Z",
    resolvedAt: overrides.resolvedAt ?? null,
    resolution: overrides.resolution ?? null,
  };
}

const evRef = (id = "run_1", hash = "h1"): EvidenceRef => ({
  kind: "run",
  id,
  hash,
});

describe("HypothesisGraph — add / get / children", () => {
  it("adds and retrieves a hypothesis", () => {
    const g = new HypothesisGraph("audit_001");
    g.add(baselineHypothesis());
    expect(g.size).toBe(1);
    expect(g.has("hyp_001")).toBe(true);
    expect(g.get("hyp_001").description).toMatch(/NPM_TOKEN/);
  });

  it("rejects duplicate hypIds", () => {
    const g = new HypothesisGraph("audit_001");
    g.add(baselineHypothesis());
    expect(() => g.add(baselineHypothesis())).toThrow(HypothesisGraphError);
  });

  it("throws when getting a missing hypothesis", () => {
    const g = new HypothesisGraph("audit_001");
    expect(() => g.get("missing")).toThrow(HypothesisGraphError);
  });

  it("links parent -> child on add", () => {
    const g = new HypothesisGraph("audit_001");
    g.add(baselineHypothesis({ hypId: "parent" }));
    g.add(baselineHypothesis({ hypId: "child", parentHypId: "parent" }));
    expect(g.get("parent").childHypIds).toEqual(["child"]);
    expect(g.children("parent").map((h) => h.hypId)).toEqual(["child"]);
  });

  it("rejects child hypotheses referencing missing parents", () => {
    const g = new HypothesisGraph("audit_001");
    expect(() =>
      g.add(baselineHypothesis({ hypId: "orphan", parentHypId: "ghost" })),
    ).toThrow(HypothesisGraphError);
  });
});

describe("HypothesisGraph — state transitions", () => {
  let g: HypothesisGraph;

  beforeEach(() => {
    g = new HypothesisGraph("audit_001");
    g.add(baselineHypothesis());
  });

  it("OPEN -> IN_PROGRESS is allowed without evidence", () => {
    const h = g.transition("hyp_001", { to: "IN_PROGRESS", by: "orchestrator" });
    expect(h.state).toBe("IN_PROGRESS");
    expect(h.resolvedAt).toBeNull();
  });

  it("CONFIRMED without evidenceRefs is rejected", () => {
    expect(() =>
      g.transition("hyp_001", { to: "CONFIRMED", by: "worker:experimenter" }),
    ).toThrow(/evidenceRef/);
  });

  it("CONFIRMED with evidenceRefs is allowed and sets resolution", () => {
    const h = g.transition("hyp_001", {
      to: "CONFIRMED",
      by: "worker:experimenter",
      evidenceRefs: [evRef()],
      reason: "saw env access + POST",
    });
    expect(h.state).toBe("CONFIRMED");
    expect(h.evidenceRefs).toHaveLength(1);
    expect(h.resolution?.by).toBe("worker:experimenter");
    expect(h.resolvedAt).not.toBeNull();
  });

  it("REFUTED requires evidence too", () => {
    expect(() =>
      g.transition("hyp_001", { to: "REFUTED", by: "worker:experimenter" }),
    ).toThrow(/evidenceRef/);
  });

  it("INCONCLUSIVE without reason is rejected", () => {
    expect(() =>
      g.transition("hyp_001", { to: "INCONCLUSIVE", by: "orchestrator" }),
    ).toThrow(/resolution.reason/);
  });

  it("INCONCLUSIVE with reason is allowed without evidence", () => {
    const h = g.transition("hyp_001", {
      to: "INCONCLUSIVE",
      by: "orchestrator",
      reason: "timeout; couldn't reproduce under chosen setup",
    });
    expect(h.state).toBe("INCONCLUSIVE");
    expect(h.resolution?.reason).toMatch(/timeout/);
  });

  it("DEFERRED requires reason and is terminal", () => {
    g.transition("hyp_001", { to: "DEFERRED", by: "orchestrator", reason: "budget" });
    expect(() =>
      g.transition("hyp_001", { to: "OPEN", by: "orchestrator" }),
    ).toThrow(/terminal/);
  });

  it("CONFIRMED is sticky — no transitions out", () => {
    g.transition("hyp_001", {
      to: "CONFIRMED",
      by: "worker:experimenter",
      evidenceRefs: [evRef()],
    });
    expect(() =>
      g.transition("hyp_001", { to: "INCONCLUSIVE", by: "orchestrator", reason: "retract" }),
    ).toThrow(/terminal/);
  });

  it("existing evidence counts toward CONFIRMED threshold", () => {
    g.addEvidence("hyp_001", [evRef("run_prev")]);
    const h = g.transition("hyp_001", {
      to: "CONFIRMED",
      by: "worker:experimenter",
    });
    expect(h.state).toBe("CONFIRMED");
  });

  it("appends new evidence alongside existing on transition", () => {
    g.addEvidence("hyp_001", [evRef("run_a")]);
    const h = g.transition("hyp_001", {
      to: "CONFIRMED",
      by: "worker:experimenter",
      evidenceRefs: [evRef("run_b")],
    });
    expect(h.evidenceRefs.map((r) => r.id)).toEqual(["run_a", "run_b"]);
  });
});

describe("HypothesisGraph — filtering + persistence", () => {
  it("filterByState returns the right subset", () => {
    const g = new HypothesisGraph("audit_001");
    g.add(baselineHypothesis({ hypId: "a", state: "OPEN" }));
    g.add(baselineHypothesis({ hypId: "b", state: "OPEN" }));
    g.add(baselineHypothesis({ hypId: "c", state: "IN_PROGRESS" }));
    expect(g.filterByState("OPEN").map((h) => h.hypId).sort()).toEqual(["a", "b"]);
    expect(g.filterByState("IN_PROGRESS").map((h) => h.hypId)).toEqual(["c"]);
  });

  it("serialize / load round-trips equal", () => {
    const clock = fakeClock();
    const g = new HypothesisGraph("audit_001", clock.now);
    g.add(baselineHypothesis({ hypId: "p" }));
    clock.advance(100);
    g.add(baselineHypothesis({ hypId: "c", parentHypId: "p" }));

    const snap = g.serialize();
    const g2 = HypothesisGraph.load(snap, clock.now);

    expect(g2.size).toBe(2);
    expect(g2.serialize()).toEqual(snap);
    expect(g2.get("p").childHypIds).toEqual(["c"]);
  });

  it("saveTo / loadFrom round-trips on disk", () => {
    const g = new HypothesisGraph("audit_001");
    g.add(baselineHypothesis());
    g.transition("hyp_001", {
      to: "CONFIRMED",
      by: "worker:experimenter",
      evidenceRefs: [evRef()],
    });

    const tmpFile = path.join(os.tmpdir(), `npmguard-graph-${Date.now()}.json`);
    try {
      g.saveTo(tmpFile);
      const g2 = HypothesisGraph.loadFrom(tmpFile);
      expect(g2.size).toBe(1);
      expect(g2.get("hyp_001").state).toBe("CONFIRMED");
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});
