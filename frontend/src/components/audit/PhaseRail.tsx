/**
 * PhaseRail — pipeline progress, in two shapes for two places.
 *
 * `compact` is a SEGMENT STRIP: one dash per phase, filled as far as the audit
 * has got, with the active phase NAMED beside it. That is what the full rail
 * degenerates into when it is merely shrunk — six ticks and "17ms · 2ms · 254ms"
 * is a row of numbers a reader cannot turn back into a position. A progress
 * indicator has to answer "how far along, and doing what"; that answered neither.
 *
 * ★ THE RAIL IS ACHROMATIC, AND THAT IS THE POINT.
 *
 * It once marked a completed phase with a GREEN dot. That is a verdict colour on
 * the progress axis, which this component demonstrates better than any other: a
 * row of green across the top of a live audit reads as "so far, so good", i.e.
 * as a running tally of SAFE findings. It is nothing of the kind — a package can
 * complete every phase and still be DANGEROUS. So the rail is neutral ink and
 * the only hue is `progress-mark` on the segment currently moving.
 *
 * State travels as POSITION and a GLYPH first, so the rail is readable with all
 * colour removed and under `prefers-reduced-motion`.
 */

import { Check, Circle, LoaderCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { PHASE_LABELS, type PhaseStatus } from "../../lib/types.ts";
import { formatDuration } from "../../lib/format.ts";
import { cn } from "../../lib/cn.ts";

export interface PhaseRailProps {
  compact?: boolean;
}

/** The per-phase silhouettes, over the statuses this pipeline actually produces.
 * `PhaseStatus` is `pending | active | done` and the fold emits nothing else, so
 * arms for `skipped`/`failed` would be unreachable code dressed as thoroughness.
 * Add them when the fold does — a phase status the engine cannot send is a state
 * the UI should not be able to represent. */
const GLYPH: Record<PhaseStatus, LucideIcon> = {
  done: Check,
  active: LoaderCircle,
  pending: Circle,
};

export function PhaseRail({ compact = false }: PhaseRailProps) {
  const phases = useAuditStore((s) => s.phases);

  if (compact) {
    const done = phases.filter((phase) => phase.status === "done").length;
    const active = phases.find((phase) => phase.status === "active");
    const label = active ? (PHASE_LABELS[active.name] ?? active.name) : null;
    return (
      <div
        className="flex min-w-0 items-center gap-2.5"
        role="group"
        aria-label={`Audit phases — ${done} of ${phases.length} complete`}
      >
        <ol aria-hidden="true" className="flex shrink-0 items-center gap-1">
          {phases.map((phase) => (
            <li
              key={phase.name}
              data-phase={phase.status}
              className={cn(
                "h-0.5 w-5 rounded-full transition-colors duration-base",
                phase.status === "done" && "bg-progress-ink",
                phase.status === "active" && "bg-progress-mark",
                phase.status === "pending" && "bg-progress-track",
              )}
            />
          ))}
        </ol>
        <span className="truncate font-mono text-2xs text-text-3">
          {label ?? `${done}/${phases.length}`}
        </span>
      </div>
    );
  }

  return (
    <ol aria-label="Audit phases" className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {phases.map((phase) => {
        const active = phase.status === "active";
        const Glyph = GLYPH[phase.status];
        return (
          <li
            key={phase.name}
            data-phase={phase.status}
            aria-current={active ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 text-2xs whitespace-nowrap",
              phase.status === "pending" ? "text-progress-idle" : "text-progress-ink",
            )}
          >
            <Glyph
              aria-hidden="true"
              strokeWidth={1.5}
              className={cn(
                "size-icon-sm shrink-0",
                active && "animate-spin text-progress-mark motion-reduce:animate-none",
              )}
            />
            <span>{PHASE_LABELS[phase.name] ?? phase.name}</span>
            {phase.status === "done" && phase.durationMs != null ? (
              <span className="font-mono text-2xs tabular-nums text-text-3">
                {formatDuration(phase.durationMs)}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
