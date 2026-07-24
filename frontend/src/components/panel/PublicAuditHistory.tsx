/** Recent public-repository snapshots (up to 6 rows). Rows link into the
 * report dialog; running rows show the polling-driven progress meter. */

import type { PublicScan } from "../../lib/engine-types.ts";
import { formatDate } from "../../lib/format.ts";
import { VerdictPill } from "./tone.tsx";

interface PublicAuditHistoryProps {
  scans: PublicScan[];
  onOpen: (scanId: number) => void;
}

export function PublicAuditHistory({ scans, onOpen }: PublicAuditHistoryProps) {
  if (scans.length === 0) return null;

  return (
    <section className="panel-section" aria-label="Public repository audits">
      <div className="section-title">
        <span className="eyebrow eyebrow--faint">Public repository audits</span>
        <span className="microtext">Read-only snapshots</span>
      </div>
      <div className="card panel-history">
        {scans.slice(0, 6).map((scan) => {
          const running = scan.status === "running";
          const completed = scan.cached + scan.audited + scan.failed;
          const width = scan.total > 0 ? `${Math.round((completed / scan.total) * 100)}%` : "0%";
          return (
            <div key={scan.id} className="panel-history__row">
              <div className="panel-history__id">
                <button
                  type="button"
                  className="panel-history__name mono"
                  onClick={() => onOpen(scan.id)}
                >
                  {scan.owner}/{scan.name}
                </button>
                <span className="microtext mono">
                  {scan.lockfilePath} · {scan.defaultBranch}
                </span>
                <div className="panel-history__tags">
                  <span className="tag">Public</span>
                  <span className="tag">Snapshot</span>
                  <span className="tag">No write</span>
                </div>
              </div>
              <div className="panel-history__status">
                {running ? (
                  <>
                    <span className="panel-history__statusrow">
                      <span className="dot dot--running" />
                      <span className="microtext">Scanning</span>
                      <span className="microtext mono">
                        {completed}/{scan.total}
                      </span>
                    </span>
                    <div
                      className="meter"
                      role="progressbar"
                      aria-label={`Scan progress for ${scan.fullName}`}
                      aria-valuemin={0}
                      aria-valuemax={scan.total}
                      aria-valuenow={completed}
                    >
                      <div className="meter__fill" style={{ width }} />
                    </div>
                  </>
                ) : (
                  <span className="panel-history__statusrow">
                    {scan.rollup.verdict ? (
                      <VerdictPill verdict={scan.rollup.verdict} />
                    ) : (
                      <span className="pill">Done</span>
                    )}
                    <span className="microtext">{formatDate(scan.finishedAt)}</span>
                  </span>
                )}
                <span className="microtext">
                  {scan.total} packages · {scan.cached} cached · {scan.failed} unresolved
                </span>
              </div>
              <div className="panel-history__side">
                <button type="button" className="btn btn--sm" onClick={() => onOpen(scan.id)}>
                  {running ? "View progress" : "Report"}
                </button>
                <span className="microtext">
                  Allowance · <span className="mono">{scan.accountLogin}</span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
