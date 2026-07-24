/** GitHub workspace dashboard: posture hero, plan ledger, public audit
 * history, portfolio rail, alerts, and the filterable repo grid. Public
 * scans have no SSE — the page polls while any snapshot is running. */

import { Globe, Plus, RefreshCw, Search, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { AlertsNotice } from "../components/panel/AlertsNotice.tsx";
import { PlanLedger } from "../components/panel/PlanLedger.tsx";
import { PortfolioPosture } from "../components/panel/PortfolioPosture.tsx";
import { PublicAuditDialog } from "../components/panel/PublicAuditDialog.tsx";
import { PublicAuditHistory } from "../components/panel/PublicAuditHistory.tsx";
import { PublicAuditReportDialog } from "../components/panel/PublicAuditReportDialog.tsx";
import { RepoCard } from "../components/panel/RepoCard.tsx";
import { UpgradeDialog } from "../components/panel/UpgradeDialog.tsx";
import type { PanelRepo } from "../lib/engine-types.ts";
import { githubLoginUrl } from "../lib/panel-api.ts";
import { usePanelStore } from "../stores/panelStore.ts";

type RepoFilter = "all" | "protected" | "unscanned" | "attention";

const FILTERS: { key: RepoFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "protected", label: "Protected" },
  { key: "unscanned", label: "Not audited" },
  { key: "attention", label: "Attention" },
];

function needsAttention(repo: PanelRepo): boolean {
  const scan = repo.lastScan;
  return (
    scan !== null &&
    (scan.status === "failed" || scan.verdict === "DANGEROUS" || scan.verdict === "SUSPECT")
  );
}

export function Dashboard() {
  const user = usePanelStore((s) => s.user);
  const userLoaded = usePanelStore((s) => s.userLoaded);
  const installations = usePanelStore((s) => s.installations);
  const installUrl = usePanelStore((s) => s.installUrl);
  const repos = usePanelStore((s) => s.repos);
  const billing = usePanelStore((s) => s.billing);
  const publicScans = usePanelStore((s) => s.publicScans);
  const loading = usePanelStore((s) => s.loading);
  const error = usePanelStore((s) => s.error);
  const paywall = usePanelStore((s) => s.paywall);
  const refresh = usePanelStore((s) => s.refresh);
  const refreshBilling = usePanelStore((s) => s.refreshBilling);
  const refreshPublicScans = usePanelStore((s) => s.refreshPublicScans);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RepoFilter>("all");
  const [auditDialogOpen, setAuditDialogOpen] = useState(false);
  const [reportScanId, setReportScanId] = useState<number | null>(null);
  const [billingNotice, setBillingNotice] = useState<"success" | "cancelled" | null>(null);

  // Boot: one refresh once the session user is known.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (user && !bootedRef.current) {
      bootedRef.current = true;
      void refresh();
    }
  }, [user, refresh]);

  // Stripe return: pick up ?billing=… then strip it from the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const billingParam = params.get("billing");
    if (billingParam === "success" || billingParam === "cancelled") {
      setBillingNotice(billingParam);
      params.delete("billing");
      const rest = params.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + (rest ? `?${rest}` : ""),
      );
    }
  }, []);

  // Successful checkout races the Stripe webhook — poll billing up to 6×.
  useEffect(() => {
    if (billingNotice !== "success") return;
    let count = 0;
    const timer = setInterval(() => {
      count += 1;
      void refreshBilling();
      if (count >= 6) clearInterval(timer);
    }, 1800);
    return () => clearInterval(timer);
  }, [billingNotice, refreshBilling]);

  // Public snapshots have no SSE — poll while any scan is running.
  const anyPublicScanRunning = publicScans.some((scan) => scan.status === "running");
  useEffect(() => {
    if (!anyPublicScanRunning) return;
    const timer = setInterval(() => void refreshPublicScans(), 2500);
    return () => clearInterval(timer);
  }, [anyPublicScanRunning, refreshPublicScans]);

  if (!userLoaded) {
    return (
      <div className="page__inner">
        <div className="panel-gate" role="status" aria-label="Loading">
          <span className="spinner" />
        </div>
      </div>
    );
  }

  if (!user) {
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

  const counts: Record<RepoFilter, number> = {
    all: repos.length,
    protected: repos.filter((repo) => repo.protected).length,
    unscanned: repos.filter((repo) => !repo.lastScan).length,
    attention: repos.filter(needsAttention).length,
  };

  const q = query.trim().toLowerCase();
  const visible = repos.filter((repo) => {
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

  const hasBillingAccounts = (billing?.accounts.length ?? 0) > 0;

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
          <button type="button" className="btn" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw size={14} className={loading ? "panel-spin" : undefined} /> Refresh
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

      <AlertsNotice />

      {error && (
        <div className="banner banner--danger panel-banner-gap" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--sm" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}

      <PlanLedger />
      <PublicAuditHistory
        scans={publicScans}
        onOpen={(scanId) => {
          setAuditDialogOpen(false);
          setReportScanId(scanId);
        }}
      />
      <PortfolioPosture repos={repos} />

      {loading && repos.length === 0 ? (
        <div className="empty-state" role="status">
          <span className="spinner" /> Loading repositories…
        </div>
      ) : repos.length === 0 && installations.length === 0 && !error ? (
        <div className="empty-state">
          <span className="empty-state__icon">
            <Plus size={18} strokeWidth={1.8} />
          </span>
          <strong>Install NpmGuard on a GitHub account</strong>
          <span>Connect an organization or personal account to audit its repositories.</span>
          {installUrl && (
            <a className="btn btn--dark" href={installUrl} target="_blank" rel="noreferrer">
              Add repositories
            </a>
          )}
        </div>
      ) : repos.length === 0 && !error ? (
        <div className="empty-state">
          <strong>No auditable repositories found</strong>
          <span>
            Only repositories with <span className="mono">package-lock.json</span>,{" "}
            <span className="mono">pnpm-lock.yaml</span>, or{" "}
            <span className="mono">yarn.lock</span> at the repository root are shown.
          </span>
          <button type="button" className="btn" onClick={() => void refresh()}>
            Check again
          </button>
        </div>
      ) : repos.length > 0 ? (
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
            <div className="panel-filters" role="group" aria-label="Filter repositories">
              {FILTERS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={`btn btn--sm panel-filter${filter === entry.key ? " active" : ""}`}
                  aria-pressed={filter === entry.key}
                  onClick={() => setFilter(entry.key)}
                >
                  {entry.label} <span className="mono panel-filter__count">{counts[entry.key]}</span>
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
      ) : null}

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
