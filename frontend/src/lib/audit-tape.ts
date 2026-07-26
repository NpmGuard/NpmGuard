/**
 * The event tape — every durable frame this session has received, in sequence
 * order, and the only thing a seek reads.
 *
 * One tape serves both audits a viewer can watch, and the difference between
 * them is a release POLICY rather than a second renderer:
 *
 *   live      — a frame is appended and immediately folded into what is visible;
 *   recorded  — the whole durable stream is appended up front, and a client clock
 *               releases frames into the same fold.
 *
 * That is what makes seeking exact. `stateAt(tape, n)` folds frames 0…n from a
 * clean initial state, so a scrub is a re-derivation and never an undo: there is
 * no reverse transition to get wrong, and no accumulated drift to diverge from a
 * fresh load of the same audit.
 *
 * Transport writes here. Presentation reads `playhead`. Keeping those apart is
 * what lets a viewer pause a live audit — ingestion continues into the tape while
 * the visible playhead stays where they left it, and `Resume live · N new` is
 * simply the distance between the two.
 */

import type { AuditEventUnion, AuditEventType } from "@npmguard/shared";
import { foldAuditEvent, initialFoldState, type AuditFoldState } from "./audit-fold.ts";

export interface AuditTape {
  /** frames in `seq` order, deduped */
  frames: readonly AuditEventUnion[];
  /** indices into `frames` that a viewer would want to step between */
  significant: readonly number[];
}

/**
 * The frames prev/next step between, and the ones a scrubber snaps to.
 *
 * Chosen as "what changed the investigation", which is exactly the set a reader
 * would scroll back to find: a suspicion, a plan, a run, a judgment, a verdict.
 * File scanning is deliberately absent — it is the highest-volume event class and
 * stepping through 400 of them to reach the first hypothesis is not navigation.
 */
const SIGNIFICANT: ReadonlySet<AuditEventType> = new Set<AuditEventType>([
  "audit_started",
  "file_verdict",
  "hypothesis_emitted",
  "experiment_started",
  "sandbox_started",
  "sandbox_completed",
  "judgment_started",
  "hypothesis_resolved",
  "verdict_reached",
  "audit_error",
]);

export function emptyTape(): AuditTape {
  return { frames: [], significant: [] };
}

/**
 * Append one frame.
 *
 * A duplicate `seq` is dropped here as well as in the fold, and the redundancy is
 * deliberate: the fold's guard keeps STATE correct under replay, but a tape that
 * grew a second copy would shift every index after it — so a seek target taken
 * before a reconnect would land on a different frame afterwards.
 *
 * Out-of-order arrival is handled by inserting at the right place rather than by
 * sorting the whole tape: frames arrive in order in practice, so this is a
 * tail-append with a fallback that keeps the invariant total.
 */
export function appendFrame(tape: AuditTape, event: AuditEventUnion): AuditTape {
  const frames = tape.frames;
  if (frames.some((frame) => frame.seq === event.seq)) return tape;

  const last = frames[frames.length - 1];
  const next =
    last === undefined || last.seq < event.seq
      ? [...frames, event]
      : [...frames, event].sort((a, b) => a.seq - b.seq);

  return {
    frames: next,
    significant: next.reduce<number[]>((acc, frame, index) => {
      if (SIGNIFICANT.has(frame.type)) acc.push(index);
      return acc;
    }, []),
  };
}

export function appendFrames(tape: AuditTape, events: readonly AuditEventUnion[]): AuditTape {
  return events.reduce(appendFrame, tape);
}

/**
 * The visible state after `count` frames — the ONE way state is derived at any
 * playhead, live or seeked.
 *
 * `count` is a length, not an index, so `stateAt(tape, 0)` is the empty audit and
 * `stateAt(tape, tape.frames.length)` is the whole of it. Callers scrub in frame
 * counts, and an off-by-one in a scrubber is then a visibly empty screen rather
 * than a silently missing last event.
 */
export function stateAt(tape: AuditTape, count: number): AuditFoldState {
  const bounded = Math.max(0, Math.min(count, tape.frames.length));
  let state = initialFoldState();
  for (let index = 0; index < bounded; index += 1) {
    state = foldAuditEvent(state, tape.frames[index]);
  }
  return state;
}

/** The next significant frame at or after `count`, or the tape's end. */
export function nextSignificant(tape: AuditTape, count: number): number {
  const found = tape.significant.find((index) => index + 1 > count);
  return found === undefined ? tape.frames.length : found + 1;
}

/** The previous significant frame strictly before `count`, or the start. */
export function previousSignificant(tape: AuditTape, count: number): number {
  const found = [...tape.significant].reverse().find((index) => index + 1 < count);
  return found === undefined ? 0 : found + 1;
}
