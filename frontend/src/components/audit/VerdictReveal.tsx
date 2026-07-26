/**
 * The verdict dock — the workspace's bottom region, occupied from the first
 * frame so the verdict lands somewhere the eye is already watching.
 *
 * It is a DOCK, not a report. The graph above it is the argument; this states
 * the conclusion, its coverage, and the way to the durable report. Rendering a
 * whole report here is what squeezed the canvas out of the workspace — the graph
 * is the surface, and a bottom region that grows without bound takes it.
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
import { ArrowRight } from "lucide-react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { DegradedRegion } from "../ui/degraded-state.tsx";
import { VerdictHeadline } from "../ui/verdict-stamp.tsx";
import { Button } from "../ui/button.tsx";

export function VerdictReveal() {
  const verdict = useAuditStore((s) => s.verdict);
  const rationale = useAuditStore((s) => s.verdictRationale);
  const counts = useAuditStore((s) => s.counts);
  const error = useAuditStore((s) => s.error);
  const errorCode = useAuditStore((s) => s.errorCode);
  const errorRetryable = useAuditStore((s) => s.errorRetryable);
  const packageName = useAuditStore((s) => s.packageName);
  const version = useAuditStore((s) => s.inventoryMeta?.metadata.version ?? "");
  const hypotheses = useAuditStore((s) => s.hypotheses);
  const startAudit = useAuditStore((s) => s.startAudit);

  const reduce = useReducedMotion();

  if (!verdict && !error) return null;

  // 420ms, opacity and a short rise. No bounce, no scale, no confetti, no sound:
  // a security verdict is not a reward, and SAFE is the quietest state the
  // product has.
  const motionProps = reduce
    ? {}
    : {
        initial: { opacity: 0, y: 4 },
        animate: { opacity: 1, y: 0 },
        transition: { duration: 0.42, ease: "easeOut" as const },
      };

  if (error) {
    const unresolved = hypotheses.filter(
      (item) => item.state === "DEFERRED" || item.state === "OPEN",
    );
    return (
      <motion.div {...motionProps}>
        {/* `DegradedRegion` rather than a hand-built banner: it is already the
            component that names a failure, refuses to render without naming it,
            wears the violet hatch, and carries retry only when retrying is
            meaningful. A second implementation here would be a second place for
            the red to come back. */}
        <DegradedRegion
          title="Could not conclude"
          failure={{
            what: "This audit",
            detail:
              [
                error,
                errorCode,
                // The dock NAMES what was left unresolved. "Could not conclude"
                // without saying what is missing is a shrug.
                unresolved.length
                  ? `unresolved: ${unresolved.map((item) => item.hypId).join(", ")}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ") || undefined,
            retry: errorRetryable
              ? () => void startAudit(packageName, version || undefined)
              : undefined,
          }}
        />
      </motion.div>
    );
  }

  return (
    <motion.div className="flex flex-wrap items-center gap-x-4 gap-y-2" {...motionProps}>
      {/* `counts` is a REQUIRED prop of the headline, so a verdict cannot render
          without the coverage it was drawn from — and SAFE always carries "No
          confirmed threat found. Not a proof of absence." */}
      <VerdictHeadline
        outcome={verdict!}
        counts={
          counts ?? { total: 0, open: 0, inProgress: 0, confirmed: 0, refuted: 0, deferred: 0 }
        }
      />
      {rationale ? <p className="min-w-0 flex-1 text-xs text-text-2">{rationale}</p> : null}
      {packageName ? (
        <Button asChild variant="outline" size="sm">
          <a href={`/package/${packageName}${version ? `?version=${version}` : ""}`}>
            Full report
            <ArrowRight aria-hidden="true" className="size-icon-sm" />
          </a>
        </Button>
      ) : null}
    </motion.div>
  );
}
