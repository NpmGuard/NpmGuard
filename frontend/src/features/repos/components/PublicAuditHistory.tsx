/** Recent public-repository snapshots (up to 6 rows). Rows link into the
 * report dialog; running rows show a progress meter over the set's rollup.
 *
 * A public audit is an audit SET like any other after R-1: the row reads
 * `scan.set` for progress and `scan.repo` for identity, and its id IS the set id
 * the progress stream is keyed on. */

import type { PublicRepoScan } from "@npmguard/shared";
import { OutcomePill } from "../../../components/panel/tone.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import type { LoadState } from "../../../components/ui/load-state.ts";
import { formatDate } from "../../../lib/format.ts";

interface PublicAuditHistoryProps {
  state: LoadState<PublicRepoScan[]>;
  onOpen: (scanId: number) => void;
}

export function PublicAuditHistory({ state, onOpen }: PublicAuditHistoryProps) {
  if (state.status === "loading") return null;
  if (state.status === "failed") {
    return (
      <section className="panel-section">
        <DegradedRegion failure={state.failure} title="Public repository audits" />
      </section>
    );
  }

  // Empty renders nothing, and only from here — the arm that HELD the data. A
  // history section that has never had a row is not worth a box; a history
  // section we could not read is, and that is the arm above.
  const scans = state.data;
  if (scans.length === 0) return null;

  return (
    <section className="panel-section" aria-label="Public repository audits">
      <div className="section-title">
        <span className="eyebrow eyebrow--faint">Public repository audits</span>
        <span className="microtext">Read-only snapshots</span>
      </div>
      <div className="card panel-history">
        {scans.slice(0, 6).map((scan) => {
          const { total, pending, cached, error, outcome } = scan.set.rollup;
          const running = scan.set.status === "running";
          const completed = total - pending;
          const width = total > 0 ? `${Math.round((completed / total) * 100)}%` : "0%";
          return (
            <div key={scan.id} className="panel-history__row">
              <div className="panel-history__id">
                <button
                  type="button"
                  className="panel-history__name mono"
                  onClick={() => onOpen(scan.id)}
                >
                  {scan.repo.owner}/{scan.repo.name}
                </button>
                <span className="microtext mono">
                  {scan.repo.lockfilePath} · {scan.repo.defaultBranch}
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
                        {completed}/{total}
                      </span>
                    </span>
                    <div
                      className="meter"
                      role="progressbar"
                      aria-label={`Scan progress for ${scan.repo.fullName}`}
                      aria-valuemin={0}
                      aria-valuemax={total}
                      aria-valuenow={completed}
                    >
                      <div className="meter__fill" style={{ width }} />
                    </div>
                  </>
                ) : (
                  <span className="panel-history__statusrow">
                    {outcome ? (
                      <OutcomePill outcome={outcome} />
                    ) : (
                      <span className="pill">Nothing to audit</span>
                    )}
                    <span className="microtext">{formatDate(scan.set.finishedAt)}</span>
                  </span>
                )}
                <span className="microtext">
                  {total} packages · {cached} cached · {error} unresolved
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
