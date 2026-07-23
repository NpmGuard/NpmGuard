import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { usePanelStore } from "../stores/panelStore";
import type {
  BillingAccount,
  BillingPayload,
  PaywallReason,
  PublicRepoScanDetailPayload,
  PublicRepoScanSummary,
  RepoSummary,
  UsageAllowance,
} from "../lib/panel-types";

const API_BASE = "/api";

type RepoFilter = "all" | "protected" | "unscanned" | "attention";
type IconName =
  | "alert"
  | "arrow"
  | "billing"
  | "close"
  | "github"
  | "lock"
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
    billing: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 10h18" />
        <path d="M7 15h3" />
      </>
    ),
    close: (
      <>
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </>
    ),
    github: (
      <>
        <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.3 4 5 5 0 0 0 19.1.5S18 0 15 1.8a13.4 13.4 0 0 0-7 0C5 0 3.9.5 3.9.5A5 5 0 0 0 3.7 4a5.4 5.4 0 0 0-1.5 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 8 18v4" />
        <path d="M8 19c-3 .9-3-1.5-4-2" />
      </>
    ),
    lock: (
      <>
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
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

function formatLimit(value: number, singular: string, plural: string): string {
  if (value === 0) return `Unlimited ${plural}`;
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function formatPrice(billing: BillingPayload | null): string | null {
  const price = billing?.price;
  if (!price || price.amount === null) return null;
  const amount = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: price.currency.toUpperCase(),
    maximumFractionDigits: price.amount % 100 === 0 ? 0 : 2,
  }).format(price.amount / 100);
  return price.interval ? `${amount}/${price.interval}` : amount;
}

function AllowanceMeter({
  label,
  allowance,
}: {
  label: string;
  allowance: UsageAllowance;
}) {
  const unlimited = allowance.limit === 0;
  const percentage = unlimited
    ? 0
    : Math.min(100, Math.round((allowance.used / Math.max(1, allowance.limit)) * 100));
  return (
    <div className="plan-meter">
      <div className="plan-meter__label">
        <span>{label}</span>
        <strong>
          {allowance.used.toLocaleString()} / {unlimited ? "∞" : allowance.limit.toLocaleString()}
        </strong>
      </div>
      <div
        className="plan-meter__rail"
        role="progressbar"
        aria-label={`${label}: ${allowance.used} used${unlimited ? "" : ` of ${allowance.limit}`}`}
        aria-valuemin={0}
        aria-valuemax={unlimited ? Math.max(allowance.used, 1) : allowance.limit}
        aria-valuenow={allowance.used}
      >
        <span style={{ width: unlimited ? "12%" : `${percentage}%` }} />
      </div>
    </div>
  );
}

function PlanLedger({
  billing,
  busyInstallationId,
  onUpgrade,
  onManage,
}: {
  billing: BillingPayload;
  busyInstallationId: number | null;
  onUpgrade: (installationId: number) => void;
  onManage: (installationId: number) => void;
}) {
  if (billing.accounts.length === 0) return null;
  return (
    <section className="plan-ledger" aria-labelledby="plan-ledger-title">
      <div className="plan-ledger__intro">
        <span className="dashboard-kicker" id="plan-ledger-title">
          Plan allowance
        </span>
        <p>Re-auditing the same public repository never consumes another slot.</p>
      </div>
      <div className="plan-ledger__accounts">
        {billing.accounts.map((account) => {
          const busy = busyInstallationId === account.installationId;
          return (
            <article className="plan-account" key={account.installationId}>
              <div className="plan-account__identity">
                <div>
                  <strong>{account.accountLogin}</strong>
                  <span>GitHub account</span>
                </div>
                <span className={`plan-account__badge plan-account__badge--${account.plan}`}>
                  {account.plan}
                </span>
              </div>
              <div className="plan-account__meters">
                <AllowanceMeter label="Protected repositories" allowance={account.protectedRepos} />
                <AllowanceMeter
                  label="Public repository audits"
                  allowance={account.publicRepoAudits}
                />
              </div>
              <button
                type="button"
                className="plan-account__action"
                disabled={busy || (account.plan === "free" && !billing.checkoutEnabled)}
                onClick={() =>
                  account.plan === "pro"
                    ? onManage(account.installationId)
                    : onUpgrade(account.installationId)
                }
              >
                <Icon name="billing" size={15} />
                {busy
                  ? "Opening…"
                  : account.plan === "pro"
                    ? "Manage billing"
                    : billing.checkoutEnabled
                      ? "Upgrade to Pro"
                      : "Pro coming soon"}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function publicScanTone(scan: PublicRepoScanSummary): "safe" | "danger" | "warning" | "running" | "unknown" {
  if (scan.status === "running") return "running";
  if (scan.rollup.verdict === "DANGEROUS") return "danger";
  if (scan.rollup.verdict === "SUSPECT") return "warning";
  if (scan.rollup.verdict === "SAFE") return "safe";
  return "unknown";
}

function PublicAuditHistory({
  scans,
  onOpen,
}: {
  scans: PublicRepoScanSummary[];
  onOpen: (scanId: number) => void;
}) {
  if (scans.length === 0) return null;

  return (
    <section className="public-audit-ledger" aria-labelledby="public-audits-title">
      <header className="public-audit-ledger__head">
        <div>
          <span className="dashboard-kicker">Read-only inspections</span>
          <h2 id="public-audits-title">Public repository snapshots</h2>
        </div>
        <span className="public-audit-ledger__boundary">No target installation</span>
      </header>

      <div className="public-audit-ledger__rows">
        {scans.slice(0, 6).map((scan) => {
          const tone = publicScanTone(scan);
          const completed = scan.cached + scan.audited + scan.failed;
          const percentage = scan.total > 0 ? Math.min(100, (completed / scan.total) * 100) : 100;
          const label =
            scan.status === "running"
              ? "Scanning"
              : scan.rollup.verdict ?? (scan.total === 0 ? "No dependencies" : "Unknown");

          return (
            <article
              key={scan.id}
              className={`public-audit-row public-audit-row--${tone}`}
              style={{ "--public-audit-tone": `var(--repo-${tone})` } as React.CSSProperties}
            >
              <div className="public-audit-row__identity">
                <span>{scan.owner}</span>
                <button
                  type="button"
                  onClick={() => onOpen(scan.id)}
                  aria-label={`Open audit progress for ${scan.fullName}`}
                >
                  {scan.name}
                  <Icon name="arrow" size={14} />
                </button>
                <small>
                  {scan.lockfilePath} · {scan.defaultBranch}
                </small>
              </div>

              <div className="public-audit-row__scope" aria-label="Audit boundaries">
                <span>PUBLIC</span>
                <span>SNAPSHOT</span>
                <span>NO WRITE</span>
              </div>

              <div className="public-audit-row__result">
                <span className={`repo-status-pill repo-status-pill--${tone}`}>
                  {scan.status === "running" && <span className="repo-running-dot" />}
                  {label}
                </span>
                {scan.status === "running" ? (
                  <div
                    className="public-audit-row__progress"
                    role="progressbar"
                    aria-label={`Auditing ${scan.fullName}`}
                    aria-valuemin={0}
                    aria-valuemax={scan.total}
                    aria-valuenow={completed}
                  >
                    <span style={{ width: `${percentage}%` }} />
                  </div>
                ) : (
                  <small>{formatScanDate(scan.startedAt)}</small>
                )}
              </div>

              <dl className="public-audit-row__counts">
                <div>
                  <dt>Packages</dt>
                  <dd>{scan.total.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Cache</dt>
                  <dd>{scan.cached.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Unresolved</dt>
                  <dd>{scan.failed.toLocaleString()}</dd>
                </div>
              </dl>

              <button
                type="button"
                className="public-audit-row__open"
                onClick={() => onOpen(scan.id)}
                aria-label={`Open audit report for ${scan.fullName}`}
              >
                {scan.status === "running" ? "View progress" : "Report"}
                <Icon name="arrow" size={14} />
              </button>

              <span className="public-audit-row__account">Allowance · {scan.accountLogin}</span>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PublicAuditReportDialog({
  scanId,
  onClose,
  fetchDetail,
}: {
  scanId: number;
  onClose: () => void;
  fetchDetail: (scanId: number) => Promise<PublicRepoScanDetailPayload | null>;
}) {
  const [detail, setDetail] = useState<PublicRepoScanDetailPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | undefined;

    const loadDetail = async () => {
      const payload = await fetchDetail(scanId);
      if (cancelled) return;
      setDetail(payload);
      setFailed(!payload);

      if (payload?.scan.status === "running") {
        refreshTimer = window.setTimeout(() => {
          void loadDetail();
        }, 2_500);
      }
    };

    void loadDetail();

    return () => {
      cancelled = true;
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
    };
  }, [fetchDetail, scanId]);

  const scan = detail?.scan;
  const tone = scan ? publicScanTone(scan) : "unknown";

  return (
    <div className="public-report-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="public-report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-report-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="public-report-dialog__close"
          onClick={onClose}
          aria-label="Close public audit report"
        >
          <Icon name="close" size={18} />
        </button>

        {!detail && !failed && (
          <div className="public-report-dialog__loading" role="status">
            <span className="dashboard-loading__spinner" />
            Loading inspection record…
          </div>
        )}

        {failed && (
          <div className="public-report-dialog__loading" role="alert">
            <Icon name="alert" size={22} />
            This inspection record could not be loaded.
          </div>
        )}

        {detail && scan && (
          <>
            <header className="public-report-dialog__head">
              <div>
                <span className="dashboard-kicker">Public snapshot #{scan.id}</span>
                <h2 id="public-report-title">{scan.fullName}</h2>
                <p>
                  {scan.lockfilePath} · {scan.defaultBranch} · {formatScanDate(scan.startedAt)}
                </p>
              </div>
              <div className="public-report-dialog__head-status">
                <span className={`repo-status-pill repo-status-pill--${tone}`}>
                  {scan.status === "running" && <span className="repo-running-dot" />}
                  {scan.status === "running" ? "Scanning" : scan.rollup.verdict ?? "No dependencies"}
                </span>
                <a href={scan.htmlUrl} target="_blank" rel="noreferrer">
                  Open on GitHub <Icon name="arrow" size={14} />
                </a>
              </div>
            </header>

            <div className="public-report-dialog__boundary">
              <span><Icon name="search" size={14} /> Read-only snapshot</span>
              <span>No Protect</span>
              <span>No webhook</span>
              <span>No GitHub Check</span>
            </div>

            <dl className="public-report-dialog__summary">
              <div><dt>Packages</dt><dd>{scan.total.toLocaleString()}</dd></div>
              <div><dt>Dangerous</dt><dd className="is-danger">{scan.rollup.dangerous}</dd></div>
              <div><dt>Suspect</dt><dd className="is-warning">{scan.rollup.suspect}</dd></div>
              <div><dt>Unknown</dt><dd>{scan.rollup.unknown}</dd></div>
              <div><dt>Safe</dt><dd className="is-safe">{scan.rollup.safe}</dd></div>
              <div><dt>Cached</dt><dd>{scan.cached}</dd></div>
            </dl>

            <div className="public-report-dialog__table-wrap">
              {detail.dependenciesTruncated && (
                <div className="public-report-dialog__truncated">
                  Showing the 500 highest-priority dependencies. Dangerous, suspect, unknown, and
                  direct dependencies are listed first.
                </div>
              )}
              <table className="public-report-dialog__table">
                <thead>
                  <tr>
                    <th>Dependency</th>
                    <th>Source</th>
                    <th>Verdict</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.dependencies.map((dependency) => {
                    const verdict = dependency.verdict ?? (dependency.active ? "QUEUED" : "UNRESOLVED");
                    const depTone =
                      verdict === "DANGEROUS"
                        ? "danger"
                        : verdict === "SUSPECT"
                          ? "warning"
                          : verdict === "SAFE"
                            ? "safe"
                            : dependency.active
                              ? "running"
                              : "unknown";
                    return (
                      <tr key={`${dependency.name}@${dependency.version}`}>
                        <td>
                          <strong>{dependency.name}</strong>
                          <span>@{dependency.version}</span>
                        </td>
                        <td>
                          {dependency.direct ? "Direct" : "Transitive"}
                          {dependency.cached ? <small>Cached verdict</small> : null}
                        </td>
                        <td>
                          <span className={`repo-status-pill repo-status-pill--${depTone}`}>
                            {dependency.active && <span className="repo-running-dot" />}
                            {verdict}
                          </span>
                        </td>
                        <td>{dependency.reason || (dependency.active ? "Audit in progress" : "No reproducible verdict")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {detail.dependencies.length === 0 && (
                <div className="public-report-dialog__empty">No npm dependencies in this lockfile.</div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function PublicAuditDialog({
  accounts,
  busy,
  error,
  onClose,
  onStart,
}: {
  accounts: BillingAccount[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onStart: (repository: string, installationId: number) => Promise<number | null>;
}) {
  const [repository, setRepository] = useState("");
  const [installationId, setInstallationId] = useState(accounts[0]?.installationId ?? 0);
  const selected = accounts.find((account) => account.installationId === installationId);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!repository.trim() || !installationId) return;
    const scanId = await onStart(repository.trim(), installationId);
    if (scanId) onClose();
  }

  return (
    <div className="public-audit-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="public-audit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-audit-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="public-audit-dialog__close"
          onClick={onClose}
          aria-label="Close public repository audit"
        >
          <Icon name="close" size={18} />
        </button>

        <div className="public-audit-dialog__intro">
          <span className="dashboard-kicker">Read-only audit</span>
          <div className="public-audit-dialog__mark">
            <Icon name="search" size={23} />
          </div>
          <h2 id="public-audit-dialog-title">Inspect a public repository</h2>
          <p>
            Paste any public GitHub repository. NpmGuard reads the root lockfile on its default
            branch and creates a one-time dependency snapshot.
          </p>
          <div className="public-audit-dialog__boundaries" aria-label="Read-only boundaries">
            <span><b>01</b> Public contents only</span>
            <span><b>02</b> No install on target</span>
            <span><b>03</b> No checks or webhooks</span>
          </div>
        </div>

        <form className="public-audit-dialog__form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>GitHub repository</span>
            <div className="public-audit-dialog__url">
              <Icon name="github" size={18} />
              <input
                type="text"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="github.com/owner/repository"
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <small>Accepted: owner/repo or a github.com URL</small>
          </label>

          <label>
            <span>Use repository allowance from</span>
            <select
              value={installationId}
              onChange={(event) => setInstallationId(Number(event.target.value))}
            >
              {accounts.map((account) => (
                <option key={account.installationId} value={account.installationId}>
                  {account.accountLogin} · {account.plan.toUpperCase()}
                </option>
              ))}
            </select>
            {selected && (
              <small>
                {selected.publicRepoAudits.remaining === null
                  ? "Unlimited public repository audits."
                  : selected.publicRepoAudits.remaining === 0
                    ? "Free repository allowance used. Existing repositories can still be re-audited."
                    : `${selected.publicRepoAudits.remaining.toLocaleString()} new public ${
                        selected.publicRepoAudits.remaining === 1 ? "repository" : "repositories"
                      } left. Re-audits are free.`}
              </small>
            )}
          </label>

          {error && (
            <div className="public-audit-dialog__error" role="alert">
              <Icon name="alert" size={15} />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            className="dashboard-button dashboard-button--primary public-audit-dialog__submit"
            disabled={busy || !repository.trim() || !installationId}
          >
            <Icon name="scan" />
            {busy ? "Reading public snapshot…" : "Audit snapshot"}
          </button>
          <p className="public-audit-dialog__footnote">
            Manual result only · findings never write to the target repository
          </p>
        </form>
      </section>
    </div>
  );
}

function UpgradeDialog({
  reason,
  billing,
  busy,
  onClose,
  onUpgrade,
}: {
  reason: PaywallReason;
  billing: BillingPayload | null;
  busy: boolean;
  onClose: () => void;
  onUpgrade: () => void;
}) {
  const pro = billing?.plans.pro;
  const price = formatPrice(billing);
  const resourceCopy =
    reason.resource === "protected_repos"
      ? "Your protected repository allowance is full. Existing repositories stay protected."
      : reason.resource === "public_repo_audits"
        ? "Free includes two distinct public repositories. Re-auditing one you already scanned remains free."
        : "This protected repository needs more new package audits than remain in this month's allowance.";
  const usageLabel =
    reason.resource === "protected_repos"
      ? "Protected repositories"
      : reason.resource === "public_repo_audits"
        ? "Public repository audits"
        : "New package audits this month";
  const usageAllowance =
    reason.resource === "protected_repos"
      ? reason.entitlements.protectedRepos
      : reason.resource === "public_repo_audits"
        ? reason.entitlements.publicRepoAudits
        : reason.entitlements.monthlyAudits;

  return (
    <div className="paywall-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="paywall-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paywall-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="paywall-dialog__close" type="button" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>

        <div className="paywall-dialog__boundary">
          <span className="dashboard-kicker">Free allowance reached</span>
          <div className="paywall-dialog__lock">
            <Icon name="lock" size={22} />
          </div>
          <h2 id="paywall-title">
            {reason.resource === "public_repo_audits"
              ? `Audit more repositories with ${reason.entitlements.accountLogin}`
              : `Keep ${reason.entitlements.accountLogin} under watch`}
          </h2>
          <p>{resourceCopy}</p>
          <div className="paywall-dialog__usage">
            <AllowanceMeter label={usageLabel} allowance={usageAllowance} />
          </div>
        </div>

        <div className="paywall-dialog__offer">
          <div className="paywall-dialog__offer-head">
            <span>Pro</span>
            {price && <strong>{price}</strong>}
          </div>
          <ul>
            <li>{pro ? formatLimit(pro.protectedRepos, "protected repository", "protected repositories") : "More protected repositories"}</li>
            <li>{pro ? formatLimit(pro.publicRepoAudits, "public repository audit", "public repository audits") : "More public repository audits"}</li>
            <li>All dependencies included in each public repository audit</li>
            <li>Unlimited cached verdicts</li>
            <li>SUSPECT and UNKNOWN findings remain non-blocking</li>
          </ul>
          <button
            className="dashboard-button dashboard-button--primary paywall-dialog__upgrade"
            type="button"
            onClick={onUpgrade}
            disabled={busy || !billing?.checkoutEnabled}
          >
            <Icon name="billing" size={16} />
            {busy ? "Opening secure checkout…" : billing?.checkoutEnabled ? "Continue to Stripe" : "Checkout unavailable"}
          </button>
          <button className="paywall-dialog__later" type="button" onClick={onClose}>
            Not now
          </button>
          <small>Stripe manages payment details. NpmGuard never stores card data.</small>
        </div>
      </section>
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
    billing,
    billingBusyInstallationId,
    billingError,
    publicScans,
    publicScanBusy,
    publicScanError,
    loading,
    error,
    repoActionErrors,
    paywall,
    fetchMe,
    refresh,
    refreshBilling,
    refreshPublicScans,
    startPublicRepoScan,
    fetchPublicRepoScanDetail,
    startProCheckout,
    openBillingPortal,
    triggerScan,
    setProtect,
    markAlertsSeen,
    clearRepoActionError,
    closePaywall,
    clearPublicScanError,
  } = usePanelStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RepoFilter>("all");
  const [publicAuditOpen, setPublicAuditOpen] = useState(false);
  const [publicReportScanId, setPublicReportScanId] = useState<number | null>(null);
  const [busyRepo, setBusyRepo] = useState<{
    id: number;
    action: "audit" | "protect";
  } | null>(null);
  const [billingReturn] = useState<"success" | "cancelled" | null>(() => {
    const value = new URLSearchParams(window.location.search).get("billing");
    return value === "success" || value === "cancelled" ? value : null;
  });

  useEffect(() => {
    if (!userLoaded) void fetchMe();
  }, [userLoaded, fetchMe]);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  useEffect(() => {
    if (!user || billingReturn !== "success") return;
    let cancelled = false;
    let attempts = 0;
    let timer: number | undefined;
    const poll = async () => {
      await refreshBilling();
      attempts += 1;
      if (!cancelled && attempts < 6) timer = window.setTimeout(poll, 1800);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [billingReturn, refreshBilling, user]);

  useEffect(() => {
    if (!paywall) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePaywall();
        setPublicAuditOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closePaywall, paywall]);

  useEffect(() => {
    if (!publicAuditOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPublicAuditOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [publicAuditOpen]);

  useEffect(() => {
    if (publicReportScanId === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPublicReportScanId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [publicReportScanId]);

  const publicScanRunning = publicScans.some((scan) => scan.status === "running");
  useEffect(() => {
    if (!user || !publicScanRunning) return;
    const timer = window.setInterval(() => void refreshPublicScans(), 2500);
    return () => window.clearInterval(timer);
  }, [publicScanRunning, refreshPublicScans, user]);

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
            {billing && billing.accounts.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  clearPublicScanError();
                  setPublicAuditOpen(true);
                }}
                className="dashboard-button dashboard-button--inspection"
              >
                <Icon name="search" />
                Audit public repo
              </button>
            )}
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

        {billing && (
          <PlanLedger
            billing={billing}
            busyInstallationId={billingBusyInstallationId}
            onUpgrade={(installationId) => void startProCheckout(installationId)}
            onManage={(installationId) => void openBillingPortal(installationId)}
          />
        )}

        {billingReturn === "success" && (
          <div className="dashboard-notice dashboard-notice--success" role="status">
            <Icon name="shield" />
            <div>
              <strong>
                {billing?.accounts.some((account) => account.plan === "pro")
                  ? "Pro is active"
                  : "Activating Pro"}
              </strong>
              <p>
                {billing?.accounts.some((account) => account.plan === "pro")
                  ? "Your repository allowances have been updated."
                  : "Stripe confirmed the checkout. This page will update when the signed webhook arrives."}
              </p>
            </div>
          </div>
        )}

        {billingReturn === "cancelled" && (
          <div className="dashboard-notice dashboard-notice--warning" role="status">
            <Icon name="billing" />
            <div>
              <strong>Checkout cancelled</strong>
              <p>Your Free plan and existing protection were not changed.</p>
            </div>
          </div>
        )}

        {billingError && (
          <div className="dashboard-notice dashboard-notice--warning" role="alert">
            <Icon name="alert" />
            <div>
              <strong>Billing action unavailable</strong>
              <p>{billingError}</p>
            </div>
          </div>
        )}

        <PublicAuditHistory scans={publicScans} onOpen={setPublicReportScanId} />

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
      {paywall && (
        <UpgradeDialog
          reason={paywall}
          billing={billing}
          busy={billingBusyInstallationId === paywall.installationId}
          onClose={() => {
            closePaywall();
            setPublicAuditOpen(false);
          }}
          onUpgrade={() => void startProCheckout(paywall.installationId)}
        />
      )}
      {publicAuditOpen && billing && !paywall && (
        <PublicAuditDialog
          accounts={billing.accounts}
          busy={publicScanBusy}
          error={publicScanError}
          onClose={() => setPublicAuditOpen(false)}
          onStart={startPublicRepoScan}
        />
      )}
      {publicReportScanId !== null && (
        <PublicAuditReportDialog
          scanId={publicReportScanId}
          onClose={() => setPublicReportScanId(null)}
          fetchDetail={fetchPublicRepoScanDetail}
        />
      )}
    </div>
  );
}
