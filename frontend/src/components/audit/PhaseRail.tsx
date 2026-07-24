/**
 * PhaseRail — the 6 dev pipeline phases (PHASE_ORDER) as a progress strip.
 * Reads store.phases + store.phase (never re-derives). active = pulsing running
 * dot, done = safe dot + duration, pending = grey dot. Status lives on the datum.
 */

import { useAuditStore } from "../../stores/auditStore.ts";
import { PHASE_LABELS } from "../../lib/types.ts";
import { formatDuration } from "../../lib/format.ts";

export interface PhaseRailProps {
  compact?: boolean;
}

export function PhaseRail({ compact = false }: PhaseRailProps) {
  const phases = useAuditStore((s) => s.phases);

  return (
    <ol
      className={`audit-phaserail${compact ? " audit-phaserail--compact" : ""}`}
      aria-label="Audit phases"
    >
      {phases.map((p) => {
        const done = p.status === "done";
        const active = p.status === "active";
        const dotClass = done ? "dot dot--safe" : active ? "dot dot--running" : "dot";
        const label = PHASE_LABELS[p.name] ?? p.name;
        return (
          <li
            key={p.name}
            className={`audit-phase audit-phase--${p.status}`}
            aria-current={active ? "step" : undefined}
            title={compact ? label : undefined}
          >
            <span className={dotClass} aria-hidden="true" />
            {compact ? null : <span className="audit-phase__label">{label}</span>}
            {done && p.durationMs != null ? (
              <span className="audit-phase__dur microtext mono">{formatDuration(p.durationMs)}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
