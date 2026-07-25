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
 * post-checkout billing poll stops on the fact it is waiting for.
 *
 * ── PRESENTATION: what the recomposition onto the token layer changed ───────
 *
 * Nothing about what this page fetches or decides. Three things about what it
 * SAYS, all three §3.4 corrections rather than restyling:
 *
 * 1. An unreadable session rendered `banner--danger` — RED. §3.4 rule 2 and §0
 *    rule 3 both forbid it: a failed fetch is not a security finding, red is
 *    reserved for claims NpmGuard makes about a package, and the UI must never
 *    cry wolf about its own plumbing. It is now a `DegradedSurface`: violet,
 *    hatched, named, with a retry only when retrying could answer differently.
 * 2. "This server has no GitHub App" rendered as a grey `.empty-state` box —
 *    visually identical to "you have no repositories". They are now distinct by
 *    construction: that branch mints an `EmptyState` from the session's own
 *    `read` token, and the failure branches cannot reach it.
 * 3. "No repositories match this view" was a bare grey box too. It now goes
 *    through `DataRegion` over `loaded(visible)`, so the one chokepoint handles
 *    every no-content case on the page rather than three of four.
 *
 * The stale/degraded/empty trio is otherwise unchanged, and `Dashboard.test.tsx`
 * passes unmodified — which is the intended proof that this was presentation. */

import type { PanelRepo } from "@npmguard/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Plus, RefreshCw, ServerOff, X } from "lucide-react";
import { useEffect, useState } from "react";
import { PanelPage, PanelSection, SectionLabel } from "../components/panel/layout.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardBody } from "../components/ui/card.tsx";
import { DataRegion } from "../components/ui/data-region.tsx";
import { DegradedSurface } from "../components/ui/degraded-state.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { SearchInput } from "../components/ui/input.tsx";
import { loaded } from "../components/ui/load-state.ts";
import { Skeleton } from "../components/ui/skeleton.tsx";
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
import {
  matchesRepoFilter,
  matchesRepoQuery,
  repoFilterCounts,
  type RepoFilter,
} from "../features/repos/posture.ts";
import { githubLoginUrl } from "../features/session/api.ts";
import { useInstallations, useSession } from "../features/session/hooks.ts";
import { cn } from "../lib/cn.ts";
import { formatDateTime } from "../lib/format.ts";
import { allLoaded } from "../lib/query-state.ts";
import { usePanelUi } from "../stores/panelStore.ts";

const FILTERS: { key: RepoFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "protected", label: "Protected" },
  { key: "unscanned", label: "Not audited" },
  { key: "attention", label: "Attention" },
];

/** The repo grid's own measure. Cards hold a full name plus a status line, so
 * 20rem is the point below which the name wraps mid-identifier. */
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(20rem,1fr))] gap-6";

/** Dismissible page notice. Not `DegradedRegion` and not a toast: it reports the
 * outcome of a Stripe round-trip the user just took, which is neither a failed
 * read nor something that may vanish before it is read (§3.1 forbids toasts for
 * anything that matters).
 *
 * DECISION the brief left open — it specifies no treatment for a transactional
 * notice. `accent`, never `safe`: §0 rule 1 makes the outcome hues mean "NpmGuard
 * is making a claim about a package", and a green "payment confirmed" spends the
 * SAFE slot on billing, which is exactly the leak that makes green stop meaning
 * "no confirmed threat". Accent is the system hue and is not a status. */
function Notice({
  tone,
  children,
  onDismiss,
}: {
  tone: "accent" | "neutral";
  children: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className={cn(
        "mt-6 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
        tone === "accent"
          ? "border-accent-border bg-accent-wash text-accent-text"
          : "border-border bg-sunken text-text-2",
      )}
    >
      <span>{children}</span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Dismiss notice"
        className="size-control-sm shrink-0 px-0"
        onClick={onDismiss}
      >
        <X aria-hidden="true" className="size-icon-sm" />
      </Button>
    </div>
  );
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
      <PanelPage>
        {/* Skeletons only where the final dimensions are known (§3.1) — the hero
            lines and the card grid. `aria-busy` on the region plus one sr-only
            announcement, rather than a spinner per placeholder. */}
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">Loading the GitHub workspace</span>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
          <div className={GRID}>
            {[0, 1, 2].map((slot) => (
              <Skeleton key={slot} className="h-40 w-full" />
            ))}
          </div>
        </div>
      </PanelPage>
    );
  }

  // A session that could not be READ is not a session that is absent. Rendering
  // the sign-in card here would invite a click that cannot work, so the failure
  // is named instead — as a `surface`, because this is the page's primary read
  // and there is no partial page worth salvaging around it.
  if (session.status === "failed") {
    return (
      <PanelPage>
        <DegradedSurface failure={session.failure} />
      </PanelPage>
    );
  }

  // 503 from every panel route: this deployment has no GitHub App. Distinct from
  // "signed out", because no amount of signing in will fix it — and distinct from
  // a failed read, which is the distinction the old grey box lost. The session
  // read SUCCEEDED and told us this, so hatching it would say "we don't know"
  // about the one thing we know for certain; it gets the achromatic empty
  // treatment, and `session.read` — narrowed out of the ok arm and impossible to
  // forge — is the proof it is entitled to it. No action: the fix is a server
  // change, not another attempt.
  if (!session.data.appEnabled) {
    return (
      <PanelPage>
        <EmptyState
          read={session.read}
          icon={ServerOff}
          message="The GitHub workspace is not configured on this server."
          hint="This deployment has no NpmGuard GitHub App, so repository scanning and continuous protection are unavailable. Single-package audits are unaffected."
        />
      </PanelPage>
    );
  }

  if (!session.data.user) {
    return (
      <PanelPage>
        <div className="flex min-h-[60vh] items-center justify-center">
          <Card className="w-full max-w-md">
            <CardBody className="flex flex-col items-start gap-3">
              <SectionLabel>GitHub workspace</SectionLabel>
              <h1 className="text-2xl font-semibold tracking-tight text-text">
                Connect your GitHub workspace
              </h1>
              <p className="text-sm text-text-2">
                Continuous dependency audits, push-triggered scans, and registry watch across your
                repositories.
              </p>
              {/* `asChild` keeps this an `<a>`: sign-in is a navigation, and a
                  `<button>` that navigates loses middle-click, "open in new tab"
                  and the screen-reader announcement. */}
              <Button asChild size="lg" className="mt-1">
                <a href={githubLoginUrl()}>Sign in with GitHub</a>
              </Button>
            </CardBody>
          </Card>
        </div>
      </PanelPage>
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

  // Counts over what we HOLD: a failed repo read has no data arm to count, and
  // `workspace` below is what keeps the confident grid unreachable in that case.
  const known = repos.status === "ok" ? repos.data : [];
  const counts = repoFilterCounts(known);

  const matching = (all: PanelRepo[]) =>
    all.filter((repo) => matchesRepoFilter(repo, filter) && matchesRepoQuery(repo, query));

  const hasBillingAccounts = billing.status === "ok" && billing.data.accounts.length > 0;
  const refreshing = workspace.status === "loading";
  // `asOf` lives on the `ok` arm only — asking a failed read when it was last
  // current is meaningless, which is exactly why the field is not on that arm.
  const staleAsOf = workspace.status === "ok" ? workspace.asOf : undefined;
  const resetFilters = () => {
    setQuery("");
    setFilter("all");
  };

  return (
    <PanelPage>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col items-start gap-1.5">
          <SectionLabel>GitHub workspace</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight text-text">Repository posture</h1>
          <p className="text-sm text-text-2">
            Continuous dependency audits across your connected repositories.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasBillingAccounts && (
            <Button variant="outline" onClick={() => setAuditDialogOpen(true)}>
              <Globe aria-hidden="true" className="size-icon-sm" /> Audit public repo
            </Button>
          )}
          <Button variant="outline" disabled={refreshing} onClick={refreshAll}>
            <RefreshCw
              aria-hidden="true"
              className={cn(
                "size-icon-sm",
                // The word "Refresh" is beside it, so the spin is decoration and
                // may stop under reduced motion without losing information.
                refreshing && "animate-spin motion-reduce:animate-none",
              )}
            />{" "}
            Refresh
          </Button>
          {installUrl && (
            <Button asChild>
              <a href={installUrl} target="_blank" rel="noreferrer">
                <Plus aria-hidden="true" className="size-icon-sm" /> Add repositories
              </a>
            </Button>
          )}
        </div>
      </header>

      {billingNotice === "success" && (
        <Notice tone="accent" onDismiss={() => setBillingNotice(null)}>
          Payment confirmed — your plan is updating. This can take a few seconds.
        </Notice>
      )}
      {billingNotice === "cancelled" && (
        <Notice tone="neutral" onDismiss={() => setBillingNotice(null)}>
          Checkout cancelled — your plan is unchanged.
        </Notice>
      )}

      <div className="mt-6">
        <AlertsNotice state={alerts} />
      </div>

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
        className="mt-12"
        state={workspace}
        title="Repositories"
        empty={
          noInstallations
            ? {
                message: "Install NpmGuard on a GitHub account to audit its repositories.",
                hint: "Connect an organization or personal account.",
                action: installUrl ? (
                  <Button asChild>
                    <a href={installUrl} target="_blank" rel="noreferrer">
                      Add repositories
                    </a>
                  </Button>
                ) : undefined,
              }
            : {
                message: "No auditable repositories found.",
                hint: "Only repositories with package-lock.json, pnpm-lock.yaml, or yarn.lock at the repository root are shown.",
              }
        }
        isEmpty={(data) => data.repos.length === 0}
        loading={
          <div className={GRID}>
            {[0, 1, 2].map((slot) => (
              <Skeleton key={slot} className="h-40 w-full" />
            ))}
          </div>
        }
      >
        {({ repos: all }) => {
          const visible = matching(all);
          return (
            <PanelSection className="mt-0" label="Repositories">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <SearchInput
                  label="Search repositories"
                  placeholder="Search repositories"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {/* Stale data is the third fact: real, but not current. `asOf` is
                    set only when the last refresh actually FAILED, so this chip
                    appearing means one specific thing rather than "some time has
                    passed". */}
                {staleAsOf && (
                  <StaleChip asOf={formatDateTime(staleAsOf)} onRefresh={refreshAll} />
                )}
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter repositories">
                  {FILTERS.map((entry) => (
                    <Button
                      key={entry.key}
                      variant="outline"
                      size="sm"
                      aria-pressed={filter === entry.key}
                      onClick={() => setFilter(entry.key)}
                      // A selected filter is chrome, not an outcome: it wears the
                      // system accent wash, never a semantic hue. A green
                      // "Protected" chip would read as a verdict about the repos
                      // behind it.
                      className={cn(
                        filter === entry.key &&
                          "border-accent-border bg-accent-wash text-accent-text",
                      )}
                    >
                      {entry.label}{" "}
                      <span className="font-mono text-2xs tabular-nums opacity-70">
                        {counts[entry.key]}
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
              {/* `loaded(visible)` is not a formality. The filter result is data
                  we are holding, so it can mint the token honestly — and routing
                  the "nothing matched" case through the same chokepoint as the
                  read means there is no second, hand-written empty box on this
                  page that a future edit could point at a failure. */}
              <DataRegion
                state={loaded(visible)}
                empty={{
                  message: "No repositories match this view.",
                  hint: "Clear the search box or widen the filter.",
                  action: <Button variant="outline" onClick={resetFilters}>Reset filters</Button>,
                }}
              >
                {(rows) => (
                  <div className={GRID}>
                    {rows.map((repo) => (
                      <RepoCard key={repo.id} repo={repo} />
                    ))}
                  </div>
                )}
              </DataRegion>
            </PanelSection>
          );
        }}
      </DataRegion>

      {/* Mounted conditionally rather than wrapped in `AnimatePresence`: the
          dialog primitive's enter is a `@starting-style` transition and its exit
          is immediate, so there is no exit frame for a presence wrapper to hold
          open. */}
      {auditDialogOpen && (
        <PublicAuditDialog
          onClose={() => setAuditDialogOpen(false)}
          onStarted={(scanId) => {
            setAuditDialogOpen(false);
            setReportScanId(scanId);
          }}
        />
      )}
      {reportScanId !== null && (
        <PublicAuditReportDialog
          scanId={reportScanId}
          onClose={() => setReportScanId(null)}
        />
      )}
      {paywall && <UpgradeDialog />}
    </PanelPage>
  );
}
