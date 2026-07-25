/**
 * PhaseRail — the dev pipeline phases (PHASE_ORDER) as a progress strip.
 * Reads store.phases (never re-derives). Status lives on the datum.
 *
 * ★ THE RAIL IS ACHROMATIC, AND THAT IS THE POINT.
 *
 * It used to mark a completed phase with `dot dot--safe` — a GREEN dot — and a
 * running one with `dot--running`. Those are verdict colours on the progress
 * axis, which §2.2 rule 2 forbids for a reason this component demonstrates
 * better than any other: a row of green dots across the top of a live audit
 * reads as "so far, so good", i.e. as a running tally of SAFE findings. It is
 * nothing of the kind. It means the pipeline stages exited cleanly, and a
 * package can complete every phase in green and still be DANGEROUS.
 *
 * So the rail is neutral ink, and the ONLY hue in it is `progress-mark` on the
 * moving arc of the active spinner — the single status-adjacent use of accent
 * the brief permits. Colour on this screen is thereby reserved for the verdict
 * when it lands.
 *
 * §2.4 still applies: state travels as a GLYPH first, so the rail is readable
 * with all colour removed and under `prefers-reduced-motion`, where the spinner
 * stops turning and the arc silhouette is what still says "active".
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

/** §3.3's per-phase silhouettes, over the statuses this pipeline actually
 * produces. The brief also inventories `skipped` and `failed`; `PhaseStatus`
 * (lib/types.ts) is `pending | active | done` and the fold emits nothing else,
 * so arms for them would be unreachable code dressed as thoroughness. Add them
 * when the fold does — a phase status the engine cannot send is a state the UI
 * should not be able to represent (N-4). */
const GLYPH: Record<PhaseStatus, LucideIcon> = {
  done: Check,
  active: LoaderCircle,
  pending: Circle,
};

export function PhaseRail({ compact = false }: PhaseRailProps) {
  const phases = useAuditStore((s) => s.phases);

  return (
    <ol
      aria-label="Audit phases"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", compact && "gap-x-2")}
    >
      {phases.map((p) => {
        const active = p.status === "active";
        const Glyph = GLYPH[p.status];
        const label = PHASE_LABELS[p.name] ?? p.name;
        return (
          <li
            key={p.name}
            data-phase={p.status}
            aria-current={active ? "step" : undefined}
            title={compact ? label : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 text-2xs whitespace-nowrap",
              p.status === "pending" ? "text-progress-idle" : "text-progress-ink",
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
            {/* The compact rail keeps the label for screen readers: dropping it
                from the DOM would make the strip announce as six bullets. */}
            {compact ? <span className="sr-only">{label}</span> : <span>{label}</span>}
            {p.status === "done" && p.durationMs != null ? (
              <span className="font-mono text-2xs tabular-nums text-text-3">
                {formatDuration(p.durationMs)}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
