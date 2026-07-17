import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { usePanelStore } from "../stores/panelStore";
import type { RepoDep, RepoDetailPayload } from "../lib/panel-types";

const API_BASE = "/api";

type Filter = "all" | "flagged" | "direct" | "pending";
type Action = "audit" | "protect" | "resync";
type Tone = "danger" | "suspect" | "unknown" | "safe" | "pending" | "running";
type IconName = "alert" | "arrow-left" | "branch" | "refresh" | "search" | "shield";

function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    alert: (
      <>
        <path d="M12 3 2.8 19a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </>
    ),
    "arrow-left": (
      <>
        <path d="m15 18-6-6 6-6" />
        <path d="M9 12h12" />
      </>
    ),
    branch: (
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="18" cy="6" r="2" />
        <circle cx="6" cy="19" r="2" />
        <path d="M6 7v10" />
        <path d="M8 7c5 0 4 5 8 5h2" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8.1 8.1 0 1 0 2 5.3" />
        <path d="M20 4v7h-7" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    shield: (
      <>
        <path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3Z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function depTone(dep: RepoDep): Tone {
  if (dep.verdict === "DANGEROUS") return "danger";
  if (dep.verdict === "SUSPECT") return "suspect";
  if (dep.verdict === "SAFE") return "safe";
  if (dep.verdict === "UNKNOWN") return "unknown";
  if (dep.jobState === "running") return "running";
  return "pending";
}

function depStatus(dep: RepoDep): string {
  if (dep.verdict) return dep.verdict;
  if (dep.jobState === "failed") return "Audit failed";
  if (dep.jobState === "running") return "Auditing";
  return "Queued";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function depPriority(dep: RepoDep): number {
  if (dep.verdict === "DANGEROUS") return 0;
  if (dep.verdict === "SUSPECT") return 1;
  if (dep.jobState === "failed") return 2;
  if (dep.jobState === "running") return 3;
  if (!dep.verdict) return 4;
  if (dep.verdict === "UNKNOWN") return 5;
  return 6;
}

export function RepoDetail() {
  const { owner, name } = useParams<{ owner: string; name: string }>();
  const navigate = useNavigate();
  const fetchRepoDetail = usePanelStore((state) => state.fetchRepoDetail);
  const triggerScan = usePanelStore((state) => state.triggerScan);
  const setProtect = usePanelStore((state) => state.setProtect);
  const resync = usePanelStore((state) => state.resync);
  const repoActionErrors = usePanelStore((state) => state.repoActionErrors);
  const clearRepoActionError = usePanelStore((state) => state.clearRepoActionError);

  const [detail, setDetail] = useState<RepoDetailPayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(100);
  const [busyAction, setBusyAction] = useState<Action | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    if (!owner || !name) return;
    const nextDetail = await fetchRepoDetail(owner, name);
    if (!nextDetail) {
      setNotFound(true);
      return;
    }
    setNotFound(false);
    setDetail(nextDetail);
  }, [owner, name, fetchRepoDetail]);

  useEffect(() => {
    // The state update happens after the asynchronous request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    const scan = detail?.scan;
    if (!scan || scan.status !== "running" || esRef.current) return;

    const eventSource = new EventSource(`${API_BASE}/panel/scan/${scan.id}/events`);
    esRef.current = eventSource;

    eventSource.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (event.type === "dep") {
          setDetail((current) =>
            current
              ? {
                  ...current,
                  deps: current.deps.map((dep) =>
                    dep.name === event.name && dep.version === event.version
                      ? { ...dep, verdict: event.verdict, jobState: event.jobState ?? null }
                      : dep,
                  ),
                }
              : current,
          );
        } else if (event.type === "progress") {
          setDetail((current) =>
            current?.scan
              ? {
                  ...current,
                  scan: {
                    ...current.scan,
                    cached: event.cached,
                    audited: event.audited,
                    failed: event.failed,
                    total: event.total,
                  },
                }
              : current,
          );
        } else if (event.type === "done") {
          eventSource.close();
          esRef.current = null;
          void load();
        }
      } catch {
        // Ignore malformed stream events and keep the last valid snapshot.
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      esRef.current = null;
    };

    return () => {
      eventSource.close();
      esRef.current = null;
    };
  }, [detail?.scan?.id, detail?.scan?.status, load]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const dangerous = detail?.deps.filter((dep) => dep.verdict === "DANGEROUS").length ?? 0;
    const suspect = detail?.deps.filter((dep) => dep.verdict === "SUSPECT").length ?? 0;
    const unknown = detail?.deps.filter((dep) => dep.verdict === "UNKNOWN").length ?? 0;
    const safe = detail?.deps.filter((dep) => dep.verdict === "SAFE").length ?? 0;
    const pending = detail?.deps.filter((dep) => dep.verdict === null).length ?? 0;
    const direct = detail?.deps.filter((dep) => dep.direct).length ?? 0;
    return {
      dangerous,
      suspect,
      unknown,
      safe,
      pending,
      direct,
      flagged: dangerous + suspect,
    };
  }, [detail?.deps]);

  const filtered = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return (detail?.deps ?? [])
      .filter((dep) => {
        if (
          normalizedSearch &&
          !`${dep.name}@${dep.version}`.toLowerCase().includes(normalizedSearch)
        ) {
          return false;
        }
        if (filter === "flagged") {
          return dep.verdict === "DANGEROUS" || dep.verdict === "SUSPECT";
        }
        if (filter === "direct") return dep.direct;
        if (filter === "pending") return dep.verdict === null;
        return true;
      })
      .sort((left, right) => {
        const severity = depPriority(left) - depPriority(right);
        if (severity !== 0) return severity;
        if (left.direct !== right.direct) return left.direct ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }, [detail?.deps, filter, search]);

  if (notFound) {
    return (
      <div className="repo-detail-state">
        <Icon name="alert" size={22} />
        <strong>Repository unavailable</strong>
        <p>Check that the NpmGuard GitHub App still has access to this repository.</p>
        <button type="button" onClick={() => navigate("/dashboard")}>
          Back to dashboard
        </button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="repo-detail-state" role="status">
        <span className="dashboard-loading__spinner" />
        <strong>Loading repository posture…</strong>
      </div>
    );
  }

  const { repo, deps, rollup, scan, alerts } = detail;
  const actionError = repoActionErrors[repo.id];
  const running = scan?.status === "running";
  const checked = scan
    ? Math.min(scan.total, scan.cached + scan.audited + scan.failed)
    : deps.length - stats.pending;
  const total = scan?.total ?? deps.length;
  const progressPercentage = total > 0 ? Math.round((checked / total) * 100) : 0;
  const criticalDeps = deps
    .filter((dep) => dep.verdict === "DANGEROUS" || dep.verdict === "SUSPECT")
    .sort((left, right) => depPriority(left) - depPriority(right))
    .slice(0, 4);
  const reviewItems =
    alerts.length > 0
      ? alerts.slice(0, 4).map((alert) => ({
          key: `alert-${alert.id}`,
          name: alert.packageName,
          version: alert.version,
          meta: `${alert.kind} · ${formatDate(alert.createdAt)}`,
          verdict: alert.verdict,
          tone:
            alert.verdict === "DANGEROUS"
              ? ("danger" as const)
              : alert.verdict === "SUSPECT"
                ? ("suspect" as const)
                : alert.verdict === "SAFE"
                  ? ("safe" as const)
                  : ("unknown" as const),
        }))
      : criticalDeps.map((dep) => ({
          key: `${dep.name}@${dep.version}`,
          name: dep.name,
          version: dep.version,
          meta: dep.direct ? "direct" : "transitive",
          verdict: dep.verdict ?? "UNKNOWN",
          tone: depTone(dep),
        }));
  const visibleDeps = filtered.slice(0, visibleCount);

  const overviewTone: Tone = running
    ? "running"
    : scan?.status === "failed" || rollup.verdict === "DANGEROUS"
      ? "danger"
      : rollup.verdict === "SUSPECT"
        ? "suspect"
        : rollup.verdict === "SAFE"
          ? "safe"
          : "unknown";

  const statusLabel = running
    ? "Scan in progress"
    : scan?.status === "failed"
      ? "Scan interrupted"
      : rollup.verdict === "DANGEROUS"
        ? "Action required"
        : rollup.verdict === "SUSPECT"
          ? "Review recommended"
          : rollup.verdict === "SAFE"
            ? "No known threats"
            : "Coverage incomplete";

  const statusCopy = running
    ? `${progressPercentage}% complete · ${scan.cached.toLocaleString()} results reused from cache`
    : scan?.status === "failed"
      ? "The last scan did not complete. Re-sync the lockfile, then run the audit again."
      : scan
        ? `Last ${scan.trigger} scan started ${formatDate(scan.startedAt)}`
        : "Run the first audit to establish a dependency baseline.";

  const metricItems: Array<{ label: string; value: number; tone: Tone }> = [
    { label: "Dangerous", value: stats.dangerous, tone: "danger" },
    { label: "Suspect", value: stats.suspect, tone: "suspect" },
    { label: "Unknown", value: stats.unknown, tone: "unknown" },
    { label: "Safe", value: stats.safe, tone: "safe" },
    { label: "Pending", value: stats.pending, tone: "pending" },
  ];

  const filterItems: Array<{ key: Filter; label: string; count: number }> = [
    { key: "all", label: "All", count: deps.length },
    { key: "flagged", label: "Flagged", count: stats.flagged },
    { key: "direct", label: "Direct", count: stats.direct },
    { key: "pending", label: "Pending", count: stats.pending },
  ];

  async function startAudit() {
    setBusyAction("audit");
    try {
      const scanId = await triggerScan(repo.id);
      if (scanId) await load();
    } finally {
      setBusyAction(null);
    }
  }

  async function toggleProtection() {
    setBusyAction("protect");
    try {
      const updated = await setProtect(repo.id, !repo.protected);
      if (updated) await load();
    } finally {
      setBusyAction(null);
    }
  }

  async function syncLockfile() {
    setBusyAction("resync");
    try {
      await resync(repo.id);
      await load();
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="repo-detail-page">
      <div className="repo-detail-shell">
        <button
          type="button"
          className="repo-detail-back"
          onClick={() => navigate("/dashboard")}
        >
          <Icon name="arrow-left" />
          Dashboard
        </button>

        <header className="repo-detail-header">
          <div className="repo-detail-identity">
            <span className="dashboard-kicker">Repository posture</span>
            <h1>
              <span>{repo.owner}/</span>
              {repo.name}
            </h1>
            <div className="repo-detail-meta">
              <span>
                <Icon name="branch" size={13} />
                {repo.defaultBranch}
              </span>
              {repo.private && <span>Private</span>}
              <span className={repo.protected ? "is-protected" : ""}>
                <Icon name="shield" size={13} />
                {repo.protected ? "Continuous protection" : "Manual monitoring"}
              </span>
            </div>
          </div>

          <div className="repo-detail-actions">
            <button
              type="button"
              className="repo-detail-button repo-detail-button--primary"
              onClick={() => void startAudit()}
              disabled={running || busyAction !== null}
            >
              {running
                ? "Scanning…"
                : busyAction === "audit"
                  ? "Starting…"
                  : scan
                    ? "Run audit again"
                    : "Run first audit"}
            </button>
            <button
              type="button"
              className={`repo-detail-button ${repo.protected ? "repo-detail-button--protected" : ""}`}
              onClick={() => void toggleProtection()}
              disabled={busyAction !== null}
            >
              <Icon name="shield" />
              {busyAction === "protect"
                ? "Updating…"
                : repo.protected
                  ? "Protected"
                  : "Enable protection"}
            </button>
            <button
              type="button"
              className="repo-detail-button repo-detail-button--quiet"
              onClick={() => void syncLockfile()}
              disabled={busyAction !== null}
              title="Re-read the lockfile from GitHub"
            >
              <Icon name="refresh" />
              {busyAction === "resync" ? "Syncing…" : "Re-sync"}
            </button>
          </div>
        </header>

        {actionError && (
          <div className="repo-detail-action-error" role="alert">
            <div>
              <strong>
                {actionError.action === "audit"
                  ? "Audit could not start"
                  : "Protection could not be updated"}
              </strong>
              <p>{actionError.message}</p>
            </div>
            <button type="button" onClick={() => clearRepoActionError(repo.id)}>
              Dismiss
            </button>
          </div>
        )}

        <section className={`repo-overview repo-overview--${overviewTone}`}>
          <div className="repo-overview__summary">
            <div className="repo-overview__status">
              <span className="repo-overview__status-dot" />
              {statusLabel}
              {scan && <span>scan #{scan.id}</span>}
            </div>
            <h2>
              <strong>{checked.toLocaleString()}</strong>
              <span>of {total.toLocaleString()} dependencies checked</span>
            </h2>
            <p>{statusCopy}</p>

            <div
              className="repo-overview__rail"
              role="progressbar"
              aria-label={`${checked} of ${total} dependencies checked`}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={checked}
            >
              {metricItems.map((metric) =>
                metric.value > 0 && deps.length > 0 ? (
                  <span
                    key={metric.label}
                    className={`repo-overview__rail-segment repo-overview__rail-segment--${metric.tone}`}
                    style={{ width: `${(metric.value / deps.length) * 100}%` }}
                  />
                ) : null,
              )}
            </div>
          </div>

          <div className="repo-overview__metrics" aria-label="Dependency verdict summary">
            {metricItems.map((metric) => (
              <div
                key={metric.label}
                className={`repo-overview__metric repo-overview__metric--${metric.tone}`}
              >
                <span>{metric.label}</span>
                <strong>{metric.value.toLocaleString()}</strong>
              </div>
            ))}
          </div>
        </section>

        {stats.flagged > 0 && (
          <section className="repo-review-queue">
            <div className="repo-review-queue__summary">
              <div className="repo-review-queue__icon">
                <Icon name="alert" size={21} />
              </div>
              <div>
                <span className="dashboard-kicker">Review queue</span>
                <h2>
                  {stats.flagged.toLocaleString()} dependenc
                  {stats.flagged === 1 ? "y" : "ies"} need attention
                </h2>
                <p>Flagged packages are sorted to the top of the inventory below.</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setFilter("flagged");
                  setVisibleCount(100);
                  document
                    .querySelector(".repo-inventory")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                Review flagged
              </button>
            </div>

            <div className="repo-review-queue__packages">
              {reviewItems.map((item) => (
                <button
                  type="button"
                  key={item.key}
                  onClick={() => navigate(`/package/${encodeURIComponent(item.name)}`)}
                >
                  <span className={`repo-dep-dot repo-dep-dot--${item.tone}`} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.version} · {item.meta}
                    </small>
                  </span>
                  <b>{item.verdict}</b>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="repo-inventory">
          <header className="repo-inventory__header">
            <div>
              <span className="dashboard-kicker">Dependency inventory</span>
              <h2>Packages in this lockfile</h2>
            </div>
            <span>
              {filtered.length.toLocaleString()} of {deps.length.toLocaleString()}
            </span>
          </header>

          <div className="repo-inventory__toolbar">
            <label className="repo-inventory__search">
              <span className="sr-only">Search dependencies</span>
              <Icon name="search" />
              <input
                type="search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setVisibleCount(100);
                }}
                placeholder="Search package or version"
              />
            </label>
            <div className="repo-inventory__filters" aria-label="Dependency filters">
              {filterItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={filter === item.key ? "is-active" : ""}
                  aria-pressed={filter === item.key}
                  onClick={() => {
                    setFilter(item.key);
                    setVisibleCount(100);
                  }}
                >
                  {item.label}
                  <span>{item.count.toLocaleString()}</span>
                </button>
              ))}
            </div>
          </div>

          {deps.length === 0 ? (
            <div className="repo-inventory__empty">
              <Icon name="search" size={22} />
              <strong>No dependency baseline yet</strong>
              <p>Run an audit to read the repository lockfile.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="repo-inventory__empty">
              <Icon name="search" size={22} />
              <strong>No dependencies match this view</strong>
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setFilter("all");
                  setVisibleCount(100);
                }}
              >
                Reset filters
              </button>
            </div>
          ) : (
            <div className="repo-inventory__table-wrap">
              <table className="repo-inventory__table">
                <thead>
                  <tr>
                    <th>Package</th>
                    <th>Version</th>
                    <th>Relationship</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDeps.map((dep) => {
                    const tone = depTone(dep);
                    return (
                      <tr key={`${dep.name}@${dep.version}`} className={`repo-dep-row--${tone}`}>
                        <td>
                          <span className={`repo-dep-dot repo-dep-dot--${tone}`} />
                          {dep.verdict ? (
                            <button
                              type="button"
                              onClick={() => navigate(`/package/${encodeURIComponent(dep.name)}`)}
                            >
                              {dep.name}
                            </button>
                          ) : (
                            <span>{dep.name}</span>
                          )}
                          {dep.range && <small>{dep.range}</small>}
                        </td>
                        <td>
                          <code>{dep.version}</code>
                        </td>
                        <td>
                          <span className="repo-dep-relationship">
                            {dep.direct ? "Direct" : "Transitive"}
                          </span>
                        </td>
                        <td>
                          <span className={`repo-dep-verdict repo-dep-verdict--${tone}`}>
                            {tone === "running" && <i />}
                            {depStatus(dep)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {visibleDeps.length < filtered.length && (
                <div className="repo-inventory__load-more">
                  <span>
                    Showing {visibleDeps.length.toLocaleString()} of{" "}
                    {filtered.length.toLocaleString()} packages
                  </span>
                  <button
                    type="button"
                    onClick={() => setVisibleCount((count) => count + 100)}
                  >
                    Load 100 more
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
