import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hypothesis, RunArtifact } from "@npmguard/shared";

vi.mock("../evidence/run-under-observation.js", () => ({ runUnderObservation: vi.fn() }));
vi.mock("./judge.js", () => ({ judgeEvidence: vi.fn() }));

import { runUnderObservation } from "../evidence/run-under-observation.js";
import { judgeEvidence } from "./judge.js";
import {
  experimentForClaim,
  pickTriggerTarget,
  claimHasDynamicStrategy,
  runExperiment,
} from "./experimenter.js";

const runUnderObservationMock = vi.mocked(runUnderObservation);
const judgeEvidenceMock = vi.mocked(judgeEvidence);

function hyp(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypId: "h1",
    description: "test",
    claim: { kind: "env_exfil", gating: null },
    focusFiles: ["setup.js"],
    focusLines: [{ file: "setup.js", range: "1-10" }],
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
    observe: { kernel: true, network: true, fsDiff: false, node: true, inspector: false },
    budget: { wallMs: 15000, maxSyscalls: null, maxBytesCapture: null },
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
// Strategy selection — how to run, no longer whether it fired.
// ---------------------------------------------------------------------------

describe("pickTriggerTarget", () => {
  it("prefers a focusFile that is an install entry point", () => {
    const h = hyp({ focusFiles: ["setup.js", "index.js"] });
    expect(pickTriggerTarget(h, "index.js", ["setup.js"]).target).toBe("setup.js");
  });

  it("falls back to runtimeEntry when no focusFile is an install entry", () => {
    const h = hyp({ focusFiles: ["lib/util.js"] });
    expect(pickTriggerTarget(h, "index.js", ["setup.js"]).target).toBe("index.js");
  });
});

describe("experimentForClaim", () => {
  const triggerOf = (e: NonNullable<ReturnType<typeof experimentForClaim>>) =>
    e.experiment.find((c) => c.tool === "trigger");
  const tools = (e: NonNullable<ReturnType<typeof experimentForClaim>>) =>
    e.experiment.map((c) => c.tool);

  it("targets the lifecycle file for env_exfil and plants bait via tool calls", () => {
    const e = experimentForClaim("env_exfil", hyp({ focusFiles: ["setup.js"] }), "index.js", ["setup.js"]);
    expect(e).not.toBeNull();
    expect(triggerOf(e!)?.args.target).toBe("setup.js");
    expect(tools(e!)).toEqual(expect.arrayContaining(["setEnv", "plantFiles", "trigger"]));
  });

  it("every experiment has exactly one trigger", () => {
    for (const kind of ["env_exfil", "binary_drop", "dos_loop", "obfuscation", "persistence", "dns_exfil", "telemetry", "destructive"] as const) {
      const e = experimentForClaim(kind, hyp({ claim: { kind, gating: null } }), "index.js")!;
      expect(e.experiment.filter((c) => c.tool === "trigger")).toHaveLength(1);
    }
  });

  it("enables the right sensors per claim (fsDiff for binary_drop, inspector for obfuscation)", () => {
    expect(experimentForClaim("binary_drop", hyp({ claim: { kind: "binary_drop", gating: null } }), "index.js")!.observe.fsDiff).toBe(true);
    expect(experimentForClaim("obfuscation", hyp({ claim: { kind: "obfuscation", gating: null } }), "index.js")!.observe.inspector).toBe(true);
  });

  it("uses a tight budget for dos_loop", () => {
    expect(experimentForClaim("dos_loop", hyp({ claim: { kind: "dos_loop", gating: null } }), "index.js")!.budget?.wallMs).toBe(5000);
  });

  it("returns null for browser-only claims (no runnable experiment)", () => {
    expect(experimentForClaim("dom_inject", hyp({ claim: { kind: "dom_inject", gating: null } }), "x")).toBeNull();
    expect(experimentForClaim("clipboard_hijack", hyp({ claim: { kind: "clipboard_hijack", gating: null } }), "x")).toBeNull();
  });

  it("keeps routing in lockstep: null experiment iff not a dynamic claim", () => {
    for (const kind of ["dom_inject", "clipboard_hijack", "propagation"] as const) {
      expect(claimHasDynamicStrategy(kind)).toBe(false);
      expect(experimentForClaim(kind, hyp({ claim: { kind, gating: null } }), "x")).toBeNull();
    }
    for (const kind of ["env_exfil", "persistence", "dos_loop", "destructive"] as const) {
      expect(claimHasDynamicStrategy(kind)).toBe(true);
      expect(experimentForClaim(kind, hyp({ claim: { kind, gating: null } }), "x")).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// (10) runExperiment wiring: run → render → judge. No predicate exists.
// ---------------------------------------------------------------------------

describe("runExperiment", () => {
  it("runs, renders a timeline, judges it, and returns citedEvents + evidenceRef + timeline", async () => {
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

    const result = await runExperiment(hyp(), "/tmp/pkg", "index.js", ["setup.js"], "a config loader");

    expect(result).not.toBeNull();
    expect(result!.confirmed).toBe(true);
    expect(result!.citedEvents).toEqual(["e1"]);
    expect(result!.evidenceRef).toEqual({ kind: "run", id: "run_test", hash: "abc" });

    // The judge was handed the rendered timeline (which names the outbound POST), not raw events.
    const [, timelineArg, purposeArg] = judgeEvidenceMock.mock.calls[0]!;
    expect(timelineArg.text).toContain("net");
    expect(timelineArg.text).toContain("https://evil.example/collect");
    expect(timelineArg.ids.has("e1")).toBe(true);
    expect(purposeArg).toBe("a config loader");
    expect(result!.timeline).toBe(timelineArg.text);
  });

  it("returns null (no run, no judge) for a claim with no dynamic strategy", async () => {
    const result = await runExperiment(
      hyp({ claim: { kind: "dom_inject", gating: null } }),
      "/tmp/pkg",
      "index.js",
      [],
      "purpose",
    );
    expect(result).toBeNull();
    expect(runUnderObservationMock).not.toHaveBeenCalled();
    expect(judgeEvidenceMock).not.toHaveBeenCalled();
  });

  it("(11) a run ending in SensorError still flows through the judge (orchestrator handles the DEFER)", async () => {
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

    const result = await runExperiment(hyp(), "/tmp/pkg", "index.js", [], "purpose");

    expect(judgeEvidenceMock).toHaveBeenCalledTimes(1);
    expect(result!.confirmed).toBe(false);
    expect(result!.artifact.error?.kind).toBe("SensorError");
  });
});
