/** Compact last-audit-set status: not-audited / running progress / outcome + date.
 *
 * Progress is `total - pending` over the set's ONE counters object. The three
 * counters this used to add up (`cached + audited + failed`) were a second,
 * unaudited projection of the same items — nothing made them sum to `total`, so a
 * meter built from them could exceed 100%. `pending` is the one progress counter
 * and the rollup asserts the partition.
 *
 * ── PRESENTATION ────────────────────────────────────────────────────────────
 *
 * Three coloured DOTS are gone, and that is the §2.4 correction rather than a
 * restyle: a dot encodes state in colour alone, and the brief's stated test is
 * "remove all colour and every state is still readable". Each state now travels
 * on a stamp that carries a glyph and a word — `ProgressPill` on the achromatic
 * progress axis, `OutcomePill` for a concluded outcome. `dot--running` was also
 * BLUE, a hue on the progress axis, which is the pair §2.3's colourblind check
 * failed on.
 *
 * `Progress` and not `Meter`: a scan is a task advancing toward completion, which
 * is exactly the distinction §3.2 draws between the two. Its `label` is required
 * and is the same fact the bar carries, so the count survives when animation does
 * not (§2.9 rule 1).
 *
 * DECISION the brief left open — "Nothing to audit" (a set that finished having
 * covered zero packages) is a `Badge`, not a stamp. §3.3's `VerdictStamp` states
 * are the six outcome/progress ones and this is none of them: it is a successful,
 * concluded read of the fact that the lockfile declared no npm dependencies. A
 * `ProgressPill` would say "not attempted" about something that was attempted and
 * finished, and an `OutcomePill` needs an `Outcome` there is honestly none of.
 * Neutral metadata is what is left, and it is the truthful slot. */

import type { AuditSet } from "@npmguard/shared";
import { OutcomePill, ProgressPill } from "../../../components/panel/tone.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Progress } from "../../../components/ui/progress.tsx";
import { formatDate } from "../../../lib/format.ts";

export function ScanStatus({ scan }: { scan: AuditSet | null }) {
  if (!scan) {
    return (
      <div className="flex min-h-5.5 flex-wrap items-center gap-2">
        <ProgressPill state="unaudited">Not audited</ProgressPill>
      </div>
    );
  }

  const { total, pending, outcome } = scan.rollup;
  if (scan.status === "running") {
    const completed = total - pending;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <ProgressPill state="running">Scanning</ProgressPill>
        </div>
        {/* Only over a real population. Radix rejects `max={0}` (and would warn),
            and a bar for a set covering nothing would be a magnitude invented out
            of an empty denominator — the pill above already carries the state. */}
        {total > 0 && (
          <Progress value={completed} max={total} label={`${completed}/${total} concluded`} />
        )}
      </div>
    );
  }

  // A finished set with no outcome covered NOTHING (total === 0) — it cannot mean
  // "nothing concluded yet", because finishing requires pending === 0.
  return (
    <div className="flex min-h-5.5 flex-wrap items-center gap-2">
      {outcome ? <OutcomePill outcome={outcome} /> : <Badge>Nothing to audit</Badge>}
      <span className="text-2xs text-text-3">
        {total} {total === 1 ? "dependency" : "dependencies"} · {formatDate(scan.finishedAt)}
      </span>
    </div>
  );
}
