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
    <div className="audit-mini" aria-label={`live demo audit of ${packageName || "package"}`}>
      <PhaseRail compact />
      <div className="audit-mini__body">
        <AuditFeed compact />
      </div>
      {verdict || error ? (
        <div className="audit-mini__verdict">
          <VerdictReveal />
        </div>
      ) : null}
    </div>
  );
}
