/**
 * VerdictReveal — the terminal card. On verdict it renders the shared compact
 * ReportView from the hydrated schemaVersion-2 report; before that report lands
 * it falls back to a fold-derived summary (verdict pill + rationale + counts).
 * On audit_error it renders a danger banner (role="alert") with the code and a
 * retry button when the error is retryable. Audit failure is an ERROR — never a
 * SAFE verdict. Staged motion/react entrance, respecting prefers-reduced-motion.
 */

import { motion, useReducedMotion } from "motion/react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { ReportView } from "../report/ReportView.tsx";
import { VerdictSummary } from "../report/VerdictSummary.tsx";

export function VerdictReveal() {
  const verdict = useAuditStore((s) => s.verdict);
  const report = useAuditStore((s) => s.report);
  const rationale = useAuditStore((s) => s.verdictRationale);
  const counts = useAuditStore((s) => s.counts);
  const error = useAuditStore((s) => s.error);
  const errorCode = useAuditStore((s) => s.errorCode);
  const errorRetryable = useAuditStore((s) => s.errorRetryable);
  const packageName = useAuditStore((s) => s.packageName);
  const version = useAuditStore((s) => s.inventoryMeta?.metadata.version ?? "");
  const startAudit = useAuditStore((s) => s.startAudit);

  const reduce = useReducedMotion();

  if (!verdict && !error) return null;

  const motionProps = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.2, ease: "easeOut" as const },
      };

  if (error) {
    return (
      <motion.div className="audit-verdict" {...motionProps}>
        <div className="banner banner--danger audit-verdict__error" role="alert">
          <div className="audit-verdict__error-body">
            <span className="eyebrow eyebrow--danger">Audit failed</span>
            <span>{error}</span>
            {errorCode ? <span className="mono microtext audit-verdict__code">{errorCode}</span> : null}
          </div>
          {errorRetryable ? (
            <button
              type="button"
              className="btn btn--sm btn--danger audit-verdict__retry"
              onClick={() => void startAudit(packageName, version || undefined)}
              aria-label={`retry audit of ${packageName}`}
            >
              Retry
            </button>
          ) : null}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div className="audit-verdict" {...motionProps}>
      {report ? (
        <ReportView report={report} packageName={packageName} version={version} variant="compact" />
      ) : verdict ? (
        // Report not yet hydrated — an honest fold-derived summary. counts is
        // present with verdict_reached; guard defensively.
        <VerdictSummary
          verdict={verdict}
          rationale={rationale ?? ""}
          counts={
            counts ?? { total: 0, open: 0, inProgress: 0, confirmed: 0, refuted: 0, deferred: 0 }
          }
        />
      ) : null}
    </motion.div>
  );
}
