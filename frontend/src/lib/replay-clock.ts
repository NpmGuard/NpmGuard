/**
 * Semantic replay timing.
 *
 * A recorded audit is not replayed at the speed it ran. The original wall clock
 * is a fact about a machine — a 40-second model call, a 200ms burst of 300 file
 * reads — and reproducing it would spend most of a replay on nothing happening
 * and the interesting part on a flicker. So pacing is by event CLASS: how long
 * a viewer needs to take in what just happened.
 *
 * What this may never do, and the boundary is the whole reason the module is
 * this small: it decides WAITS. It never reorders a frame, never merges two, and
 * never invents one. Speed divides a wait and changes nothing else — so the
 * state at a given frame is identical at 0.5× and 4×, and a replay cannot show
 * a viewer something the audit did not do.
 *
 * The engine has no say in any of this. It seeds a recording whole and instantly;
 * tempo lives here because only the client can pause, seek and step.
 */

import type { AuditEventUnion, AuditEventType } from "@npmguard/shared";

export const SPEEDS = [0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];
export const DEFAULT_SPEED: Speed = 1;

/**
 * How long each event class holds the screen at 1×, in milliseconds.
 *
 * Read as a READING BUDGET, not as a duration: a hypothesis arriving is a
 * sentence to absorb, one experiment step is a claim to check, and a verdict is
 * the end of the story. File scans are the one class paced as texture rather
 * than as content.
 */
export const HOLD_MS: Record<AuditEventType, number> = {
  audit_enqueued: 260,
  audit_started: 700,
  phase_started: 460,
  phase_completed: 90,
  dependencies_provisioned: 320,
  file_list: 620,
  inventory_meta: 260,
  intent_extracted: 900,
  // A file read is WATCHED, not ticked past: the scan crosses real source and a
  // viewer is meant to see it happen. This is the hold for a package with few
  // files; `fileScanScale` shrinks it for a package with many, so a 300-file
  // scan is a sweep instead of five minutes.
  file_analyzing: 900,
  triage_progress: 900,
  file_verdict: 1100,
  hypothesis_emitted: 1400,
  triage_complete: 700,
  graph_built: 520,
  // The experiment chain is the part a first-time viewer is LEARNING, so it is
  // the slowest. Each frame is a step in an argument — plan, run, weigh, decide
  // — and a step that lands before the previous one has been read teaches
  // nothing. Earlier values (280/500/640/650/900) were paced like a progress
  // bar, which is what made a real investigation read as a flicker.
  experiment_started: 1000,
  sandbox_started: 1100,
  sandbox_completed: 1300,
  judgment_started: 1000,
  hypothesis_resolved: 1600,
  verdict_reached: 2000,
  audit_error: 2000,
};

/**
 * How much of a file read's hold survives, given how many there are.
 *
 * A three-file fixture and a three-hundred-file package cannot share one dwell:
 * at the fixture's pace the big package scans for five minutes, and at the big
 * package's pace the fixture's scan is a flicker. So the dwell scales with the
 * COUNT — and it is a function of the tape, which keeps it deterministic: the
 * same recording paces identically on every load.
 *
 * It compresses waits and nothing else. Order, state and evidence are untouched,
 * which is the line this whole module sits on.
 */
export function fileScanScale(frames: readonly AuditEventUnion[]): number {
  const reads = frames.reduce(
    (total, frame) => total + (frame.type === "file_analyzing" ? 1 : 0),
    0,
  );
  if (reads <= 16) return 1;
  // Total scan time is held near constant past the threshold, floored so a very
  // large package still shows motion rather than a jump.
  return Math.max(0.06, 16 / reads);
}

/**
 * The wait before the frame AFTER this one is released.
 *
 * Rounded to a whole millisecond so a scrubber's elapsed readout is the sum of
 * exactly what was waited, rather than drifting by a fraction per frame over a
 * few hundred frames.
 */
export function holdMsFor(event: AuditEventUnion, speed: Speed, scanScale = 1): number {
  const base = HOLD_MS[event.type] ?? 200;
  const scaled = event.type === "file_analyzing" ? base * scanScale : base;
  return Math.round(scaled / speed);
}

/**
 * Semantic elapsed time up to (not including) frame `count`.
 *
 * "Semantic" because it is the time this REPLAY has spent, which is the number a
 * scrubber must show — the recorded audit's own wall clock belongs to the run,
 * and showing it beside a progress bar the viewer is dragging would be two
 * different clocks in one control.
 */
export function elapsedMs(
  frames: readonly AuditEventUnion[],
  count: number,
  speed: Speed,
): number {
  const scanScale = fileScanScale(frames);
  let total = 0;
  for (let index = 0; index < Math.min(count, frames.length); index += 1) {
    total += holdMsFor(frames[index], speed, scanScale);
  }
  return total;
}

/**
 * How much of a node's entrance animation to actually play at this speed.
 *
 * At 4× a 400ms entrance would still be running when the next two frames land,
 * so nodes would pile up mid-transition and the graph would read as a smear.
 * Clamping to a short opacity fade keeps every arrival legible; it is the same
 * decision `prefers-reduced-motion` makes for a different reason.
 */
export function animationScale(speed: Speed): number {
  return speed >= 4 ? 0.25 : speed >= 2 ? 0.6 : 1;
}
