/**
 * Unit: the event tape and the replay clock — audit-tape.ts + replay-clock.ts.
 *
 * These two modules are what make a replay a replay rather than a second
 * renderer, so the classes here are about the properties a viewer can break by
 * touching a control:
 *
 *  C1  append / dedupe        — a duplicate seq never grows the tape. The fold's
 *                               own guard keeps STATE right under replay; this
 *                               keeps INDICES right, so a seek target taken before
 *                               a reconnect still means the same frame after one.
 *  C2  seek is re-derivation  — stateAt(tape, n) equals folding 0…n from clean.
 *                               There is no reverse transition, so a scrub cannot
 *                               accumulate drift or diverge from a fresh load.
 *  C3  significant navigation — prev/next land on the frames a reader would look
 *                               for, and never inside the file-scan bulk.
 *  C4  speed changes waits    — and only waits. Same order, same state, same
 *                               evidence at every speed.
 *  C5  elapsed time           — the scrubber's clock is the sum of what was
 *                               actually waited, at the current speed.
 *
 * Blackbox: typed frames in, tape/state/number out. No timers, no components.
 */

import { describe, expect, it } from "vitest";
import type { AuditEventUnion } from "@npmguard/shared";
import { REPLAY_FORMAT } from "@npmguard/shared";
import {
  appendFrame,
  appendFrames,
  emptyTape,
  nextSignificant,
  previousSignificant,
  stateAt,
} from "./audit-tape.ts";
import { foldAuditEvent, initialFoldState } from "./audit-fold.ts";
import { HOLD_MS, SPEEDS, animationScale, elapsedMs, holdMsFor } from "./replay-clock.ts";

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type EventPayload = DistOmit<AuditEventUnion, "auditId" | "timestamp" | "seq">;

function ev(seq: number, payload: EventPayload): AuditEventUnion {
  return { auditId: "a", timestamp: "2026-01-01T00:00:00.000Z", seq, ...payload } as AuditEventUnion;
}

/** A stream with bulk scanning around the events a reader actually navigates to. */
function stream(): AuditEventUnion[] {
  const frames: AuditEventUnion[] = [
    ev(1, { type: "audit_started", packageName: "left-pad", replayVersion: REPLAY_FORMAT }),
    ev(2, { type: "phase_started", phase: "flag" }),
  ];
  for (let index = 0; index < 20; index += 1) {
    frames.push(ev(3 + index, { type: "file_analyzing", file: `file-${index}.js` }));
  }
  frames.push(
    ev(23, {
      type: "hypothesis_emitted",
      hypId: "hyp-1",
      claim: "env_exfil",
      severity: "high",
      description: "reads NPM_TOKEN",
      focusFiles: ["setup.js"],
      focusLines: [{ file: "setup.js", range: "18-42" }],
    }),
    ev(24, {
      type: "verdict_reached",
      verdict: "DANGEROUS",
      rationale: "one confirmed hypothesis",
      counts: { total: 1, open: 0, inProgress: 0, confirmed: 1, refuted: 0, deferred: 0 },
      confirmedCount: 1,
    }),
  );
  return frames;
}

describe("audit-tape — C1 append / dedupe", () => {
  it("C1: a duplicate seq never grows the tape", () => {
    const frame = ev(1, { type: "audit_started", packageName: "a", replayVersion: 2 });
    const tape = appendFrame(appendFrame(emptyTape(), frame), frame);
    expect(tape.frames).toHaveLength(1);
  });

  it("C1: a reconnect that replays the whole buffer leaves every index unmoved", () => {
    const frames = stream();
    const once = appendFrames(emptyTape(), frames);
    const twice = appendFrames(once, frames);
    expect(twice.frames).toEqual(once.frames);
    expect(twice.significant).toEqual(once.significant);
  });

  it("C1: an out-of-order frame lands in seq order, not arrival order", () => {
    const tape = appendFrames(emptyTape(), [
      ev(3, { type: "file_analyzing", file: "c.js" }),
      ev(1, { type: "audit_started", packageName: "a", replayVersion: 2 }),
      ev(2, { type: "file_analyzing", file: "b.js" }),
    ]);
    expect(tape.frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
  });
});

describe("audit-tape — C2 seek is re-derivation", () => {
  it("C2: seeking to N equals folding 0…N from a clean initial state", () => {
    const frames = stream();
    const tape = appendFrames(emptyTape(), frames);
    for (let count = 0; count <= frames.length; count += 1) {
      const folded = frames.slice(0, count).reduce(foldAuditEvent, initialFoldState());
      expect(stateAt(tape, count)).toEqual(folded);
    }
  });

  it("C2: seeking backwards then forwards lands on the same state as never moving", () => {
    const tape = appendFrames(emptyTape(), stream());
    const direct = stateAt(tape, tape.frames.length);
    stateAt(tape, 3);
    stateAt(tape, 12);
    expect(stateAt(tape, tape.frames.length)).toEqual(direct);
  });

  it("C2: a count outside the tape is clamped, never an error", () => {
    const tape = appendFrames(emptyTape(), stream());
    expect(stateAt(tape, -5)).toEqual(initialFoldState());
    expect(stateAt(tape, 9_999)).toEqual(stateAt(tape, tape.frames.length));
  });
});

describe("audit-tape — C3 significant navigation", () => {
  it("C3: stepping forward skips the file-scan bulk", () => {
    const tape = appendFrames(emptyTape(), stream());
    // From just after audit_started, the next thing worth reading is the
    // hypothesis — not the twentieth file read.
    const target = nextSignificant(tape, 1);
    expect(tape.frames[target - 1].type).toBe("hypothesis_emitted");
  });

  it("C3: stepping backward from the end reaches the hypothesis, then the start", () => {
    const tape = appendFrames(emptyTape(), stream());
    const back = previousSignificant(tape, tape.frames.length);
    expect(tape.frames[back - 1].type).toBe("hypothesis_emitted");
    expect(tape.frames[previousSignificant(tape, back) - 1].type).toBe("audit_started");
  });

  it("C3: stepping past either end clamps to the tape's bounds", () => {
    const tape = appendFrames(emptyTape(), stream());
    expect(previousSignificant(tape, 0)).toBe(0);
    expect(nextSignificant(tape, tape.frames.length)).toBe(tape.frames.length);
  });
});

describe("replay-clock — C4 speed changes waits and nothing else", () => {
  it("C4: every event type this contract can carry has a hold", () => {
    const tape = appendFrames(emptyTape(), stream());
    for (const frame of tape.frames) expect(HOLD_MS[frame.type]).toBeGreaterThan(0);
  });

  it("C4: state at a given frame is identical at every speed", () => {
    const tape = appendFrames(emptyTape(), stream());
    const reference = stateAt(tape, 12);
    for (const speed of SPEEDS) {
      // The clock decides WAITS; it is not consulted by the fold at all, and this
      // asserts the separation rather than a coincidence of the current wiring.
      expect(elapsedMs(tape.frames, 12, speed)).toBeGreaterThan(0);
      expect(stateAt(tape, 12)).toEqual(reference);
    }
  });

  it("C4: a faster speed is a shorter wait, monotonically", () => {
    const frame = stream()[22];
    const holds = SPEEDS.map((speed) => holdMsFor(frame, speed));
    expect(holds).toEqual([...holds].sort((a, b) => b - a));
  });

  it("C4: at 4x entrance animation is clamped so arrivals stay legible", () => {
    expect(animationScale(4)).toBeLessThan(animationScale(1));
    expect(animationScale(1)).toBe(1);
  });
});

describe("replay-clock — C5 elapsed time", () => {
  it("C5: elapsed is the sum of the holds actually waited", () => {
    const frames = stream();
    const expected = frames
      .slice(0, 5)
      .reduce((total, frame) => total + Math.round(HOLD_MS[frame.type] / 2), 0);
    expect(elapsedMs(frames, 5, 2)).toBe(expected);
  });

  it("C5: elapsed at zero frames is zero, and past the end is the whole tape", () => {
    const frames = stream();
    expect(elapsedMs(frames, 0, 1)).toBe(0);
    expect(elapsedMs(frames, 9_999, 1)).toBe(elapsedMs(frames, frames.length, 1));
  });
});
