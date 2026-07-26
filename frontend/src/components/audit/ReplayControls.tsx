/**
 * Replay controls, and the live-ingestion resume that shares the same dock.
 *
 * Two modes, one bar, because they are two states of one thing: a recorded audit
 * is a tape you drive, and a live audit is a tape that is still being written.
 * Pausing a live one does not stop ingestion — it stops the PLAYHEAD, so the
 * distance to the tape's head becomes `Resume live · N new`.
 *
 * ── Auto-resume, and the three cases where it must not fire ─────────────────
 *
 * After 12 seconds without deliberate activity a paused live view offers to
 * catch up, warning for five. It is a convenience for someone who glanced away,
 * and it must never take the page from someone who is using it. So it does not
 * arm at all while the inspector is open, while text is selected, or while focus
 * is inside a control — and `Stay paused` turns it off for the rest of this
 * inspection.
 *
 * Deliberate activity is pointer, key, scroll, zoom or selection. Not a frame
 * arriving: the whole point is that frames keep arriving.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  RotateCcw,
  Radio,
} from "lucide-react";
import { useAuditStore, unseenCount } from "../../stores/auditStore.ts";
import { SPEEDS, elapsedMs, holdMsFor, type Speed } from "../../lib/replay-clock.ts";
import { Button } from "../ui/button.tsx";

const IDLE_BEFORE_WARNING_MS = 12_000;
const WARNING_MS = 5_000;

export function ReplayControls() {
  const frames = useAuditStore((s) => s.tape.frames);
  const playhead = useAuditStore((s) => s.playhead);
  const playing = useAuditStore((s) => s.playing);
  const speed = useAuditStore((s) => s.speed);
  const running = useAuditStore((s) => s.running);
  const unseen = useAuditStore(unseenCount);
  const setPlaying = useAuditStore((s) => s.setPlaying);
  const setSpeed = useAuditStore((s) => s.setSpeed);
  const seekTo = useAuditStore((s) => s.seekTo);
  const stepBackward = useAuditStore((s) => s.stepBackward);
  const stepForward = useAuditStore((s) => s.stepForward);
  const restart = useAuditStore((s) => s.restart);

  const total = frames.length;
  const elapsed = elapsedMs(frames, playhead, speed);
  const duration = elapsedMs(frames, total, speed);

  useReplayClock();
  const countdown = useAutoResume(running && !playing && unseen > 0);

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border bg-surface px-3 py-2"
      role="group"
      aria-label="Replay controls"
    >
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Restart"
          onClick={restart}
          className="min-w-[--ng-tap-min]"
        >
          <RotateCcw aria-hidden="true" className="size-icon-sm" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Previous significant event"
          onClick={stepBackward}
          className="min-w-[--ng-tap-min]"
        >
          <ChevronLeft aria-hidden="true" className="size-icon-sm" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={playing ? "Pause" : "Play"}
          aria-pressed={playing}
          onClick={() => setPlaying(!playing)}
          className="min-w-[--ng-tap-min]"
        >
          {playing ? (
            <Pause aria-hidden="true" className="size-icon-sm" />
          ) : (
            <Play aria-hidden="true" className="size-icon-sm" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Next significant event"
          onClick={stepForward}
          className="min-w-[--ng-tap-min]"
        >
          <ChevronRight aria-hidden="true" className="size-icon-sm" />
        </Button>
      </div>

      {/* Scrubbing is by SEMANTIC EVENT INDEX, not by time. Time is a
          presentation of the index (speed scales it), so dragging a time axis
          would move a different distance at every speed for the same drag. */}
      <label className="flex min-w-40 flex-1 items-center gap-2">
        <span className="sr-only">Seek to event</span>
        <input
          type="range"
          min={0}
          max={Math.max(total, 1)}
          value={playhead}
          onChange={(event) => seekTo(Number(event.target.value))}
          className="h-[--ng-tap-min] min-w-32 flex-1 accent-[--ng-accent]"
          aria-valuetext={`event ${playhead} of ${total}`}
        />
        <span className="font-mono text-2xs whitespace-nowrap text-text-3 tabular-nums">
          {formatClock(elapsed)} / {formatClock(duration)}
        </span>
      </label>

      <div className="flex items-center gap-0.5" role="group" aria-label="Playback speed">
        {SPEEDS.map((option) => (
          <Button
            key={option}
            variant={option === speed ? "outline" : "ghost"}
            size="sm"
            aria-pressed={option === speed}
            onClick={() => setSpeed(option as Speed)}
            className="min-w-[--ng-tap-min] font-mono text-2xs"
          >
            {option}×
          </Button>
        ))}
      </div>

      {unseen > 0 ? <ResumeLive unseen={unseen} countdown={countdown} /> : null}
    </div>
  );
}

function ResumeLive({ unseen, countdown }: { unseen: number; countdown: number | null }) {
  const resumeLive = useAuditStore((s) => s.resumeLive);
  const setStayPaused = useAuditStore((s) => s.setStayPaused);
  return (
    <div className="flex items-center gap-1.5" role="status" aria-live="polite">
      <Button size="sm" variant="outline" onClick={resumeLive} className="min-w-[--ng-tap-min]">
        <Radio aria-hidden="true" className="size-icon-sm" />
        <span className="tabular-nums">
          {countdown === null ? `Resume live · ${unseen} new` : `Resume live in ${countdown}`}
        </span>
      </Button>
      {countdown !== null ? (
        <Button size="sm" variant="ghost" onClick={() => setStayPaused(true)}>
          Stay paused
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Releases frames while playing, at the pace `replay-clock` decides.
 *
 * A chain of timeouts rather than an interval: each frame's hold depends on its
 * own type, and an interval would give a file scan and a verdict the same beat.
 */
function useReplayClock() {
  const frames = useAuditStore((s) => s.tape.frames);
  const playhead = useAuditStore((s) => s.playhead);
  const playing = useAuditStore((s) => s.playing);
  const speed = useAuditStore((s) => s.speed);
  const advance = useAuditStore((s) => s.advance);

  useEffect(() => {
    if (!playing || playhead >= frames.length) return;
    const timer = window.setTimeout(() => advance(), holdMsFor(frames[playhead], speed));
    return () => window.clearTimeout(timer);
  }, [advance, frames, playhead, playing, speed]);
}

/**
 * The idle countdown. Returns the seconds remaining while warning, else null.
 *
 * Every exclusion is checked at FIRE time as well as at arm time, because the
 * state that forbids resuming can arrive during the twelve seconds — someone
 * starts selecting text at second eleven.
 */
function useAutoResume(armed: boolean): number | null {
  const inspecting = useAuditStore((s) => s.inspecting);
  const stayPaused = useAuditStore((s) => s.stayPaused);
  const resumeLive = useAuditStore((s) => s.resumeLive);
  const [countdown, setCountdown] = useState<number | null>(null);
  const lastActivity = useRef(Date.now());

  const blocked = useCallback(() => {
    if (!armed || stayPaused || inspecting !== null) return true;
    if ((window.getSelection()?.toString().length ?? 0) > 0) return true;
    const focused = document.activeElement;
    return Boolean(
      focused &&
        focused !== document.body &&
        focused.closest("button, a, input, select, textarea, [tabindex]"),
    );
  }, [armed, inspecting, stayPaused]);

  useEffect(() => {
    const bump = () => {
      lastActivity.current = Date.now();
      setCountdown(null);
    };
    const events = ["pointerdown", "keydown", "wheel", "scroll", "selectionchange"] as const;
    for (const name of events) window.addEventListener(name, bump, { passive: true });
    return () => {
      for (const name of events) window.removeEventListener(name, bump);
    };
  }, []);

  useEffect(() => {
    if (!armed) {
      setCountdown(null);
      return;
    }
    const timer = window.setInterval(() => {
      if (blocked()) {
        setCountdown(null);
        lastActivity.current = Date.now();
        return;
      }
      const idle = Date.now() - lastActivity.current;
      if (idle < IDLE_BEFORE_WARNING_MS) {
        setCountdown(null);
        return;
      }
      const remaining = Math.ceil((IDLE_BEFORE_WARNING_MS + WARNING_MS - idle) / 1000);
      if (remaining <= 0) {
        setCountdown(null);
        resumeLive();
        return;
      }
      setCountdown(remaining);
    }, 500);
    return () => window.clearInterval(timer);
  }, [armed, blocked, resumeLive]);

  return countdown;
}

function formatClock(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Space toggles playback; left/right step between significant events. */
export function useReplayKeyboard() {
  const setPlaying = useAuditStore((s) => s.setPlaying);
  const playing = useAuditStore((s) => s.playing);
  const stepBackward = useAuditStore((s) => s.stepBackward);
  const stepForward = useAuditStore((s) => s.stepForward);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal a key from a control the viewer is operating — space in a
      // button is that button's, not the transport's.
      if (target?.closest("input, textarea, select, button, a, [contenteditable]")) return;
      if (event.key === " ") {
        event.preventDefault();
        setPlaying(!playing);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepBackward();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        stepForward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing, setPlaying, stepBackward, stepForward]);
}

export const AUTO_RESUME_IDLE_MS = IDLE_BEFORE_WARNING_MS;
export const AUTO_RESUME_WARNING_MS = WARNING_MS;
