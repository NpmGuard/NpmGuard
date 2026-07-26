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
 * Read as a reading budget, not as a duration: a hypothesis arriving is a
 * sentence to absorb (800ms), one sandbox observation is a line to scan (120ms),
 * and a verdict is the end of the story (1200ms). File scans are the one class
 * paced as texture rather than as content — they are batched visually, and their
 * hold is short enough that 300 of them read as a sweep instead of a slideshow.
 */
export const HOLD_MS: Record<AuditEventType, number> = {
  audit_enqueued: 200,
  audit_started: 400,
  phase_started: 320,
  phase_completed: 60,
  dependencies_provisioned: 200,
  file_list: 400,
  inventory_meta: 200,
  intent_extracted: 500,
  file_analyzing: 45,
  triage_progress: 45,
  hypothesis_emitted: 800,
  file_verdict: 650,
  triage_complete: 500,
  graph_built: 400,
  experiment_started: 280,
  sandbox_started: 500,
  sandbox_completed: 640,
  judgment_started: 650,
  hypothesis_resolved: 900,
  verdict_reached: 1200,
  audit_error: 1200,
};

/**
 * The wait before the frame AFTER this one is released.
 *
 * Rounded to a whole millisecond so a scrubber's elapsed readout is the sum of
 * exactly what was waited, rather than drifting by a fraction per frame over a
 * few hundred frames.
 */
export function holdMsFor(event: AuditEventUnion, speed: Speed): number {
  return Math.round((HOLD_MS[event.type] ?? 200) / speed);
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
  let total = 0;
  for (let index = 0; index < Math.min(count, frames.length); index += 1) {
    total += holdMsFor(frames[index], speed);
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
