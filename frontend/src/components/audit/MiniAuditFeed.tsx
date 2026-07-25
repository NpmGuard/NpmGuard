/**
 * MiniAuditFeed — a compact, height-capped embed of the live feed for the
 * Landing live-demo strip. Reuses the exact same components (PhaseRail /
 * AuditFeed / VerdictReveal) reading the exact same store — so the demo is
 * contract-faithful and never drifts from the real Live Audit screen. Props are
 * optional; it reads the store directly.
 */

import { useAuditStore } from "../../stores/auditStore.ts";
import { PhaseRail } from "./PhaseRail.tsx";
import { AuditFeed } from "./AuditFeed.tsx";
import { VerdictReveal } from "./VerdictReveal.tsx";

export function MiniAuditFeed() {
  const verdict = useAuditStore((s) => s.verdict);
  const error = useAuditStore((s) => s.error);
  const packageName = useAuditStore((s) => s.packageName);

  return (
    <div
      aria-label={`live demo audit of ${packageName || "package"}`}
      className="overflow-hidden rounded-lg border border-border bg-surface shadow-card"
    >
      <div className="border-b border-border-faint px-3 py-2">
        <PhaseRail compact />
      </div>
      <AuditFeed compact />
      {verdict || error ? (
        <div className="border-t border-border-faint px-3 pt-1 pb-3">
          <VerdictReveal />
        </div>
      ) : null}
    </div>
  );
}
