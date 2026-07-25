/** GitHub workspace dashboard: posture hero, plan ledger, public audit
 * history, portfolio rail, alerts, and the filterable repo grid.
 *
 * Every region below reads its OWN query, and that is the point of this page's
 * rewrite. The old `refresh()` fetched five resources through one
 * `Promise.allSettled` and collapsed them into one `loading` plus one `error`, so
 * a partial fetch rendered as a confident view: alerts failing while repos
 * succeeded left a repo list that looked complete beside an alerts banner that
 * looked absent — "no threats" where the truth was "no knowledge". Per-query
 * status makes that state representable, and every region now says which of the
 * two it is.
 *
 * The polling that used to live in three `useEffect`s here is gone: the
 * public-scan list carries its own data-dependent `refetchInterval`, and the
 * post-checkout billing poll stops on the fact it is waiting for. */

import type { PanelRepo } from "@npmguard/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Plus, RefreshCw, Search, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";
import { DataRegion } from "../components/ui/data-region.tsx";
import { StaleChip } from "../components/ui/stale-chip.tsx";
import { AlertsNotice } from "../features/alerts/components/AlertsNotice.tsx";
import { useAlerts } from "../features/alerts/hooks.ts";
import { PlanLedger } from "../features/billing/components/PlanLedger.tsx";
import { UpgradeDialog } from "../features/billing/components/UpgradeDialog.tsx";
import { useBilling } from "../features/billing/hooks.ts";
import { PortfolioPosture } from "../features/repos/components/PortfolioPosture.tsx";
import { PublicAuditDialog } from "../features/repos/components/PublicAuditDialog.tsx";
import { PublicAuditHistory } from "../features/repos/components/PublicAuditHistory.tsx";
import { PublicAuditReportDialog } from "../features/repos/components/PublicAuditReportDialog.tsx";
import { RepoCard } from "../features/repos/components/RepoCard.tsx";
import { usePublicScans, useRepos } from "../features/repos/hooks.ts";
import { githubLoginUrl } from "../features/session/api.ts";
import { useInstallations, useSession } from "../features/session/hooks.ts";
import { formatDateTime } from "../lib/format.ts";
import { allLoaded } from "../lib/query-state.ts";
import { usePanelUi } from "../stores/panelStore.ts";

type RepoFilter = "all" | "protected" | "unscanned" | "attention";

const FILTERS: { key: RepoFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "protected", label: "Protected" },
  { key: "unscanned", label: "Not audited" },
  { key: "attention", label: "Attention" },
];

/** Attention = a human has to do something: a dep is DANGEROUS, or audits could
 * not conclude (ERROR). A set still running, or one with pending deps, is NOT
 * attention — it resolves itself.
 *
 * The set's own rollup is the authority. There is no failed-SET arm: R-1's
 * falsification pass found zero producers for one, and every way a set can go
 * wrong now lands in the rollup as ERROR, which this already reads. */
function needsAttention(repo: PanelRepo): boolean {
  const outcome = repo.lastScan?.rollup.outcome ?? null;
  return outcome === "DANGEROUS" || outcome === "ERROR";
}

export function Dashboard() {
  const client = useQueryClient();
  const session = useSession();
  const installations = useInstallations();
  const repos = useRepos();
  const alerts = useAlerts();
  const publicScans = usePublicScans();
  const paywall = usePanelUi((s) => s.paywall);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RepoFilter>("all");
  const [auditDialogOpen, setAuditDialogOpen] = useState(false);
  const [reportScanId, setReportScanId] = useState<number | null>(null);
  const [billingNotice, setBillingNotice] = useState<"success" | "cancelled" | null>(null);

  // A successful checkout races the Stripe webhook, so the ledger keeps polling
  // until an account reports `pro`. The stop condition is the FACT being waited
  // for, not a "poll six times and hope" counter.
  const billing = useBilling({ awaitingWebhook: billingNotice === "success" });

  // Stripe return: pick up ?billing=… then strip it from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const billingParam = params.get("billing");
    if (billingParam === "success" || billingParam === "cancelled") {
      setBillingNotice(billingParam);
      params.delete("billing");
      const rest = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""));
    }
  }, []);

  /** Refresh means "every panel read on this page", and the cache already knows
   * what those are. The old page hand-listed them in `refresh()`, which is how
   * `publicScans` ended up refreshed from three different places. */
  const refreshAll = () => void client.invalidateQueries();

  if (session.status === "loading") {
    return (
      <div className="page__inner">
        <div className="panel-gate" role="status" aria-label="Loading">
          <span className="spinner" />
        </div>
      </div>
    );
  }

  // A session that could not be READ is not a session that is absent. Rendering
  // the sign-in card here would invite a click that cannot work, so the failure
  // is named instead.
  if (session.status === "failed") {
    return (
      <div className="page__inner">
        <div className="banner banner--danger panel-banner-gap" role="alert">
          <span>
            {`${session.failure.what} could not be loaded — ${session.failure.detail ?? "no detail"}`}
          </span>
          {session.failure.retry && (
            <button type="button" className="btn btn--sm" onClick={session.failure.retry}>
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  // 503 from every panel route: this deployment has no GitHub App. Distinct from
  // "signed out", because no amount of signing in will fix it.
  if (!session.data.appEnabled) {
    return (
      <div className="page__inner">
        <div className="empty-state">
          <strong>The GitHub workspace is not configured on this server</strong>
          <span>
            This deployment has no NpmGuard GitHub App, so repository scanning and continuous
            protection are unavailable. Single-package audits are unaffected.
          </span>
        </div>
      </div>
    );
  }

  if (!session.data.user) {
    return (
      <div className="page__inner">
        <div className="panel-login dot-grid">
          <div className="card panel-login__card fade-up">
            <span className="eyebrow">GitHub workspace</span>
            <h1 className="headline">Connect your GitHub workspace</h1>
            <p className="subtext">
              Continuous dependency audits, push-triggered scans, and registry watch across your
              repositories.
            </p>
            <a className="btn btn--dark" href={githubLoginUrl()}>
              Sign in with GitHub
            </a>
          </div>
        </div>
      </div>
    );
  }

  // The grid's empty copy is a PRODUCT of two reads: "you have no auditable
  // repositories" and "you have not installed the App anywhere" are different
  // sentences, and telling them apart needs both lists. `allLoaded` is what makes
  // the confident branch unreachable unless both actually read.
  const workspace = allLoaded({ installations, repos });
  const installUrl = installations.status === "ok" ? installations.data.installUrl : null;
  const noInstallations =
    installations.status === "ok" && installations.data.installations.length === 0;

  const known = repos.status === "ok" ? repos.data : [];
  const counts: Record<RepoFilter, number> = {
    all: known.length,
    protected: known.filter((repo) => repo.protected).length,
    unscanned: known.filter((repo) => !repo.lastScan).length,
    attention: known.filter(needsAttention).length,
  };

  const q = query.trim().toLowerCase();
  const matching = (all: PanelRepo[]) =>
    all.filter((repo) => {
      if (filter === "protected" && !repo.protected) return false;
      if (filter === "unscanned" && repo.lastScan) return false;
      if (filter === "attention" && !needsAttention(repo)) return false;
      if (
        q &&
        !repo.fullName.toLowerCase().includes(q) &&
        !repo.defaultBranch.toLowerCase().includes(q)
      )
        return false;
      return true;
    });

  const hasBillingAccounts = billing.status === "ok" && billing.data.accounts.length > 0;
  const refreshing = workspace.status === "loading";
  // `asOf` lives on the `ok` arm only — asking a failed read when it was last
  // current is meaningless, which is exactly why the field is not on that arm.
  const staleAsOf = workspace.status === "ok" ? workspace.asOf : undefined;

  return (
    <div className="page__inner">
      <header className="panel-hero fade-up">
        <div className="panel-hero__intro">
          <span className="eyebrow">GitHub workspace</span>
          <h1 className="headline headline--lg">Repository posture</h1>
          <p className="subtext">
            Continuous dependency audits across your connected repositories.
          </p>
        </div>
        <div className="panel-hero__actions">
          {hasBillingAccounts && (
            <button type="button" className="btn" onClick={() => setAuditDialogOpen(true)}>
              <Globe size={14} /> Audit public repo
            </button>
          )}
          <button type="button" className="btn" disabled={refreshing} onClick={refreshAll}>
            <RefreshCw size={14} className={refreshing ? "panel-spin" : undefined} /> Refresh
          </button>
          {installUrl && (
            <a className="btn btn--dark" href={installUrl} target="_blank" rel="noreferrer">
              <Plus size={14} /> Add repositories
            </a>
          )}
        </div>
      </header>

      {billingNotice === "success" && (
        <div className="banner banner--safe panel-banner-gap" role="status">
          <span>Payment confirmed — your plan is updating. This can take a few seconds.</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Dismiss notice"
            onClick={() => setBillingNotice(null)}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {billingNotice === "cancelled" && (
        <div className="banner panel-banner-gap" role="status">
          <span>Checkout cancelled — your plan is unchanged.</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Dismiss notice"
            onClick={() => setBillingNotice(null)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      <AlertsNotice state={alerts} />

      <PlanLedger state={billing} />
      <PublicAuditHistory
        state={publicScans}
        onOpen={(scanId) => {
          setAuditDialogOpen(false);
          setReportScanId(scanId);
        }}
      />
      {/* The posture rail is a proportion over the repo list, so it renders only
          from the arm that HOLDS that list. A rail computed over a partial read
          would be a chart of an unknown denominator. */}
      {repos.status === "ok" && <PortfolioPosture repos={repos.data} />}

      <DataRegion
        state={workspace}
        title="Repositories"
        empty={
          noInstallations
            ? {
                message: "Install NpmGuard on a GitHub account to audit its repositories.",
                hint: "Connect an organization or personal account.",
                action: installUrl ? (
                  <a className="btn btn--dark" href={installUrl} target="_blank" rel="noreferrer">
                    Add repositories
                  </a>
                ) : undefined,
              }
            : {
                message: "No auditable repositories found.",
                hint: "Only repositories with package-lock.json, pnpm-lock.yaml, or yarn.lock at the repository root are shown.",
              }
        }
        isEmpty={(data) => data.repos.length === 0}
        loading={
          <div className="empty-state" role="status">
            <span className="spinner" /> Loading repositories…
          </div>
        }
      >
        {({ repos: all }) => {
          const visible = matching(all);
          return (
            <section className="panel-section" aria-label="Repositories">
              <div className="panel-toolbar">
                <div className="panel-search">
                  <Search size={14} aria-hidden="true" />
                  <input
                    className="input"
                    type="search"
                    placeholder="Search repositories"
                    aria-label="Search repositories"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                {/* Stale data is the third fact: real, but not current. `asOf` is
                    set only when the last refresh actually FAILED, so this chip
                    appearing means one specific thing rather than "some time has
                    passed". */}
                {staleAsOf && (
                  <StaleChip asOf={formatDateTime(staleAsOf)} onRefresh={refreshAll} />
                )}
                <div className="panel-filters" role="group" aria-label="Filter repositories">
                  {FILTERS.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      className={`btn btn--sm panel-filter${filter === entry.key ? " active" : ""}`}
                      aria-pressed={filter === entry.key}
                      onClick={() => setFilter(entry.key)}
                    >
                      {entry.label}{" "}
                      <span className="mono panel-filter__count">{counts[entry.key]}</span>
                    </button>
                  ))}
                </div>
              </div>
              {visible.length === 0 ? (
                <div className="empty-state">
                  <strong>No repositories match this view</strong>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    Reset filters
                  </button>
                </div>
              ) : (
                <div className="panel-grid">
                  {visible.map((repo) => (
                    <RepoCard key={repo.id} repo={repo} />
                  ))}
                </div>
              )}
            </section>
          );
        }}
      </DataRegion>

      <AnimatePresence>
        {auditDialogOpen && (
          <PublicAuditDialog
            key="public-audit"
            onClose={() => setAuditDialogOpen(false)}
            onStarted={(scanId) => {
              setAuditDialogOpen(false);
              setReportScanId(scanId);
            }}
          />
        )}
        {reportScanId !== null && (
          <PublicAuditReportDialog
            key={`report-${reportScanId}`}
            scanId={reportScanId}
            onClose={() => setReportScanId(null)}
          />
        )}
        {paywall && <UpgradeDialog key="paywall" />}
      </AnimatePresence>
    </div>
  );
}
