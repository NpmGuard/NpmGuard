/** Compact last-audit-set status: not-audited / running progress meter /
 * outcome + date.
 *
 * Progress is `total - pending` over the set's ONE counters object. The three
 * counters this used to add up (`cached + audited + failed`) were a second,
 * unaudited projection of the same items — nothing made them sum to `total`, so a
 * meter built from them could exceed 100%. `pending` is the one progress counter
 * and the rollup asserts the partition. */

import type { AuditSet } from "../../lib/engine-types.ts";
import { formatDate } from "../../lib/format.ts";
import { OutcomePill } from "./tone.tsx";

export function ScanStatus({ scan }: { scan: AuditSet | null }) {
  if (!scan) {
    return (
      <div className="panel-scanstatus">
        <span className="dot" />
        <span className="microtext">Not audited</span>
      </div>
    );
  }

  const { total, pending, outcome } = scan.rollup;
  if (scan.status === "running") {
    const completed = total - pending;
    const width = total > 0 ? `${Math.round((completed / total) * 100)}%` : "0%";
    return (
      <div className="panel-scanstatus panel-scanstatus--running">
        <div className="panel-scanstatus__row">
          <span className="dot dot--running" />
          <span className="microtext">Scanning</span>
          <span className="microtext mono">
            {completed}/{total}
          </span>
        </div>
        <div
          className="meter"
          role="progressbar"
          aria-label="Scan progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
        >
          <div className="meter__fill" style={{ width }} />
        </div>
      </div>
    );
  }

  // A finished set with no outcome covered NOTHING (total === 0) — it cannot mean
  // "nothing concluded yet", because finishing requires pending === 0.
  return (
    <div className="panel-scanstatus">
      {outcome ? <OutcomePill outcome={outcome} /> : <span className="pill">Nothing to audit</span>}
      <span className="microtext">
        {total} {total === 1 ? "dependency" : "dependencies"} ·{" "}
        {formatDate(scan.finishedAt)}
      </span>
    </div>
  );
}
