/**
 * VerdictReveal — the terminal card. On verdict it renders the shared compact
 * ReportView from the hydrated schemaVersion-2 report; before that report lands
 * it falls back to a fold-derived summary. Staged motion entrance, respecting
 * prefers-reduced-motion.
 *
 * ★ THE ERROR ARM WAS RED, AND THAT WAS THE WORST COLOUR BUG IN THE APP.
 *
 * An `audit_error` rendered `banner--danger` with a `btn--danger` retry: full
 * alarm red, the same red a CONFIRMED malicious finding wears. The file's own
 * docblock said "Audit failure is an ERROR — never a SAFE verdict", and it was
 * right about the direction it checked and wrong about the other one. A user
 * whose audit crashed saw the product's danger colour and reasonably concluded
 * the PACKAGE was dangerous. That is a false positive manufactured by a
 * stylesheet.
 *
 * ERROR is the `error` violet slot, shared with `DegradedState` and with a
 * DEFERRED hypothesis, because all three mean the same thing: we don't know.
 * §0 rule 3 reserves red for claims about a package, and "our sandbox would not
 * start" is not one.
 */

import { motion, useReducedMotion } from "motion/react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { ReportView } from "../report/ReportView.tsx";
import { VerdictSummary } from "../report/VerdictSummary.tsx";
import { DegradedRegion } from "../ui/degraded-state.tsx";

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
      <motion.div className="mt-4" {...motionProps}>
        {/* `DegradedRegion` rather than a hand-built banner: it is already the
            component that names a failure, refuses to render without naming it,
            wears the violet hatch, and carries retry only when retrying is
            meaningful. A second implementation of that here would be a second
            place for the red to come back. */}
        <DegradedRegion
          title="Audit"
          failure={{
            what: "This audit",
            detail: [error, errorCode].filter(Boolean).join(" · ") || undefined,
            retry: errorRetryable
              ? () => void startAudit(packageName, version || undefined)
              : undefined,
          }}
        />
      </motion.div>
    );
  }

  return (
    <motion.div className="mt-4" {...motionProps}>
      {report ? (
        <ReportView report={report} variant="compact" />
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
