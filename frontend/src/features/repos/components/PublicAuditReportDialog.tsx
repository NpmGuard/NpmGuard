/** Public snapshot report.
 *
 * The detail body is fetched once and then advanced by the audit-set progress
 * STREAM — the same `/panel/scan/:id/events` an owned-repo scan uses, because
 * after R-1 a public audit is the same entity and its id IS a set id. The 2.5s
 * self-poll this replaced was the second progress implementation. */

import type { AuditSetItem } from "@npmguard/shared";
import { ExternalLink, X } from "lucide-react";
import { PanelDialog } from "../../../components/panel/PanelDialog.tsx";
import { OutcomePill } from "../../../components/panel/tone.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import { formatDate } from "../../../lib/format.ts";
import { usePublicScanDetail, usePublicScanStream } from "../hooks.ts";

function depReason(dep: AuditSetItem): string {
  if (dep.verdictReason) return dep.verdictReason;
  // ERROR carries no reason of its own: the audit never produced one. A null
  // outcome always has a live attempt behind it.
  if (dep.outcome === "ERROR") return "Audit could not be completed";
  if (dep.outcome === null) return "Audit in progress";
  return "—";
}

interface PublicAuditReportDialogProps {
  scanId: number;
  onClose: () => void;
}

export function PublicAuditReportDialog({ scanId, onClose }: PublicAuditReportDialogProps) {
  const state = usePublicScanDetail(scanId);
  const data = state.status === "ok" ? state.data : null;

  // Follow the set's progress stream while it is live. The stream writes into the
  // query cache, so there is no second copy of `deps` to keep in step — and the
  // 2.5s self-poll this replaced was the second progress implementation.
  usePublicScanStream(scanId, data?.scan.set.status === "running");

  const scan = data?.scan ?? null;
  const running = scan?.set.status === "running";
  const rollup = scan?.set.rollup ?? null;
  const completed = rollup ? rollup.total - rollup.pending : 0;

  return (
    <PanelDialog ariaLabel={`Public audit snapshot ${scanId}`} onClose={onClose} wide>
      <div className="dialog__header">
        <div className="panel-report__head">
          <span className="eyebrow">Snapshot #{scanId}</span>
          {/* Never "Loading snapshot" over a failed read — the body already says
              what broke, and a title that claims progress contradicts it. */}
          <h2 className="headline">
            {scan
              ? scan.repo.fullName
              : state.status === "failed"
                ? "Snapshot unavailable"
                : "Loading snapshot"}
          </h2>
          {scan && (
            <p className="microtext mono">
              {scan.repo.lockfilePath} · {scan.repo.defaultBranch} ·{" "}
              {formatDate(scan.set.startedAt)}
            </p>
          )}
        </div>
        <div className="panel-report__side">
          {scan &&
            (running ? (
              <span className="pill pill--running">Running</span>
            ) : scan.set.rollup.outcome ? (
              <OutcomePill outcome={scan.set.rollup.outcome} />
            ) : (
              <span className="pill">Nothing to audit</span>
            ))}
          {scan && (
            <a className="btn btn--sm" href={scan.repo.htmlUrl} target="_blank" rel="noreferrer">
              Open on GitHub <ExternalLink size={13} />
            </a>
          )}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="dialog__body">
        {state.status === "loading" && (
          <div className="panel-loading" role="status">
            <span className="spinner" /> Loading snapshot…
          </div>
        )}
        {state.status === "failed" && <DegradedRegion failure={state.failure} title="Snapshot" />}
        {data && scan && rollup && (
          <>
            <div className="panel-report__tags">
              <span className="tag">Read-only snapshot</span>
              <span className="tag">No protect</span>
              <span className="tag">No webhook</span>
              <span className="tag">No GitHub check</span>
            </div>
            {running && (
              <div className="panel-report__progress">
                <div
                  className="meter"
                  role="progressbar"
                  aria-label="Snapshot progress"
                  aria-valuemin={0}
                  aria-valuemax={rollup.total}
                  aria-valuenow={completed}
                >
                  <div
                    className="meter__fill"
                    style={{
                      width:
                        rollup.total > 0
                          ? `${Math.round((completed / rollup.total) * 100)}%`
                          : "0%",
                    }}
                  />
                </div>
                <span className="microtext mono">
                  {completed}/{rollup.total} resolved
                </span>
              </div>
            )}
            <dl className="panel-summary">
              <div>
                <dt className="eyebrow eyebrow--faint">Packages</dt>
                <dd>{rollup.total}</dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Dangerous</dt>
                <dd className={rollup.dangerous > 0 ? "is-danger" : undefined}>
                  {rollup.dangerous}
                </dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Audit failed</dt>
                <dd className={rollup.error > 0 ? "is-error" : undefined}>{rollup.error}</dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Safe</dt>
                <dd className={rollup.safe > 0 ? "is-safe" : undefined}>{rollup.safe}</dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Pending</dt>
                <dd>{rollup.pending}</dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Cached</dt>
                <dd>{rollup.cached}</dd>
              </div>
            </dl>
            {data.depsTruncated && (
              <p className="banner banner--suspect">
                Showing the 500 highest-priority dependencies — the summary above covers the full
                lockfile.
              </p>
            )}
            {data.deps.length === 0 ? (
              <div className="empty-state">No npm dependencies in this lockfile.</div>
            ) : (
              <div className="panel-tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Dependency</th>
                      <th>Source</th>
                      <th>Outcome</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.deps.map((dep) => (
                      <tr key={`${dep.name}@${dep.version}`}>
                        <td className="mono">
                          {dep.name}@{dep.version}
                        </td>
                        <td>
                          {dep.direct ? "Direct" : "Transitive"}
                          {dep.cached && (
                            <span className="microtext panel-cachednote">Cached verdict</span>
                          )}
                        </td>
                        <td>
                          {dep.outcome ? (
                            <OutcomePill outcome={dep.outcome} />
                          ) : (
                            <span className="pill pill--running">Queued</span>
                          )}
                        </td>
                        <td className="panel-reason">{depReason(dep)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </PanelDialog>
  );
}
