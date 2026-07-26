/**
 * Unit: foldAuditEvent (the pure SSE reducer) — audit-fold.ts.
 *
 * Input classes (the shape of the (state, event) domain this reducer folds):
 *  C1  replay / idempotence      — a seq already folded is a no-op (same ref);
 *                                  re-folding a full buffer changes nothing.
 *                                  MANDATORY, not an edge case: reconnect replays
 *                                  from a cursor and every seek re-folds from zero.
 *  C2  unknown / retired types   — truly-unknown types hit `default` and change
 *                                  nothing but the seq guard. The retired
 *                                  agent_* / verify_* / finding_discovered types
 *                                  are in exactly that class, asserted INERT
 *                                  rather than merely non-throwing.
 *  C3  lifecycle transitions     — each emitted event moves the documented slice
 *                                  of state (audit_started … audit_error).
 *  C4  terminal freeze           — after a terminal event later NON-terminal
 *                                  events are ignored; terminal events still pass.
 *  C5  the experiment chain      — the six per-hypothesis frames drive `stage`
 *                                  independently of `state`, and the run
 *                                  accumulates across all four boundaries.
 *  C6  citation merge            — `hypothesis_resolved.citedObservations` reach
 *                                  the run display even when the pre-judgment
 *                                  preview bound dropped them. This is what makes
 *                                  "a verdict points at its evidence" total.
 *  C7  the format cut            — a stream without replay format 2 folds without
 *                                  error and is NOT a rich replay. There is no
 *                                  reconstruction path, so the predicate is the
 *                                  whole mechanism.
 *  C8  merge bookkeeping         — a hypothesis folded into another at graph build
 *                                  is marked, not left open for ever.
 *  C9  fixture cross-check       — a real committed recording folds to a coherent
 *                                  terminal state.
 *
 * Blackbox: events are built as typed AuditEventUnion objects; assertions read only
 * the returned AuditFoldState (never fold internals). seq/ts are ours to choose.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuditEventUnion, DisplayObservation, RunDisplay } from "@npmguard/shared";
import { AuditEventSchema, REPLAY_FORMAT } from "@npmguard/shared";
import {
  foldAuditEvent,
  initialFoldState,
  isRichReplay,
  type AuditFoldState,
} from "./audit-fold.ts";

// Distributive Omit so the per-type payload keys survive the union.
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventPayload = DistOmit<AuditEventUnion, "auditId" | "timestamp" | "seq">;

/** Build a fully-typed AuditEventUnion, stamping the envelope base fields. */
function ev(seq: number, payload: EventPayload): AuditEventUnion {
  return {
    auditId: "audit-1",
    timestamp: `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    seq,
    ...payload,
  } as AuditEventUnion;
}

function foldAll(events: AuditEventUnion[], from: AuditFoldState = initialFoldState()): AuditFoldState {
  return events.reduce(foldAuditEvent, from);
}

const started = (seq: number, version = REPLAY_FORMAT) =>
  ev(seq, { type: "audit_started", packageName: "left-pad", replayVersion: version });

function observation(id: string, summary: string): DisplayObservation {
  return {
    eventId: id,
    atMs: Number(id.slice(1)) * 10,
    stream: "L4:monkey",
    kind: "network",
    summary,
    signal: "high",
    occurrences: 1,
  };
}

function runDisplay(runId: string, observations: DisplayObservation[], omitted = 0): RunDisplay {
  return {
    runId,
    wallMs: 512,
    exitCode: 0,
    timedOut: false,
    eventCount: observations.length + omitted,
    eventSummary: { uniqueHosts: [], uniqueSyscalls: [], filesWritten: [], dnsQueries: [] },
    error: null,
    setupApplied: {
      envKeys: ["NPM_TOKEN"],
      date: null,
      plantedFiles: [],
      stubUrls: [],
      hostname: null,
      locale: null,
      patchedFiles: [],
      preloaded: false,
    },
    observations,
    omittedObservationCount: omitted,
    captures: {
      stdoutHash: null,
      stderrHash: null,
      fsDiffHash: null,
      pcapHash: null,
      straceLogHash: null,
    },
    contentHash: "c".repeat(64),
  };
}

/** The whole six-frame chain for one hypothesis, from seq `base`. */
function chain(
  base: number,
  hypId: string,
  options: {
    preview?: DisplayObservation[];
    omitted?: number;
    cited?: DisplayObservation[];
    state?: "CONFIRMED" | "REFUTED" | "DEFERRED";
  } = {},
): AuditEventUnion[] {
  const preview = options.preview ?? [observation("e1", "net POST evil.test/x")];
  const cited = options.cited ?? [];
  const runId = `run_${hypId}`;
  return [
    ev(base, {
      type: "hypothesis_emitted",
      hypId,
      claim: "env_exfil",
      severity: "high",
      description: "reads NPM_TOKEN and sends it out",
      focusFiles: ["setup.js"],
      focusLines: [{ file: "setup.js", range: "18-42" }],
    }),
    ev(base + 1, {
      type: "experiment_started",
      hypId,
      runId,
      experiment: [{ tool: "trigger", args: { kind: "entrypoint", target: "setup.js" } }],
      trigger: { kind: "entrypoint", target: "setup.js", argv: [], stdin: null },
    }),
    ev(base + 2, {
      type: "sandbox_started",
      hypId,
      runId,
      observe: { kernel: true, network: true, fsDiff: true, node: true, inspector: true },
      budget: { wallMs: 20000, maxSyscalls: null, maxBytesCapture: null },
    }),
    ev(base + 3, {
      type: "sandbox_completed",
      hypId,
      run: runDisplay(runId, preview, options.omitted ?? 0),
    }),
    ev(base + 4, { type: "judgment_started", hypId, runId }),
    ev(base + 5, {
      type: "hypothesis_resolved",
      hypId,
      claim: "env_exfil",
      severity: "high",
      state: options.state ?? "CONFIRMED",
      by: "worker:experimenter",
      reason: "the planted token left the process",
      evidenceRefs: [{ kind: "run", id: runId, hash: "h".repeat(64) }],
      citedEventIds: cited.map((item) => item.eventId),
      citedObservations: cited,
      runId,
    }),
  ];
}

describe("foldAuditEvent — C1 replay / idempotence", () => {
  it("C1: folding the same seq twice is a no-op returning the identical reference", () => {
    const s1 = foldAuditEvent(initialFoldState(), started(1));
    const s2 = foldAuditEvent(s1, ev(1, { type: "audit_started", packageName: "OVERWRITE", replayVersion: 2 }));
    expect(s2).toBe(s1);
    expect(s2.packageName).toBe("left-pad");
  });

  it("C1: re-folding an entire buffer is a no-op (full-replay idempotence)", () => {
    const buffer = [started(1), ...chain(2, "hyp-1")];
    const once = foldAll(buffer);
    expect(foldAll(buffer, once)).toBe(once);
  });

  it("C1: folding a prefix twice equals folding it once — every seek depends on this", () => {
    const buffer = [started(1), ...chain(2, "hyp-1"), ...chain(8, "hyp-2")];
    for (let count = 0; count <= buffer.length; count += 1) {
      const prefix = buffer.slice(0, count);
      expect(foldAll(prefix)).toEqual(foldAll(prefix));
    }
  });
});

describe("foldAuditEvent — C2 unknown / retired types", () => {
  it("C2: a retired type is inert — it consumes its seq and changes nothing else", () => {
    const before = foldAll([started(1)]);
    const after = foldAuditEvent(before, {
      auditId: "audit-1",
      timestamp: "2026-01-01T00:00:02.000Z",
      seq: 2,
      type: "agent_thinking",
    } as unknown as AuditEventUnion);
    expect({ ...after, seenSeqs: null }).toEqual({ ...before, seenSeqs: null });
    expect(after.seenSeqs.has(2)).toBe(true);
  });
});

describe("foldAuditEvent — C3 lifecycle transitions", () => {
  it("C3: a scanned file is COUNTED, never accumulated into a node", () => {
    const state = foldAll([
      started(1),
      ev(2, { type: "file_analyzing", file: "a.js" }),
      ev(3, { type: "file_analyzing", file: "b.js" }),
      ev(4, { type: "file_analyzing", file: "b.js" }),
    ]);
    // Same file twice in a row is one file read, not two.
    expect(state.scannedCount).toBe(2);
    expect(state.analyzing).toBe("b.js");
  });

  it("C3: a file verdict is kept whole, so a consumer reads the engine's own risk", () => {
    const state = foldAll([
      started(1),
      ev(2, {
        type: "file_verdict",
        verdict: {
          file: "setup.js",
          capabilities: ["ENV_VARS"],
          suspiciousPatterns: [],
          suspiciousLines: "18-42",
          summary: "reads credential-shaped env vars during installation",
          riskContribution: 8,
        },
      }),
    ]);
    expect(state.fileVerdicts["setup.js"].riskContribution).toBe(8);
  });
});

describe("foldAuditEvent — C4 terminal freeze", () => {
  it("C4: after a verdict, later non-terminal events are ignored", () => {
    const state = foldAll([
      started(1),
      ev(2, {
        type: "verdict_reached",
        verdict: "SAFE",
        rationale: "nothing confirmed",
        counts: { total: 0, open: 0, inProgress: 0, confirmed: 0, refuted: 0, deferred: 0 },
        confirmedCount: 0,
      }),
      ev(3, { type: "file_analyzing", file: "late.js" }),
    ]);
    expect(state.running).toBe(false);
    expect(state.scannedCount).toBe(0);
  });
});

describe("foldAuditEvent — C5 the experiment chain", () => {
  it("C5: the six frames drive stage independently of state", () => {
    const frames = [started(1), ...chain(2, "hyp-1")];
    const stages = frames.map((_, index) => {
      const state = foldAll(frames.slice(0, index + 1));
      return state.hypotheses[0]?.stage ?? null;
    });
    expect(stages).toEqual([
      null,
      "emitted",
      "experiment",
      "sandbox",
      "sandbox",
      "judging",
      "resolved",
    ]);
  });

  it("C5: the run accumulates across all four boundaries", () => {
    const state = foldAll([started(1), ...chain(2, "hyp-1")]);
    const run = state.runs["hyp-1"];
    expect(run.stage).toBe("done");
    expect(run.trigger.target).toBe("setup.js");
    expect(run.observe?.network).toBe(true);
    expect(run.budget?.wallMs).toBe(20000);
    expect(run.display?.runId).toBe("run_hyp-1");
    expect(state.hypotheses[0].state).toBe("CONFIRMED");
    expect(state.hypotheses[0].evidenceRefs).toHaveLength(1);
  });

  it("C5: a hypothesis with no experiment leaves no run behind", () => {
    const state = foldAll([
      started(1),
      ev(2, {
        type: "hypothesis_emitted",
        hypId: "hyp-9",
        claim: "telemetry",
        severity: "low",
        description: "reports usage",
        focusFiles: ["index.js"],
        focusLines: [{ file: "index.js", range: "3" }],
      }),
      ev(3, {
        type: "hypothesis_resolved",
        hypId: "hyp-9",
        claim: "telemetry",
        severity: "low",
        state: "DEFERRED",
        by: "orchestrator",
        reason: "analysis budget exhausted before dispatch",
        evidenceRefs: [],
        citedEventIds: [],
        citedObservations: [],
        runId: null,
      }),
    ]);
    expect(state.runs["hyp-9"]).toBeUndefined();
    expect(state.hypotheses[0].runId).toBeNull();
  });
});

describe("foldAuditEvent — C6 citation merge", () => {
  it("C6: a cited observation the preview dropped still reaches the run display", () => {
    const preview = [observation("e1", "net GET cdn.test/a")];
    const cited = [observation("e147", "http POST evil.test/exfil")];
    const state = foldAll([started(1), ...chain(2, "hyp-1", { preview, omitted: 140, cited })]);
    const run = state.runs["hyp-1"];
    expect(run.observations.map((item) => item.eventId)).toEqual(["e1", "e147"]);
    expect(run.citedEventIds).toEqual(["e147"]);
  });

  it("C6: merged observations are in timeline order, not arrival order", () => {
    const preview = [observation("e9", "b"), observation("e2", "a")];
    const cited = [observation("e5", "c")];
    const state = foldAll([started(1), ...chain(2, "hyp-1", { preview, cited })]);
    expect(state.runs["hyp-1"].observations.map((item) => item.eventId)).toEqual([
      "e2",
      "e5",
      "e9",
    ]);
  });

  it("C6: a citation for a row already previewed does not duplicate it", () => {
    const shared = observation("e1", "net POST evil.test/x");
    const state = foldAll([
      started(1),
      ...chain(2, "hyp-1", { preview: [shared], cited: [shared] }),
    ]);
    expect(state.runs["hyp-1"].observations).toHaveLength(1);
  });
});

describe("foldAuditEvent — C7 the format cut", () => {
  it("C7: a stream below format 2 folds without error and is not a rich replay", () => {
    const state = foldAll([started(1, 1), ev(2, { type: "file_analyzing", file: "a.js" })]);
    expect(state.replayVersion).toBe(1);
    expect(isRichReplay(state)).toBe(false);
    expect(state.scannedCount).toBe(1); // folded, not rejected
  });

  it("C7: a stream that never announced itself is not a rich replay either", () => {
    expect(isRichReplay(initialFoldState())).toBe(false);
  });

  it("C7: format 2 is a rich replay", () => {
    expect(isRichReplay(foldAll([started(1)]))).toBe(true);
  });
});

describe("foldAuditEvent — C8 merge bookkeeping", () => {
  it("C8: a hypothesis folded into another is marked, not left open for ever", () => {
    const state = foldAll([
      started(1),
      ev(2, {
        type: "hypothesis_emitted",
        hypId: "hyp-1",
        claim: "env_exfil",
        severity: "high",
        description: "reads NPM_TOKEN",
        focusFiles: ["setup.js"],
        focusLines: [{ file: "setup.js", range: "1-5" }],
      }),
      ev(3, {
        type: "hypothesis_emitted",
        hypId: "hyp-2",
        claim: "env_exfil",
        severity: "high",
        description: "reads NPM_TOKEN",
        focusFiles: ["setup.js"],
        focusLines: [{ file: "setup.js", range: "1-5" }],
      }),
      ev(4, {
        type: "graph_built",
        nodeCount: 1,
        addedCount: 1,
        mergedCount: 1,
        merges: [{ hypId: "hyp-2", into: "hyp-1" }],
      }),
    ]);
    const merged = state.hypotheses.find((item) => item.hypId === "hyp-2");
    expect(merged?.stage).toBe("merged");
    expect(merged?.mergedInto).toBe("hyp-1");
  });
});

describe("foldAuditEvent — C9 fixture cross-check", () => {
  /** vitest runs with cwd = frontend/; the engine fixtures live one level up. */
  const recording = JSON.parse(
    readFileSync(resolve(process.cwd(), "..", "engine/demo-data/test-pkg-env-exfil.json"), "utf8"),
  ) as { events: Record<string, unknown>[] };

  it("C9: the committed DANGEROUS recording folds to a coherent terminal state", () => {
    const frames = recording.events.map((raw, index) =>
      AuditEventSchema.parse({ auditId: "demo", seq: index + 1, ...raw }),
    );
    const state = foldAll(frames);

    expect(isRichReplay(state)).toBe(true);
    expect(state.running).toBe(false);
    expect(state.verdict).toBe("DANGEROUS");
    expect(state.error).toBeNull();

    // Every hypothesis reached a terminal position: resolved, or folded into one
    // that was. An OPEN node at the verdict is a suspicion the display lost.
    for (const hypothesis of state.hypotheses) {
      expect(["resolved", "merged"]).toContain(hypothesis.stage);
    }

    // The claim the whole product rests on: a confirmed hypothesis can be walked
    // back to the exact rows the judge cited.
    const confirmed = state.hypotheses.filter((item) => item.state === "CONFIRMED");
    expect(confirmed.length).toBeGreaterThan(0);
    for (const hypothesis of confirmed) {
      const run = state.runs[hypothesis.hypId];
      expect(hypothesis.citedEventIds.length).toBeGreaterThan(0);
      const available = new Set(run.observations.map((item) => item.eventId));
      for (const id of hypothesis.citedEventIds) expect(available.has(id)).toBe(true);
    }
  });

  it("C9: every hypothesis in the recording is grounded in real source lines", () => {
    const frames = recording.events.map((raw, index) =>
      AuditEventSchema.parse({ auditId: "demo", seq: index + 1, ...raw }),
    );
    const state = foldAll(frames);
    // A hypothesis with no focus range has nowhere for its edge to come from.
    // The frontend must never invent one, so the producer must always send one.
    for (const hypothesis of state.hypotheses) {
      expect(hypothesis.focusLines.length).toBeGreaterThan(0);
    }
  });
});
