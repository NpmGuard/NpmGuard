/**
 * Unit: the evidence-graph projection — evidence-graph.ts.
 *
 * The graph is the product's central credibility claim: a first-time viewer must
 * be able to point from a confirmed verdict back through cited evidence, the
 * sandbox run, the experiment, the hypothesis, and the exact source lines. Every
 * class here is one link in that chain, or one way the chain could lie.
 *
 *  C1  provenance          — every hypothesis node has an incoming edge from a
 *                            SOURCE node carrying the real highlighted ranges. A
 *                            hypothesis with no range is REPORTED as a producer
 *                            defect, never given an invented line.
 *  C2  density             — a clean file increments coverage and never creates a
 *                            node. The coverage node is a count, not a SAFE claim.
 *  C3  clustering          — related suspicions group by file and claim, and a
 *                            cluster never hides a confirmed or deferred outcome.
 *  C4  verdict contraction — refuted branches contract; confirmed and deferred
 *                            stay expanded; the proof path is marked.
 *  C5  failure             — an incomplete audit keeps its partial graph and ends
 *                            in an INCOMPLETE node, never SAFE and never danger.
 *  C6  outline parity      — the text outline carries the same hierarchy as the
 *                            geometry, so a screen-reader user navigates the same
 *                            causality without interpreting positions.
 *  C7  determinism / scale — the projection is a pure function of state, and its
 *                            permanent node count is bounded by suspicious files
 *                            and clusters rather than by files scanned.
 *
 * Blackbox: folded state in, nodes/edges/outline out.
 */

import { describe, expect, it } from "vitest";
import type { AuditEventUnion } from "@npmguard/shared";
import { REPLAY_FORMAT } from "@npmguard/shared";
import { foldAuditEvent, initialFoldState, type AuditFoldState } from "./audit-fold.ts";
import {
  COVERAGE_NODE_ID,
  PACKAGE_NODE_ID,
  VERDICT_NODE_ID,
  hypothesisNodeId,
  projectEvidenceGraph,
  runNodeId,
  sourceNodeId,
} from "./evidence-graph.ts";

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventPayload = DistOmit<AuditEventUnion, "auditId" | "timestamp" | "seq">;

let seq = 0;
function ev(payload: EventPayload): AuditEventUnion {
  seq += 1;
  return { auditId: "a", timestamp: "2026-01-01T00:00:00.000Z", seq, ...payload } as AuditEventUnion;
}

function fold(events: AuditEventUnion[]): AuditFoldState {
  return events.reduce(foldAuditEvent, initialFoldState());
}

const start = () =>
  ev({ type: "audit_started", packageName: "left-pad", replayVersion: REPLAY_FORMAT });

const fileVerdict = (file: string, risk: number, summary: string) =>
  ev({
    type: "file_verdict",
    verdict: {
      file,
      capabilities: [],
      suspiciousPatterns: [],
      suspiciousLines: risk >= 3 ? "18-42" : null,
      summary,
      riskContribution: risk,
    },
  });

const emitted = (hypId: string, claim: "env_exfil" | "cred_theft", file = "setup.js") =>
  ev({
    type: "hypothesis_emitted",
    hypId,
    claim,
    severity: "high",
    description: `${hypId} suspicion`,
    focusFiles: [file],
    focusLines: [{ file, range: "18-42" }],
  });

const resolved = (
  hypId: string,
  state: "CONFIRMED" | "REFUTED" | "DEFERRED",
  claim: "env_exfil" | "cred_theft" = "env_exfil",
) =>
  ev({
    type: "hypothesis_resolved",
    hypId,
    claim,
    severity: "high",
    state,
    by: "worker:experimenter",
    reason: `${hypId} was ${state}`,
    evidenceRefs: [],
    citedEventIds: state === "CONFIRMED" ? ["e7"] : [],
    citedObservations:
      state === "CONFIRMED"
        ? [
            {
              eventId: "e7",
              atMs: 183,
              stream: "L2:pcap",
              kind: "http_request",
              summary: "http POST localhost/exfil",
              signal: "high",
              occurrences: 1,
            },
          ]
        : [],
    runId: `run_${hypId}`,
  });

function experiment(hypId: string): AuditEventUnion[] {
  const runId = `run_${hypId}`;
  return [
    ev({
      type: "experiment_started",
      hypId,
      runId,
      experiment: [{ tool: "trigger", args: { kind: "entrypoint", target: "setup.js" } }],
      trigger: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null },
    }),
    ev({
      type: "sandbox_started",
      hypId,
      runId,
      observe: { kernel: true, network: true, fsDiff: true, node: true, inspector: true },
      budget: { wallMs: 20000, maxSyscalls: null, maxBytesCapture: null },
    }),
    ev({
      type: "sandbox_completed",
      hypId,
      run: {
        runId,
        wallMs: 512,
        exitCode: 0,
        timedOut: false,
        eventCount: 40,
        eventSummary: { uniqueHosts: [], uniqueSyscalls: [], filesWritten: [], dnsQueries: [] },
        error: null,
        setupApplied: {
          envKeys: [],
          date: null,
          plantedFiles: [],
          stubUrls: [],
          hostname: null,
          locale: null,
          patchedFiles: [],
          preloaded: false,
        },
        observations: [],
        omittedObservationCount: 0,
        captures: {
          stdoutHash: null,
          stderrHash: null,
          fsDiffHash: null,
          pcapHash: null,
          straceLogHash: null,
        },
        contentHash: "c".repeat(64),
      },
    }),
    ev({ type: "judgment_started", hypId, runId }),
  ];
}

const verdict = (outcome: "SAFE" | "DANGEROUS", confirmed: number) =>
  ev({
    type: "verdict_reached",
    verdict: outcome,
    rationale: outcome === "SAFE" ? "nothing confirmed" : "one confirmed hypothesis",
    counts: {
      total: 1,
      open: 0,
      inProgress: 0,
      confirmed,
      refuted: 1 - confirmed,
      deferred: 0,
    },
    confirmedCount: confirmed,
  });

describe("evidence-graph — C1 provenance", () => {
  it("C1: every hypothesis node has an incoming edge from its source file", () => {
    const graph = projectEvidenceGraph(
      fold([start(), fileVerdict("setup.js", 8, "reads env"), emitted("hyp-1", "env_exfil")]),
    );
    const edge = graph.edges.find((item) => item.target === hypothesisNodeId("hyp-1"));
    expect(edge?.source).toBe(sourceNodeId("setup.js"));
    expect(edge?.relation).toBe("raised the hypothesis");
  });

  it("C1: the source node carries the EXACT ranges the hypothesis named", () => {
    const graph = projectEvidenceGraph(
      fold([start(), fileVerdict("setup.js", 8, "reads env"), emitted("hyp-1", "env_exfil")]),
    );
    const node = graph.nodes.find((item) => item.id === sourceNodeId("setup.js"));
    expect(node?.data).toMatchObject({
      kind: "source",
      source: { file: "setup.js", ranges: [{ file: "setup.js", range: "18-42" }] },
    });
  });

  it("C1: a hypothesis with no focus range is REPORTED, never given an invented line", () => {
    const state = fold([
      start(),
      ev({
        type: "hypothesis_emitted",
        hypId: "hyp-9",
        claim: "env_exfil",
        severity: "high",
        description: "ungrounded",
        focusFiles: ["setup.js"],
        focusLines: [],
      }),
    ]);
    const graph = projectEvidenceGraph(state);
    expect(graph.ungroundedHypIds).toEqual(["hyp-9"]);
    const source = graph.nodes.find((item) => item.id === sourceNodeId("setup.js"));
    expect(source?.data).toMatchObject({ kind: "source", source: { ranges: [] } });
  });
});

describe("evidence-graph — C2 density", () => {
  it("C2: a clean file increments coverage and creates no node", () => {
    const graph = projectEvidenceGraph(
      fold([
        start(),
        ev({ type: "file_list", files: [] }),
        ev({ type: "file_analyzing", file: "clean.js" }),
        fileVerdict("clean.js", 0, "nothing notable"),
      ]),
    );
    expect(graph.nodes.map((node) => node.id)).not.toContain(sourceNodeId("clean.js"));
    const coverage = graph.nodes.find((node) => node.id === COVERAGE_NODE_ID);
    expect(coverage?.data).toMatchObject({ kind: "coverage", coverage: { cleared: 1, flagged: 0 } });
  });

  it("C2: coverage is never on the proof path — it is a count, not a SAFE claim", () => {
    const graph = projectEvidenceGraph(
      fold([start(), ev({ type: "file_analyzing", file: "a.js" }), fileVerdict("a.js", 0, "ok")]),
    );
    expect(graph.nodes.find((node) => node.id === COVERAGE_NODE_ID)?.onProofPath).toBe(false);
  });

  it("C2: a flagged file gets a node even when no hypothesis survived it", () => {
    const graph = projectEvidenceGraph(
      fold([start(), fileVerdict("setup.js", 8, "reads env")]),
    );
    expect(graph.nodes.map((node) => node.id)).toContain(sourceNodeId("setup.js"));
  });
});

describe("evidence-graph — C3 clustering", () => {
  it("C3: related suspicions on one file and claim cluster under it", () => {
    const graph = projectEvidenceGraph(
      fold([
        start(),
        fileVerdict("setup.js", 8, "reads env"),
        emitted("hyp-1", "env_exfil"),
        emitted("hyp-2", "env_exfil"),
      ]),
    );
    const cluster = graph.nodes.find((node) => node.kind === "cluster");
    expect(cluster?.data).toMatchObject({ cluster: { claim: "env_exfil", hypIds: ["hyp-1", "hyp-2"] } });
    // Both hypotheses hang off the cluster, not off the file directly.
    for (const hypId of ["hyp-1", "hyp-2"]) {
      const edge = graph.edges.find((item) => item.target === hypothesisNodeId(hypId));
      expect(edge?.source).toBe(cluster?.id);
    }
  });

  it("C3: a single suspicion gets no cluster — a box around one node says nothing", () => {
    const graph = projectEvidenceGraph(
      fold([start(), fileVerdict("setup.js", 8, "reads env"), emitted("hyp-1", "env_exfil")]),
    );
    expect(graph.nodes.filter((node) => node.kind === "cluster")).toHaveLength(0);
  });

  it("C3: different claims on one file stay separate branches", () => {
    const graph = projectEvidenceGraph(
      fold([
        start(),
        fileVerdict("setup.js", 8, "reads env"),
        emitted("hyp-1", "env_exfil"),
        emitted("hyp-2", "cred_theft"),
      ]),
    );
    expect(graph.nodes.filter((node) => node.kind === "cluster")).toHaveLength(0);
  });

  it("C3: a cluster never contracts a confirmed outcome out of view", () => {
    const graph = projectEvidenceGraph(
      fold([
        start(),
        fileVerdict("setup.js", 8, "reads env"),
        emitted("hyp-1", "env_exfil"),
        emitted("hyp-2", "env_exfil"),
        ...experiment("hyp-1"),
        resolved("hyp-1", "CONFIRMED"),
        ...experiment("hyp-2"),
        resolved("hyp-2", "REFUTED"),
        verdict("DANGEROUS", 1),
      ]),
    );
    const confirmed = graph.nodes.find((node) => node.id === hypothesisNodeId("hyp-1"));
    expect(confirmed?.contracted).toBe(false);
    expect(confirmed?.onProofPath).toBe(true);
  });
});

describe("evidence-graph — C4 verdict contraction", () => {
  const dangerous = () =>
    fold([
      start(),
      fileVerdict("setup.js", 8, "reads env"),
      emitted("hyp-1", "env_exfil"),
      emitted("hyp-2", "cred_theft"),
      ...experiment("hyp-1"),
      resolved("hyp-1", "CONFIRMED"),
      ...experiment("hyp-2"),
      resolved("hyp-2", "REFUTED", "cred_theft"),
      verdict("DANGEROUS", 1),
    ]);

  it("C4: refuted branches contract and confirmed ones stay expanded", () => {
    const graph = projectEvidenceGraph(dangerous());
    expect(graph.nodes.find((node) => node.id === hypothesisNodeId("hyp-2"))?.contracted).toBe(true);
    expect(graph.nodes.find((node) => node.id === hypothesisNodeId("hyp-1"))?.contracted).toBe(false);
  });

  it("C4: a deferred branch stays expanded — a gap in the proof is part of it", () => {
    const graph = projectEvidenceGraph(
      fold([
        start(),
        fileVerdict("setup.js", 8, "reads env"),
        emitted("hyp-1", "env_exfil"),
        ...experiment("hyp-1"),
        resolved("hyp-1", "DEFERRED"),
        verdict("SAFE", 0),
      ]),
    );
    expect(graph.nodes.find((node) => node.id === hypothesisNodeId("hyp-1"))?.contracted).toBe(false);
  });

  it("C4: only the deciding runs connect to the verdict", () => {
    const graph = projectEvidenceGraph(dangerous());
    const incoming = graph.edges.filter((edge) => edge.target === VERDICT_NODE_ID);
    expect(incoming.map((edge) => edge.source)).toEqual([runNodeId("hyp-1")]);
    expect(incoming[0].relation).toBe("supports the verdict");
  });

  it("C4: the proof path runs package → … → verdict and is marked end to end", () => {
    const graph = projectEvidenceGraph(dangerous());
    const marked = graph.nodes.filter((node) => node.onProofPath).map((node) => node.id);
    expect(marked).toContain(PACKAGE_NODE_ID);
    expect(marked).toContain(hypothesisNodeId("hyp-1"));
    expect(marked).toContain(runNodeId("hyp-1"));
    expect(marked).toContain(VERDICT_NODE_ID);
    expect(marked).not.toContain(hypothesisNodeId("hyp-2"));
  });
});

describe("evidence-graph — C5 failure", () => {
  it("C5: an incomplete audit keeps its partial graph and never renders SAFE", () => {
    const graph = projectEvidenceGraph(
      fold([
        start(),
        fileVerdict("setup.js", 8, "reads env"),
        emitted("hyp-1", "env_exfil"),
        ...experiment("hyp-1"),
        ev({
          type: "audit_error",
          error: "1 hypothesis could not be evaluated",
          code: "NPMGUARD-0031",
          retryable: true,
        }),
      ]),
    );
    expect(graph.nodes.map((node) => node.id)).toContain(hypothesisNodeId("hyp-1"));
    expect(graph.nodes.find((node) => node.id === VERDICT_NODE_ID)?.data).toMatchObject({
      verdict: { verdict: "INCOMPLETE" },
    });
  });
});

describe("evidence-graph — C6 outline parity", () => {
  it("C6: the outline carries the same nodes, in the same causal hierarchy", () => {
    const graph = projectEvidenceGraph(
      fold([
        start(),
        fileVerdict("setup.js", 8, "reads env"),
        emitted("hyp-1", "env_exfil"),
        ...experiment("hyp-1"),
        resolved("hyp-1", "CONFIRMED"),
        verdict("DANGEROUS", 1),
      ]),
    );
    expect(graph.outline.map((item) => item.id)).toEqual(graph.nodes.map((node) => node.id));
    const byId = new Map(graph.outline.map((item) => [item.id, item]));
    // Depth increases along the causal chain the edges describe.
    expect(byId.get(PACKAGE_NODE_ID)!.depth).toBeLessThan(byId.get(sourceNodeId("setup.js"))!.depth);
    expect(byId.get(sourceNodeId("setup.js"))!.depth).toBeLessThan(
      byId.get(hypothesisNodeId("hyp-1"))!.depth,
    );
    expect(byId.get(hypothesisNodeId("hyp-1"))!.depth).toBeLessThan(
      byId.get(runNodeId("hyp-1"))!.depth,
    );
  });

  it("C6: every edge carries a relation in words", () => {
    const graph = projectEvidenceGraph(
      fold([
        start(),
        fileVerdict("setup.js", 8, "reads env"),
        emitted("hyp-1", "env_exfil"),
        ...experiment("hyp-1"),
        resolved("hyp-1", "CONFIRMED"),
        verdict("DANGEROUS", 1),
      ]),
    );
    for (const edge of graph.edges) expect(edge.relation.length).toBeGreaterThan(0);
  });
});

describe("evidence-graph — C7 determinism and scale", () => {
  it("C7: the same state projects to the same graph", () => {
    const state = fold([
      start(),
      fileVerdict("setup.js", 8, "reads env"),
      emitted("hyp-1", "env_exfil"),
      ...experiment("hyp-1"),
      resolved("hyp-1", "CONFIRMED"),
      verdict("DANGEROUS", 1),
    ]);
    expect(projectEvidenceGraph(state)).toEqual(projectEvidenceGraph(state));
  });

  it("C7: 200 scanned files and 50 hypotheses keep the node count bounded by SUSPICION", () => {
    const events: AuditEventUnion[] = [start()];
    for (let index = 0; index < 200; index += 1) {
      events.push(ev({ type: "file_analyzing", file: `src/f${index}.js` }));
      events.push(fileVerdict(`src/f${index}.js`, 0, "nothing notable"));
    }
    for (let index = 0; index < 50; index += 1) {
      events.push(fileVerdict(`flagged/g${index}.js`, 8, "reads env"));
      events.push(emitted(`hyp-${index}`, "env_exfil", `flagged/g${index}.js`));
    }
    const graph = projectEvidenceGraph(fold(events));
    // package + coverage + 50 source + 50 hypothesis. The 200 clean files are a
    // NUMBER: they contribute no node at all, which is the property that keeps a
    // large package interactive.
    expect(graph.nodes).toHaveLength(102);
    const coverage = graph.nodes.find((node) => node.id === COVERAGE_NODE_ID);
    expect(coverage?.data).toMatchObject({ coverage: { cleared: 200, flagged: 50 } });
  });
});
