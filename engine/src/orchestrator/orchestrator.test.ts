import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClaimKind, RunArtifact } from "@npmguard/shared";
import { HypothesisGraph } from "../graph/hypothesis-graph.js";
import { deriveGraphVerdict } from "./verdict.js";

// Mock the two workers but keep the real routing (an experiment-presence check).
vi.mock("./experimenter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./experimenter.js")>();
  return { ...actual, runExperiment: vi.fn() };
});
vi.mock("./code-reader.js", () => ({ runCodeReader: vi.fn() }));

import { runExperiment } from "./experimenter.js";
import { runCodeReader } from "./code-reader.js";
import { runOrchestrator, type OrchestratorContext } from "./orchestrator.js";

const runExperimentMock = vi.mocked(runExperiment);
const runCodeReaderMock = vi.mocked(runCodeReader);

let clock = 0;
const now = () => new Date(1_700_000_000_000 + clock++).toISOString();

// Routing now keys on whether a hypothesis carries a runnable experiment, not on
// its claim kind. Browser/registry threats are the ones HYPOTHESIZE cannot arm,
// so we model them as empty-experiment (→ static route); everything else carries
// a trigger (→ dynamic route). This preserves the intent of the older
// claim-kind cases while exercising the new predicate.
const UNARMABLE_KINDS = new Set<ClaimKind>(["dom_inject", "clipboard_hijack", "propagation"]);
const TRIGGER = { tool: "trigger", args: { kind: "entrypoint", target: "index.js", argv: [], stdin: null } };

function graphWith(claims: Array<{ hypId: string; kind: ClaimKind }>): HypothesisGraph {
  const g = new HypothesisGraph("audit_test", now);
  for (const { hypId, kind } of claims) {
    g.add({
      hypId,
      description: `test ${hypId}`,
      claim: { kind, gating: null },
      focusFiles: ["index.js"],
      focusLines: [],
      experiment: UNARMABLE_KINDS.has(kind) ? [] : [TRIGGER],
      severity: "high",
      parentHypId: null,
      childHypIds: [],
      state: "OPEN",
      createdBy: "triage",
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
    observe: { kernel: true, network: true, fsDiff: false, node: true, inspector: false },
    budget: { wallMs: 15_000, maxSyscalls: null, maxBytesCapture: null },
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
  runCodeReaderMock.mockReset();
});

describe("runOrchestrator", () => {
  it("routes dynamic claims to the experimenter and confirms with a RunArtifact", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil" }]);
    const artifact = fakeArtifact();
    runExperimentMock.mockResolvedValue(expResult(artifact, true, "canary in traffic"));

    const summary = await runOrchestrator(g, ctx());

    expect(runExperimentMock).toHaveBeenCalledTimes(1);
    expect(runCodeReaderMock).not.toHaveBeenCalled();
    expect(summary.confirmed).toBe(1);
    const h1 = g.get("h1");
    expect(h1.state).toBe("CONFIRMED");
    // Exactly one run evidence ref — not double-counted by addEvidence+transition.
    expect(h1.evidenceRefs).toHaveLength(1);
    expect(h1.evidenceRefs[0]?.kind).toBe("run");
    expect(deriveGraphVerdict(g).verdict).toBe("DANGEROUS");
  });

  it("routes static claims to the code-reader; a confident refute → REFUTED → SAFE", async () => {
    const g = graphWith([{ hypId: "h1", kind: "dom_inject" }]);
    runCodeReaderMock.mockResolvedValue({
      disposition: "REFUTED",
      reason: "benign DOM read",
      evidenceRef: { kind: "static", id: "codereader_h1", hash: "sh" },
      reading: null,
    });

    const summary = await runOrchestrator(g, ctx());

    expect(runCodeReaderMock).toHaveBeenCalledTimes(1);
    expect(runExperimentMock).not.toHaveBeenCalled();
    expect(summary.refuted).toBe(1);
    expect(g.get("h1").state).toBe("REFUTED");
    expect(deriveGraphVerdict(g).verdict).toBe("SAFE");
  });

  it("a dynamic run that does not fire → INCONCLUSIVE → UNKNOWN (never a quiet pass)", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil" }]);
    const artifact = fakeArtifact();
    runExperimentMock.mockResolvedValue(expResult(artifact, false, "no exfil observed"));

    await runOrchestrator(g, ctx());

    expect(g.get("h1").state).toBe("INCONCLUSIVE");
    expect(deriveGraphVerdict(g).verdict).toBe("UNKNOWN");
  });

  it("a clean run the judge could not evaluate (judge failure) → DEFERRED, not INCONCLUSIVE", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil" }]);
    const artifact = fakeArtifact(); // run itself succeeded — no artifact.error
    runExperimentMock.mockResolvedValue(expResult(artifact, false, "Judge model call failed: 503", true));

    await runOrchestrator(g, ctx());

    expect(g.get("h1").state).toBe("DEFERRED");
    expect(deriveGraphVerdict(g).verdict).toBe("UNKNOWN");
  });

  it("an observation failure (SensorError) → DEFERRED, not a refutation", async () => {
    const g = graphWith([{ hypId: "h1", kind: "env_exfil" }]);
    const artifact = fakeArtifact({ error: { kind: "SensorError", detail: "pcap failed" } });
    runExperimentMock.mockResolvedValue(expResult(artifact, false, "no exfil observed"));

    await runOrchestrator(g, ctx());

    expect(g.get("h1").state).toBe("DEFERRED");
    expect(deriveGraphVerdict(g).verdict).toBe("UNKNOWN");
  });

  it("resolves every OPEN node to a terminal state (nothing lingers)", async () => {
    const g = graphWith([
      { hypId: "h1", kind: "env_exfil" },
      { hypId: "h2", kind: "dom_inject" },
      { hypId: "h3", kind: "dos_loop" },
    ]);
    runExperimentMock.mockImplementation(async (h) => expResult(fakeArtifact(), h.hypId === "h3", "x"));
    runCodeReaderMock.mockResolvedValue({
      disposition: "INCONCLUSIVE",
      reason: "cannot tell statically",
      evidenceRef: null,
      reading: null,
    });

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
