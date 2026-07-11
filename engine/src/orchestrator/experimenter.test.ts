import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hypothesis, RunArtifact, ToolCall } from "@npmguard/shared";

vi.mock("../evidence/run-under-observation.js", () => ({ runUnderObservation: vi.fn() }));
vi.mock("./judge.js", () => ({ judgeEvidence: vi.fn() }));

import { runUnderObservation } from "../evidence/run-under-observation.js";
import { judgeEvidence } from "./judge.js";
import { runExperiment } from "./experimenter.js";

const runUnderObservationMock = vi.mocked(runUnderObservation);
const judgeEvidenceMock = vi.mocked(judgeEvidence);

const TRIGGER: ToolCall = { tool: "trigger", args: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null } };

function hyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypId: "h1",
    description: "test",
    claim: { kind: "env_exfil", gating: null },
    focusFiles: ["setup.js"],
    focusLines: [{ file: "setup.js", range: "1-10" }],
    experiment: [
      { tool: "setEnv", args: { env: { NPM_TOKEN: "canary" } } },
      { tool: "plantFiles", args: { files: [{ path: "/home/node/.npmrc", content: "x" }] } },
      TRIGGER,
    ],
    severity: "high",
    parentHypId: null,
    childHypIds: [],
    state: "OPEN",
    createdBy: "triage",
    evidenceRefs: [],
    createdAt: "2026-04-24T12:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    ...overrides,
  };
}

function baseArtifact(overrides: Partial<RunArtifact> = {}): RunArtifact {
  return {
    runId: "run_test",
    triggerUsed: { kind: "entrypoint", target: "index.js", argv: [], stdin: null },
    setupApplied: {
      env: { HOME: "/home/node" },
      date: null,
      plantFiles: [],
      stubUrls: [],
      hostname: null,
      locale: null,
      patches: [],
      preloadHash: null,
    },
    observe: { kernel: true, network: true, fsDiff: true, node: true, inspector: true },
    budget: { wallMs: 20000, maxSyscalls: null, maxBytesCapture: null },
    wallMs: 500,
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
    contentHash: "abc",
    createdAt: "2026-04-24T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  runUnderObservationMock.mockReset();
  judgeEvidenceMock.mockReset();
});

// ---------------------------------------------------------------------------
// runExperiment wiring: run the hypothesis's experiment → render → judge.
// No claim→strategy table, no predicate — the experiment lives on the hypothesis.
// ---------------------------------------------------------------------------

describe("runExperiment", () => {
  it("runs the hypothesis experiment under the full oracle, renders, judges", async () => {
    runUnderObservationMock.mockResolvedValue(
      baseArtifact({
        events: [
          {
            stream: "L4:monkey",
            timestamp: 0,
            pid: 1,
            kind: "network",
            raw: { type: "network", method: "POST", url: "https://evil.example/collect" },
            normalized: { method: "POST", url: "https://evil.example/collect" },
          },
        ],
      }),
    );
    judgeEvidenceMock.mockResolvedValue({
      confirmed: true,
      reason: "posts harvested env to an undocumented host",
      citedEvents: ["e1"],
      judgeFailed: false,
      verdict: { malicious: true, reason: "posts harvested env to an undocumented host", citedEvents: ["e1"] },
    });

    const result = await runExperiment(hyp(), "/tmp/pkg", "a config loader");

    // The experiment carried on the hypothesis is what runs — passed straight through.
    expect(runUnderObservationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        packagePath: "/tmp/pkg",
        experiment: hyp().experiment,
        // Every run observes the full oracle — all five sensors, regardless of hypothesis.
        observe: { kernel: true, network: true, node: true, fsDiff: true, inspector: true },
      }),
    );
    expect(result.confirmed).toBe(true);
    expect(result.citedEvents).toEqual(["e1"]);
    expect(result.evidenceRef).toEqual({ kind: "run", id: "run_test", hash: "abc" });

    // The judge was handed the rendered timeline (which names the outbound POST), not raw events.
    const [, timelineArg, purposeArg] = judgeEvidenceMock.mock.calls[0]!;
    expect(timelineArg.text).toContain("net");
    expect(timelineArg.text).toContain("https://evil.example/collect");
    expect(timelineArg.ids.has("e1")).toBe(true);
    expect(purposeArg).toBe("a config loader");
    expect(result.timeline).toBe(timelineArg.text);
  });

  it("a run ending in SensorError still flows through the judge (orchestrator handles the DEFER)", async () => {
    runUnderObservationMock.mockResolvedValue(
      baseArtifact({ error: { kind: "SensorError", detail: "pcap failed to start" } }),
    );
    judgeEvidenceMock.mockResolvedValue({
      confirmed: false,
      reason: "no malicious behavior observed",
      citedEvents: [],
      judgeFailed: false,
      verdict: { malicious: false, reason: "no malicious behavior observed", citedEvents: [] },
    });

    const result = await runExperiment(hyp(), "/tmp/pkg", "purpose");

    expect(judgeEvidenceMock).toHaveBeenCalledTimes(1);
    expect(result.confirmed).toBe(false);
    expect(result.artifact.error?.kind).toBe("SensorError");
  });
});
