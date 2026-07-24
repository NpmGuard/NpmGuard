/** Compact last-scan status: not-audited / running progress meter
 * (completed = cached + audited + failed) / failed / verdict + date. */

import type { ScanSummary } from "../../lib/engine-types.ts";
import { formatDate } from "../../lib/format.ts";
import { VerdictPill } from "./tone.tsx";

export function ScanStatus({ scan }: { scan: ScanSummary | null }) {
  if (!scan) {
    return (
      <div className="panel-scanstatus">
        <span className="dot" />
        <span className="microtext">Not audited</span>
      </div>
    );
  }

  if (scan.status === "running") {
    const completed = scan.cached + scan.audited + scan.failed;
    const width = scan.total > 0 ? `${Math.round((completed / scan.total) * 100)}%` : "0%";
    return (
      <div className="panel-scanstatus panel-scanstatus--running">
        <div className="panel-scanstatus__row">
          <span className="dot dot--running" />
          <span className="microtext">Scanning</span>
          <span className="microtext mono">
            {completed}/{scan.total}
          </span>
        </div>
        <div
          className="meter"
          role="progressbar"
          aria-label="Scan progress"
          aria-valuemin={0}
          aria-valuemax={scan.total}
          aria-valuenow={completed}
        >
          <div className="meter__fill" style={{ width }} />
        </div>
      </div>
    );
  }

  if (scan.status === "failed") {
    return (
      <div className="panel-scanstatus">
        <span className="dot dot--danger" />
        <span className="microtext">Scan failed</span>
      </div>
    );
  }

  return (
    <div className="panel-scanstatus">
      {scan.verdict ? <VerdictPill verdict={scan.verdict} /> : <span className="pill">Done</span>}
      <span className="microtext">
        {scan.total} {scan.total === 1 ? "dependency" : "dependencies"} ·{" "}
        {formatDate(scan.finishedAt)}
      </span>
    </div>
  );
}
