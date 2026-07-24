/** Public snapshot report. There is NO SSE for public scans — this dialog
 * self-polls the detail endpoint every 2.5s while the scan is running. */

import { ExternalLink, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { PublicScanDep, PublicScanDetailResponse } from "../../lib/engine-types.ts";
import { formatDate } from "../../lib/format.ts";
import { usePanelStore } from "../../stores/panelStore.ts";
import { PanelDialog } from "./PanelDialog.tsx";
import { VerdictPill } from "./tone.tsx";

const POLL_MS = 2500;

function depReason(dep: PublicScanDep): string {
  if (dep.reason) return dep.reason;
  if (dep.verdict === null) return dep.active ? "Audit in progress" : "No reproducible verdict";
  return "—";
}

interface PublicAuditReportDialogProps {
  scanId: number;
  onClose: () => void;
}

export function PublicAuditReportDialog({ scanId, onClose }: PublicAuditReportDialogProps) {
  const fetchPublicScanDetail = usePanelStore((s) => s.fetchPublicScanDetail);
  const [data, setData] = useState<PublicScanDetailResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const detail = await fetchPublicScanDetail(scanId);
        if (cancelled) return;
        setData(detail);
        setLoadError(null);
        if (detail.scan.status === "running") timer = setTimeout(() => void load(), POLL_MS);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Could not load the snapshot");
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [scanId, fetchPublicScanDetail]);

  const scan = data?.scan ?? null;
  const running = scan?.status === "running";
  const completed = scan ? scan.cached + scan.audited + scan.failed : 0;

  return (
    <PanelDialog ariaLabel={`Public audit snapshot ${scanId}`} onClose={onClose} wide>
      <div className="dialog__header">
        <div className="panel-report__head">
          <span className="eyebrow">Snapshot #{scanId}</span>
          <h2 className="headline">{scan ? scan.fullName : "Loading snapshot"}</h2>
          {scan && (
            <p className="microtext mono">
              {scan.lockfilePath} · {scan.defaultBranch} · {formatDate(scan.startedAt)}
            </p>
          )}
        </div>
        <div className="panel-report__side">
          {scan &&
            (running ? (
              <span className="pill pill--running">Running</span>
            ) : scan.rollup.verdict ? (
              <VerdictPill verdict={scan.rollup.verdict} />
            ) : (
              <span className="pill">Done</span>
            ))}
          {scan && (
            <a className="btn btn--sm" href={scan.htmlUrl} target="_blank" rel="noreferrer">
              Open on GitHub <ExternalLink size={13} />
            </a>
          )}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="dialog__body">
        {!data && !loadError && (
          <div className="panel-loading" role="status">
            <span className="spinner" /> Loading snapshot…
          </div>
        )}
        {loadError && (
          <p className="banner banner--danger" role="alert">
            {loadError}
          </p>
        )}
        {data && scan && (
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
                  aria-valuemax={scan.total}
                  aria-valuenow={completed}
                >
                  <div
                    className="meter__fill"
                    style={{
                      width: scan.total > 0 ? `${Math.round((completed / scan.total) * 100)}%` : "0%",
                    }}
                  />
                </div>
                <span className="microtext mono">
                  {completed}/{scan.total} resolved
                </span>
              </div>
            )}
            {scan.error && (
              <p className="banner banner--danger" role="alert">
                {scan.error}
              </p>
            )}
            <dl className="panel-summary">
              <div>
                <dt className="eyebrow eyebrow--faint">Packages</dt>
                <dd>{scan.total}</dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Dangerous</dt>
                <dd className={scan.rollup.dangerous > 0 ? "is-danger" : undefined}>
                  {scan.rollup.dangerous}
                </dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Suspect</dt>
                <dd className={scan.rollup.suspect > 0 ? "is-suspect" : undefined}>
                  {scan.rollup.suspect}
                </dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Unknown</dt>
                <dd>{scan.rollup.unknown}</dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Safe</dt>
                <dd className={scan.rollup.safe > 0 ? "is-safe" : undefined}>{scan.rollup.safe}</dd>
              </div>
              <div>
                <dt className="eyebrow eyebrow--faint">Cached</dt>
                <dd>{scan.cached}</dd>
              </div>
            </dl>
            {data.dependenciesTruncated && (
              <p className="banner banner--suspect">
                Showing the 500 highest-priority dependencies — the summary above covers the full
                lockfile.
              </p>
            )}
            {data.dependencies.length === 0 ? (
              <div className="empty-state">No npm dependencies in this lockfile.</div>
            ) : (
              <div className="panel-tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Dependency</th>
                      <th>Source</th>
                      <th>Verdict</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.dependencies.map((dep) => (
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
                          {dep.verdict ? (
                            <VerdictPill verdict={dep.verdict} />
                          ) : dep.active ? (
                            <span className="pill pill--running">Queued</span>
                          ) : (
                            <span className="pill pill--unknown">Unresolved</span>
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
