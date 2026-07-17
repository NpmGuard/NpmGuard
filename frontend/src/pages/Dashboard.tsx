import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { usePanelStore } from "../stores/panelStore";
import type { RepoSummary } from "../lib/panel-types";

const API_BASE = "/api";

type RepoFilter = "all" | "protected" | "unscanned" | "attention";
type IconName =
  | "alert"
  | "arrow"
  | "github"
  | "plus"
  | "refresh"
  | "repo"
  | "scan"
  | "search"
  | "shield";

interface IconProps {
  name: IconName;
  size?: number;
}

function Icon({ name, size = 16 }: IconProps) {
  const paths: Record<IconName, React.ReactNode> = {
    alert: (
      <>
        <path d="M12 3 2.8 19a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    github: (
      <>
        <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.3 4 5 5 0 0 0 19.1.5S18 0 15 1.8a13.4 13.4 0 0 0-7 0C5 0 3.9.5 3.9.5A5 5 0 0 0 3.7 4a5.4 5.4 0 0 0-1.5 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 8 18v4" />
        <path d="M8 19c-3 .9-3-1.5-4-2" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 11a8.1 8.1 0 1 0 2 5.3" />
        <path d="M20 4v7h-7" />
      </>
    ),
    repo: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      </>
    ),
    scan: (
      <>
        <path d="M3 7V5a2 2 0 0 1 2-2h2" />
        <path d="M17 3h2a2 2 0 0 1 2 2v2" />
        <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
        <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
        <path d="M7 12h10" />
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

function formatScanDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  }).format(date);
}

function repoNeedsAttention(repo: RepoSummary): boolean {
  return (
    repo.lastScan?.status === "failed" ||
    repo.lastScan?.verdict === "DANGEROUS" ||
    repo.lastScan?.verdict === "SUSPECT"
  );
}

function scanTone(repo: RepoSummary): string {
  if (!repo.lastScan) return "unknown";
  if (repo.lastScan.status === "running") return "running";
  if (repo.lastScan.status === "failed") return "danger";
  if (repo.lastScan.verdict === "DANGEROUS") return "danger";
  if (repo.lastScan.verdict === "SUSPECT") return "warning";
  if (repo.lastScan.verdict === "SAFE") return "safe";
  return "unknown";
}

function ScanStatus({ repo }: { repo: RepoSummary }) {
  const scan = repo.lastScan;
  const tone = scanTone(repo);

  if (!scan) {
    return (
      <div className="repo-scan-status">
        <span className={`repo-status-pill repo-status-pill--${tone}`}>Not audited</span>
        <p>No dependency baseline yet.</p>
      </div>
    );
  }

  if (scan.status === "running") {
    const completed = scan.cached + scan.audited + scan.failed;
    const percentage = scan.total > 0 ? Math.min(100, (completed / scan.total) * 100) : 0;
    return (
      <div className="repo-scan-status">
        <div className="repo-scan-status__line">
          <span className={`repo-status-pill repo-status-pill--${tone}`}>
            <span className="repo-running-dot" />
            Scanning
          </span>
          <span className="repo-scan-count">
            {completed}/{scan.total}
          </span>
        </div>
        <div
          className="repo-scan-progress"
          role="progressbar"
          aria-label={`Scanning ${repo.fullName}`}
          aria-valuemin={0}
          aria-valuemax={scan.total}
          aria-valuenow={completed}
        >
          <span style={{ width: `${percentage}%` }} />
        </div>
      </div>
    );
  }

  if (scan.status === "failed") {
    return (
      <div className="repo-scan-status">
        <span className={`repo-status-pill repo-status-pill--${tone}`}>Scan failed</span>
        <p>Open the repository to inspect the failure.</p>
      </div>
    );
  }

  return (
    <div className="repo-scan-status">
      <span className={`repo-status-pill repo-status-pill--${tone}`}>
        {scan.verdict ?? "Completed"}
      </span>
      <p>
        {scan.total.toLocaleString()} dependencies · {formatScanDate(scan.startedAt)}
      </p>
    </div>
  );
}

export function Dashboard() {
  const navigate = useNavigate();
  const {
    user,
    userLoaded,
    installations,
    installUrl,
    repos,
    alerts,
    loading,
    error,
    repoActionErrors,
    capError,
    fetchMe,
    refresh,
    triggerScan,
    setProtect,
    markAlertsSeen,
    clearRepoActionError,
  } = usePanelStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RepoFilter>("all");
  const [busyRepo, setBusyRepo] = useState<{
    id: number;
    action: "audit" | "protect";
  } | null>(null);

  useEffect(() => {
    if (!userLoaded) void fetchMe();
  }, [userLoaded, fetchMe]);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  const stats = useMemo(() => {
    const protectedCount = repos.filter((repo) => repo.protected).length;
    const unscanned = repos.filter((repo) => !repo.lastScan).length;
    const scanning = repos.filter((repo) => repo.lastScan?.status === "running").length;
    const safe = repos.filter(
      (repo) => repo.lastScan?.status === "done" && repo.lastScan.verdict === "SAFE",
    ).length;
    const attention = repos.filter(repoNeedsAttention).length;
    const unknown = Math.max(0, repos.length - attention - scanning - safe);
    const audited = repos.length - unscanned;
    return { protectedCount, unscanned, scanning, safe, attention, unknown, audited };
  }, [repos]);

  const filteredRepos = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return repos.filter((repo) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        repo.fullName.toLowerCase().includes(normalizedQuery) ||
        repo.defaultBranch.toLowerCase().includes(normalizedQuery);

      const matchesFilter =
        filter === "all" ||
        (filter === "protected" && repo.protected) ||
        (filter === "unscanned" && !repo.lastScan) ||
        (filter === "attention" && repoNeedsAttention(repo));

      return matchesQuery && matchesFilter;
    });
  }, [filter, query, repos]);

  if (!userLoaded) {
    return (
      <div className="dashboard-loading" role="status">
        <span className="dashboard-loading__spinner" />
        Loading GitHub workspace…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="dashboard-login-page">
        <div className="dashboard-login-card">
          <div className="dashboard-login-card__icon">
            <Icon name="shield" size={24} />
          </div>
          <span className="dashboard-kicker">Repository protection</span>
          <h1>Connect your GitHub workspace</h1>
          <p>
            Audit every npm dependency in a repository, then keep watch for
            poisoned versions published upstream.
          </p>
          <a href={`${API_BASE}/auth/github/login`} className="dashboard-button dashboard-button--primary">
            <Icon name="github" />
            Sign in with GitHub
          </a>
        </div>
      </div>
    );
  }

  const unseenAlerts = alerts.filter((alert) => !alert.seen);
  const portfolioSegments = [
    { key: "attention", count: stats.attention, className: "danger" },
    { key: "scanning", count: stats.scanning, className: "running" },
    { key: "safe", count: stats.safe, className: "safe" },
    {
      key: "unknown",
      count: stats.unknown,
      className: "unknown",
    },
  ];
  const filterOptions: Array<{ key: RepoFilter; label: string; count: number }> = [
    { key: "all", label: "All", count: repos.length },
    { key: "protected", label: "Protected", count: stats.protectedCount },
    { key: "unscanned", label: "Not audited", count: stats.unscanned },
    { key: "attention", label: "Attention", count: stats.attention },
  ];

  async function startAudit(repo: RepoSummary) {
    setBusyRepo({ id: repo.id, action: "audit" });
    try {
      const scanId = await triggerScan(repo.id);
      if (scanId) navigate(`/repo/${repo.owner}/${repo.name}`);
    } finally {
      setBusyRepo(null);
    }
  }

  async function toggleProtect(repo: RepoSummary) {
    setBusyRepo({ id: repo.id, action: "protect" });
    try {
      await setProtect(repo.id, !repo.protected);
    } finally {
      setBusyRepo(null);
    }
  }

  return (
    <div className="dashboard-page">
      <div className="dashboard-shell">
        <header className="dashboard-hero">
          <div>
            <span className="dashboard-kicker">GitHub security workspace</span>
            <h1>Repository posture</h1>
            <p>
              Audit dependency snapshots, then keep critical repositories under
              continuous watch.
            </p>
          </div>
          <div className="dashboard-hero__actions">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="dashboard-button dashboard-button--secondary"
            >
              <Icon name="refresh" />
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            {installUrl && (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                className="dashboard-button dashboard-button--primary"
              >
                <Icon name="plus" />
                Add repositories
              </a>
            )}
          </div>
        </header>

        {repos.length > 0 && (
          <section className="portfolio-posture" aria-labelledby="portfolio-title">
            <div className="portfolio-posture__top">
              <div>
                <span className="dashboard-kicker" id="portfolio-title">
                  Portfolio coverage
                </span>
                <strong>
                  {stats.protectedCount} of {repos.length} repositories protected
                </strong>
              </div>
              <span className="portfolio-posture__percent">
                {Math.round((stats.protectedCount / repos.length) * 100)}%
              </span>
            </div>

            <div
              className="portfolio-rail"
              role="img"
              aria-label={`${stats.safe} safe, ${stats.attention} need attention, ${stats.scanning} scanning, ${stats.unknown} unknown or not audited`}
            >
              {portfolioSegments.map((segment) =>
                segment.count > 0 ? (
                  <span
                    key={segment.key}
                    className={`portfolio-rail__segment portfolio-rail__segment--${segment.className}`}
                    style={{ width: `${(segment.count / repos.length) * 100}%` }}
                  />
                ) : null,
              )}
            </div>

            <div className="portfolio-posture__legend">
              <span>
                <i className="portfolio-dot portfolio-dot--safe" />
                {stats.safe} safe
              </span>
              <span>
                <i className="portfolio-dot portfolio-dot--danger" />
                {stats.attention} attention
              </span>
              <span>
                <i className="portfolio-dot portfolio-dot--running" />
                {stats.scanning} scanning
              </span>
              <span>
                <i className="portfolio-dot portfolio-dot--unknown" />
                {stats.unknown} unknown
              </span>
              <span className="portfolio-posture__meta">
                {installations.length} connected account
                {installations.length === 1 ? "" : "s"} · {stats.audited} audited
              </span>
            </div>
          </section>
        )}

        {capError && (
          <div className="dashboard-notice dashboard-notice--warning" role="alert">
            <Icon name="alert" />
            <div>
              <strong>Beta limit reached</strong>
              <p>
                {capError}. Contact{" "}
                <a href="mailto:hello@npmguard.com">hello@npmguard.com</a> to
                increase your allowance.
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="dashboard-notice dashboard-notice--danger" role="alert">
            <Icon name="alert" />
            <div>
              <strong>Workspace could not be refreshed</strong>
              <p>{error}</p>
            </div>
          </div>
        )}

        {unseenAlerts.length > 0 && (
          <div className="dashboard-notice dashboard-notice--danger" role="alert">
            <Icon name="alert" />
            <div>
              <strong>
                {unseenAlerts.length} security alert
                {unseenAlerts.length === 1 ? "" : "s"}
              </strong>
              <p>
                {unseenAlerts
                  .slice(0, 3)
                  .map((alert) => `${alert.packageName}@${alert.version} is ${alert.verdict}`)
                  .join(" · ")}
                {unseenAlerts.length > 3 ? " · …" : ""}
              </p>
            </div>
            <button type="button" onClick={() => void markAlertsSeen()}>
              Mark as seen
            </button>
          </div>
        )}

        {installations.length === 0 && !loading ? (
          <section className="dashboard-empty">
            <div className="dashboard-empty__icon">
              <Icon name="github" size={26} />
            </div>
            <span className="dashboard-kicker">No repositories connected</span>
            <h2>Install NpmGuard on a GitHub account</h2>
            <p>
              Choose the repositories NpmGuard can audit. Access stays limited
              to dependency files and security checks.
            </p>
            {installUrl && (
              <a
                href={installUrl}
                target="_blank"
                rel="noreferrer"
                className="dashboard-button dashboard-button--primary"
              >
                <Icon name="plus" />
                Install GitHub App
              </a>
            )}
          </section>
        ) : (
          <>
            <div className="repo-toolbar">
              <label className="repo-search">
                <span className="sr-only">Search repositories</span>
                <Icon name="search" />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search repositories"
                />
              </label>
              <div className="repo-filters" aria-label="Repository filters">
                {filterOptions.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    className={filter === option.key ? "is-active" : ""}
                    aria-pressed={filter === option.key}
                    onClick={() => setFilter(option.key)}
                  >
                    {option.label}
                    <span>{option.count}</span>
                  </button>
                ))}
              </div>
              <span className="repo-results-count">
                {filteredRepos.length} result{filteredRepos.length === 1 ? "" : "s"}
              </span>
            </div>

            {filteredRepos.length > 0 ? (
              <div className="repo-grid">
                {filteredRepos.map((repo) => {
                  const actionError = repoActionErrors[repo.id];
                  const tone = actionError ? "warning" : scanTone(repo);
                  const auditBusy = busyRepo?.id === repo.id && busyRepo.action === "audit";
                  const protectBusy =
                    busyRepo?.id === repo.id && busyRepo.action === "protect";
                  const scanRunning = repo.lastScan?.status === "running";

                  return (
                    <article
                      key={repo.id}
                      className={`repo-card repo-card--${tone}`}
                      style={{ "--repo-status-color": `var(--repo-${tone})` } as React.CSSProperties}
                    >
                      <div className="repo-card__head">
                        <div className="repo-card__identity">
                          <div className="repo-card__icon">
                            <Icon name="repo" />
                          </div>
                          <div>
                            <span>{repo.owner}</span>
                            <button
                              type="button"
                              onClick={() => navigate(`/repo/${repo.owner}/${repo.name}`)}
                            >
                              {repo.name}
                            </button>
                          </div>
                        </div>
                        <div className="repo-card__badges">
                          {repo.private && <span>Private</span>}
                          {repo.protected && (
                            <span className="repo-card__protected">
                              <Icon name="shield" size={12} />
                              Protected
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="repo-card__body">
                        <ScanStatus repo={repo} />
                        {actionError && (
                          <div className="repo-card__action-error" role="alert">
                            <Icon name="alert" size={15} />
                            <div>
                              <strong>
                                {actionError.action === "audit"
                                  ? "Audit could not start"
                                  : "Protection could not be updated"}
                              </strong>
                              <p>{actionError.message}</p>
                            </div>
                            <button
                              type="button"
                              onClick={() => clearRepoActionError(repo.id)}
                              aria-label={`Dismiss error for ${repo.fullName}`}
                            >
                              Dismiss
                            </button>
                          </div>
                        )}
                        <dl className="repo-card__metadata">
                          <div>
                            <dt>Default branch</dt>
                            <dd>{repo.defaultBranch}</dd>
                          </div>
                          <div>
                            <dt>Monitoring</dt>
                            <dd>{repo.protected ? "Continuous" : "Manual only"}</dd>
                          </div>
                        </dl>
                      </div>

                      <footer className="repo-card__actions">
                        <button
                          type="button"
                          onClick={() => void startAudit(repo)}
                          disabled={scanRunning || busyRepo !== null}
                          className="repo-action repo-action--audit"
                        >
                          <Icon name="scan" />
                          {auditBusy ? "Starting…" : scanRunning ? "Scanning…" : "Run audit"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void toggleProtect(repo)}
                          disabled={busyRepo !== null}
                          className={`repo-action ${
                            repo.protected ? "repo-action--protected" : "repo-action--protect"
                          }`}
                        >
                          <Icon name="shield" />
                          {protectBusy
                            ? repo.protected
                              ? "Disabling…"
                              : "Enabling…"
                            : repo.protected
                              ? "Protected"
                              : "Enable Protect"}
                        </button>
                        <button
                          type="button"
                          onClick={() => navigate(`/repo/${repo.owner}/${repo.name}`)}
                          className="repo-action repo-action--details"
                          aria-label={`Open ${repo.fullName} details`}
                        >
                          <Icon name="arrow" />
                        </button>
                      </footer>
                    </article>
                  );
                })}
              </div>
            ) : repos.length === 0 ? (
              <div className="repo-no-results">
                <Icon name={error ? "alert" : loading ? "refresh" : "repo"} size={22} />
                <strong>
                  {error
                    ? "Repository list unavailable"
                    : loading
                      ? "Checking repository lockfiles…"
                      : "No auditable repositories found"}
                </strong>
                <p>
                  {error
                    ? "Retry the refresh once the connection issue above is resolved."
                    : loading
                      ? "NpmGuard is checking the repositories available to this GitHub installation."
                      : "Only repositories with package-lock.json, pnpm-lock.yaml, or yarn.lock at the repository root are shown."}
                </p>
                {!loading && (
                  <button type="button" onClick={() => void refresh()}>
                    Check again
                  </button>
                )}
              </div>
            ) : (
              <div className="repo-no-results">
                <Icon name="search" size={22} />
                <strong>No repositories match this view</strong>
                <p>Try another search or reset the filters.</p>
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                >
                  Reset filters
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
