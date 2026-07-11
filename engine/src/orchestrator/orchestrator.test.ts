import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClaimKind, RunArtifact, ToolCall } from "@npmguard/shared";
import { HypothesisGraph } from "../graph/hypothesis-graph.js";
import { deriveGraphVerdict } from "./verdict.js";

// Mock the experimenter; the orchestrator's own control flow is under test.
vi.mock("./experimenter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./experimenter.js")>();
  return { ...actual, runExperiment: vi.fn() };
});

import { runExperiment } from "./experimenter.js";
import { runOrchestrator, type OrchestratorContext } from "./orchestrator.js";

const runExperimentMock = vi.mocked(runExperiment);

let clock = 0;
const now = () => new Date(1_700_000_000_000 + clock++).toISOString();

const TRIGGER: ToolCall = { tool: "trigger", args: { kind: "entrypoint", target: "index.js", argv: [], stdin: null } };

// Every hypothesis reaching the orchestrator is armed — HYPOTHESIZE guarantees a
// runnable experiment or the audit errors. `experiment` overrides only for the
// invariant test that a stray unarmed node is rejected.
function graphWith(
  claims: Array<{ hypId: string; kind: ClaimKind; experiment?: ToolCall[] }>,
): HypothesisGraph {
  const g = new HypothesisGraph("audit_test", now);
  for (const { hypId, kind, experiment } of claims) {
    g.add({
      hypId,
      description: `test ${hypId}`,
      claim: { kind, gating: null },
      focusFiles: ["index.js"],
      focusLines: [],
      experiment: experiment ?? [TRIGGER],
      severity: "high",
      parentHypId: null,
      childHypIds: [],
      state: "OPEN",
      createdBy: "hypothesize",
      evidenceRefs: [],
      createdAt: now(),
      resolvedAt: null,
      resolution: null,
    });
  }
  return g;
}

function fakeArtifact(overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    runId: "run_test",
    triggerUsed: { kind: "entrypoint", target: "index.js", argv: [], stdin: null },
    setupApplied: { env: {}, date: null, plantFiles: [], stubUrls: [], hostname: null, locale: null, patches: [], preloadHash: null },
    observe: { kernel: true, network: true, fsDiff: true, node: true, inspector: true },
    budget: { wallMs: 20_000, maxSyscalls: null, maxBytesCapture: null },
    wallMs: 100,
    exitCode: 0,
    timedOut: false,
    events: [],
    stdoutHash: null,
    stderrHash: null,
    fsDiffHash: null,
    pcapHash: null,
    straceLogHash: null,
    inspectorLogHash: null,
    eventSummary: { uniqueHosts: [], uniqueSyscalls: [], filesWritten: [], dnsQueries: [] },
    error: null,
    contentHash: "hash_test",
    createdAt: now(),
    ...overrides,
  };
}

function ctx(): OrchestratorContext {
  return {
    packagePath: "/tmp/pkg",
    artifactStore: { writeArtifact: vi.fn(() => "hash_test") } as unknown as OrchestratorContext["artifactStore"],
    log: { writeLog: vi.fn() } as unknown as OrchestratorContext["log"],
    emit: undefined,
    statedPurpose: "a test package",
    globalBudgetMs: 60_000,
  };
}

/** A confirmed/unconfirmed experiment result for the given artifact. */
function expResult(artifact: RunArtifact, confirmed: boolean, reason: string, judgeFailed = false) {
  return {
    confirmed,
    reason,
    citedEvents: confirmed ? ["e1"] : [],
    judgeFailed,
    artifact,
    evidenceRef: { kind: "run" as const, id: artifact.runId, hash: artifact.contentHash },
    timeline: `# Execution timeline — ${artifact.runId}`,
  };
}

beforeEach(() => {
  clock = 0;
  runExperimentMock.mockReset();
});

describe("runOrchestrator", () => {
  it("runs the experiment and confirms with a RunArtifact → DANGEROUS", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil" }]);
    const artifact = fakeArtifact();
    runExperimentMock.mockResolvedValue(expResult(artifact, true, "canary in traffic"));

    const summary = await runOrchestrator(g, ctx());

    expect(runExperimentMock).toHaveBeenCalledTimes(1);
    expect(summary.confirmed).toBe(1);
    const h1 = g.get("h1");
    expect(h1.state).toBe("CONFIRMED");
    // Exactly one run evidence ref — not double-counted by addEvidence+transition.
    expect(h1.evidenceRefs).toHaveLength(1);
    expect(h1.evidenceRefs[0]?.kind).toBe("run");
    expect(deriveGraphVerdict(g).verdict).toBe("DANGEROUS");
  });

  it("an unarmed hypothesis violates the dispatch invariant and aborts", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil", experiment: [] }]);

    await expect(runOrchestrator(g, ctx())).rejects.toThrow(/unarmed hypothesis h1/);
    expect(runExperimentMock).not.toHaveBeenCalled();
  });

  it("a run that fires no payload → REFUTED (dynamic refutation) → SAFE", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil" }]);
    runExperimentMock.mockResolvedValue(expResult(fakeArtifact(), false, "no exfil observed"));

    const summary = await runOrchestrator(g, ctx());

    expect(g.get("h1").state).toBe("REFUTED");
    expect(summary.refuted).toBe(1);
    // The run backs the refutation as evidence.
    expect(g.get("h1").evidenceRefs).toHaveLength(1);
    expect(deriveGraphVerdict(g).verdict).toBe("SAFE");
  });

  it("a run the judge could not evaluate (judge failure) → DEFERRED (the audit is an ERROR)", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil" }]);
    const artifact = fakeArtifact(); // run itself succeeded — no artifact.error
    runExperimentMock.mockResolvedValue(expResult(artifact, false, "Judge model call failed: 503", true));

    const summary = await runOrchestrator(g, ctx());

    // DEFERRED with nothing confirmed is not a verdict — the pipeline raises
    // AuditIncompleteError, so deriveGraphVerdict won't clear it as SAFE.
    expect(g.get("h1").state).toBe("DEFERRED");
    expect(summary.deferred).toBe(1);
    expect(() => deriveGraphVerdict(g)).toThrow(/unevaluated node|pipeline should have raised/);
  });

  it("an observation failure (SensorError) → DEFERRED (the audit is an ERROR)", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil" }]);
    const artifact = fakeArtifact({ error: { kind: "SensorError", detail: "pcap failed" } });
    runExperimentMock.mockResolvedValue(expResult(artifact, false, "no exfil observed"));

    const summary = await runOrchestrator(g, ctx());

    expect(g.get("h1").state).toBe("DEFERRED");
    expect(summary.deferred).toBe(1);
  });

  it("resolves every OPEN node to a terminal state (nothing lingers)", async () => {
    const g = graphWith([
      { hypId: "h1", kind: "env_exfil" },
      { hypId: "h2", kind: "dom_inject" },
      { hypId: "h3", kind: "dos_loop" },
    ]);
    runExperimentMock.mockImplementation(async (h) => expResult(fakeArtifact(), h.hypId === "h3", "x"));

    const summary = await runOrchestrator(g, ctx());

    expect(summary.dispatched).toBe(3);
    expect(g.filterByState("OPEN")).toHaveLength(0);
    expect(g.filterByState("IN_PROGRESS")).toHaveLength(0);
    // h3 confirmed → DANGEROUS wins regardless of the others.
    expect(deriveGraphVerdict(g).verdict).toBe("DANGEROUS");
  });

  it("a thrown experiment is caught and the node is DEFERRED", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil" }]);
    runExperimentMock.mockRejectedValue(new Error("docker exploded"));

    const summary = await runOrchestrator(g, ctx());

    expect(summary.deferred).toBe(1);
    expect(g.get("h1").state).toBe("DEFERRED");
  });
});
