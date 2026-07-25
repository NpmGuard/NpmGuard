/**
 * Durable Report page (/package/<name>?version=). Reads the persisted,
 * schemaVersion-2 report from the store's report query and renders the shared
 * <ReportView variant="full"> surface. This is the durable view — there is NO
 * session file access here, so onOpenFile is deliberately omitted (source
 * viewing is a Live-Audit-only affordance).
 *
 * Route is `/package/*` (splat) so scoped names keep their slash: the package
 * name is parsed off location.pathname, the version off the ?version= query.
 *
 * ── PRESENTATION: what the recomposition onto the token layer changed ───────
 *
 * The four-state gate is now `LoadState` + the `ui/` primitives, and the two
 * differences that matter are the ones the old shape could not express:
 *
 * 1. `missing` (404) and `error` (anything else) were both hand-built boxes and
 *    only ONE of them is an emptiness. A package with no report is a successful
 *    read that found nothing — `EmptyState`, achromatic, with the action that
 *    fixes it. A failed read is `DegradedSurface`, violet and named. They now
 *    look nothing like each other, which is the §3.4 requirement.
 * 2. That failed read rendered `banner--danger` — red, for a report we could not
 *    fetch. §0 rule 3 reserves red for claims about the package.
 *
 * The header keeps `package@version` and the verdict stamp; `ReportView` used to
 * repeat both two lines below and no longer does.
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError } from "../lib/api-base.ts";
import { fetchPackageReport } from "../lib/api.ts";
import type { PackageReportResponse } from "@npmguard/shared";
import { useAuditStore } from "../stores/auditStore.ts";
import { ReportView } from "../components/report/ReportView.tsx";
import { PanelPage } from "../components/panel/layout.tsx";
import { Button } from "../components/ui/button.tsx";
import { DegradedSurface } from "../components/ui/degraded-state.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { failed, loaded, type LoadState } from "../components/ui/load-state.ts";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { VerdictStamp } from "../components/ui/verdict-stamp.tsx";
import { PackageSearch } from "lucide-react";

/** A 404 is a SUCCESSFUL read whose answer is "there is no report" — an
 * emptiness, not a failure — so it lives inside the `ok` arm as `null` rather
 * than beside the union as a fourth kind.
 *
 * That is not a modelling nicety. `EmptyState` needs a `ReadSucceeded` token,
 * and the only honest mint is `loaded(data)`. Modelling `missing` outside the
 * union would have forced a hand-rolled token here — a forgeable one, which is
 * precisely the weakening `load-state.ts` exists to make impossible. Putting the
 * emptiness where it belongs means the token is the real one: we DID read the
 * engine, and it said none. */
type Report = PackageReportResponse | null;

/** The route is `/package/*` (splat) so scoped names keep their slash. */
function nameFromPath(pathname: string): string {
  return decodeURIComponent(pathname.replace(/^\/package\//, ""));
}

export function PackageLookup() {
  const location = useLocation();
  const navigate = useNavigate();
  const startAudit = useAuditStore((s) => s.startAudit);
  const name = nameFromPath(location.pathname);
  const version = new URLSearchParams(location.search).get("version") ?? undefined;
  const [state, setState] = useState<LoadState<Report>>({ status: "loading" });

  useEffect(() => {
    let live = true;
    const load = () => {
      setState({ status: "loading" });
      void fetchPackageReport(name, version)
        .then((data) => live && setState(loaded<Report>(data)))
        .catch((err) => {
          if (!live) return;
          // A 404 is an answer, not a failure: `loaded(null)`, so the empty
          // state downstream carries a token we genuinely earned.
          if (err instanceof ApiError && err.status === 404) {
            setState(loaded<Report>(null));
            return;
          }
          setState(
            failed({
              what: "Audit report",
              detail: err instanceof Error ? err.message : undefined,
              retry: load,
            }),
          );
        });
    };
    load();
    return () => {
      live = false;
    };
  }, [name, version]);

  /**
   * Re-audit: pessimistically try to start a fresh audit. The store sets
   * `auditId`, which App observes and routes to the live view; a 402 (payment
   * required) routes to the payment entry with the package prefilled.
   */
  async function reaudit() {
    try {
      await startAudit(name, version);
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        navigate(
          `/pay?package=${encodeURIComponent(name)}${version ? `&version=${version}` : ""}`,
        );
        return;
      }
      navigate(
        `/pay?package=${encodeURIComponent(name)}${version ? `&version=${version}` : ""}`,
      );
    }
  }

  if (state.status === "loading") {
    return (
      <PanelPage>
        <div aria-busy="true" className="grid gap-3">
          <span className="sr-only">Loading the report for {name}</span>
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </PanelPage>
    );
  }

  if (state.status === "failed") {
    return (
      <PanelPage>
        <DegradedSurface
          failure={state.failure}
          escape={{ label: "Browse audited packages", href: "/packages" }}
        />
      </PanelPage>
    );
  }

  if (state.data === null) {
    return (
      <PanelPage>
        <EmptyState
          read={state.read}
          icon={PackageSearch}
          message={`No audit report for ${name} yet.`}
          hint="Nothing has been audited under this name and version. Running one takes a few minutes."
          action={
            <Button aria-label={`audit ${name}`} onClick={() => void reaudit()}>
              Audit this package
            </Button>
          }
        />
      </PanelPage>
    );
  }

  const { report, packageName, version: reportVersion } = state.data;

  return (
    <PanelPage>
      <header className="flex flex-wrap items-center gap-3">
        <span className="me-auto min-w-0 font-mono text-lg font-semibold break-all text-text">
          {packageName}
          <span className="text-text-3">@{reportVersion}</span>
        </span>
        <VerdictStamp outcome={report.verdict} />
        <Button
          variant="outline"
          size="sm"
          aria-label={`re-audit ${packageName}`}
          onClick={() => void reaudit()}
        >
          Re-audit
        </Button>
      </header>

      <div className="mt-5">
        <ReportView report={report} variant="full" />
      </div>
    </PanelPage>
  );
}
