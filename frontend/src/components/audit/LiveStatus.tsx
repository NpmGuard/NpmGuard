/**
 * The live activity line — what the investigation is doing RIGHT NOW.
 *
 * It sits at the TAIL of the transcript, pinned, the way an agent loop shows its
 * current step at the bottom of the conversation. That position is the whole
 * point: "what is happening now" is the natural continuation of "what has
 * happened", and a reader following the stream finds it without moving their
 * eyes. As a chip in the top chrome it was competing with the package name for
 * a glance nobody was spending there.
 *
 * It is DERIVED, never stored. The most specific true statement wins:
 *
 *   a hypothesis mid-experiment  →  what that experiment is doing
 *   a file being read            →  the file
 *   otherwise                    →  the phase
 *
 * Specificity matters more than it looks. "Forming & compiling hypotheses" for
 * ninety seconds reads as a hang; "Arming cred_theft in setup.js" for the same
 * ninety seconds reads as work.
 *
 * Nothing here claims to show model reasoning. Every line is a fixed template
 * over a fact the engine emitted — the same rule the transcript follows.
 */

import { LoaderCircle } from "lucide-react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { PHASE_LABELS } from "../../lib/types.ts";
import { CLAIM_LABEL } from "../../lib/investigator-copy.ts";
import type { AuditFoldState } from "../../lib/audit-fold.ts";
import { cn } from "../../lib/cn.ts";

interface Activity {
  headline: string;
  detail: string | null;
}

/** The most specific true statement about what is happening now, or null. */
export function currentActivity(state: AuditFoldState): Activity | null {
  if (!state.running || state.verdict || state.error) return null;

  // An experiment in flight is the most specific thing the audit can be doing,
  // and it is what a viewer is actually waiting on.
  const active = state.hypotheses.find(
    (item) => item.stage === "experiment" || item.stage === "sandbox" || item.stage === "judging",
  );
  if (active) {
    const claim = CLAIM_LABEL[active.claim] ?? active.claim;
    const where = active.focusLines[0]
      ? `${active.focusLines[0].file}:${active.focusLines[0].range}`
      : (active.focusFiles[0] ?? active.hypId);
    const run = state.runs[active.hypId];
    if (active.stage === "experiment") {
      return { headline: `Arming an experiment for ${claim}`, detail: where };
    }
    if (active.stage === "sandbox") {
      return { headline: `Running ${claim} under the full oracle`, detail: where };
    }
    return {
      headline: `Weighing the evidence for ${claim}`,
      detail: run?.display ? `${run.display.eventCount} events recorded` : where,
    };
  }

  if (state.analyzing) {
    return {
      headline: PHASE_LABELS[state.phase ?? ""] ?? "Reading source",
      detail: state.analyzing,
    };
  }

  if (state.triageProgress) {
    const { current, total } = state.triageProgress;
    return { headline: "Reading source files", detail: `${current} of ${total}` };
  }

  if (state.phase) {
    return {
      headline: PHASE_LABELS[state.phase] ?? state.phase,
      detail:
        state.files.length > 0 && state.scannedCount > 0
          ? `${state.scannedCount} of ${state.files.length} files read`
          : null,
    };
  }

  return { headline: "Starting the audit", detail: null };
}

export function LiveStatus({ className }: { className?: string }) {
  const state = useAuditStore();
  const activity = currentActivity(state);
  if (!activity) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-start gap-2.5 border-t border-border bg-accent-wash px-3 py-2.5",
        className,
      )}
    >
      <LoaderCircle
        aria-hidden="true"
        strokeWidth={1.75}
        className="mt-0.5 size-icon-sm shrink-0 animate-spin text-progress-mark motion-reduce:animate-none"
      />
      <div className="min-w-0">
        <p className="text-xs leading-snug font-medium text-text">{activity.headline}</p>
        {activity.detail ? (
          <p className="truncate font-mono text-[11px] text-text-2">{activity.detail}</p>
        ) : null}
      </div>
    </div>
  );
}
