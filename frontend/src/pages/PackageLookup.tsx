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
 * Tri-state gate (patterns-synthesis §1.3 + §3):
 *   loading → .spinner   ·   404 → honest .empty-state   ·   error → .banner--danger
 */

import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError } from "../lib/api-base.ts";
import { fetchPackageReport } from "../lib/api.ts";
import type { PackageReportResponse } from "../lib/engine-types.ts";
import { verdictTone } from "../lib/report-helpers.ts";
import { useAuditStore } from "../stores/auditStore.ts";
import { ReportView } from "../components/report/ReportView.tsx";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: PackageReportResponse };

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
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    void fetchPackageReport(name, version)
      .then((data) => live && setState({ kind: "ready", data }))
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setState({ kind: "missing" });
        else setState({ kind: "error", message: err instanceof Error ? err.message : "Failed" });
      });
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

  if (state.kind === "loading") {
    return (
      <div className="page__inner">
        <div className="empty-state" role="status">
          <span className="spinner" aria-hidden="true" />
          <p className="subtext">
            Loading the report for <span className="mono">{name}</span>…
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div className="page__inner">
        <div className="empty-state">
          <p>
            No audit report for <span className="mono">{name}</span> yet.
          </p>
          <button
            type="button"
            className="btn btn--dark"
            aria-label={`audit ${name}`}
            onClick={() => void reaudit()}
          >
            Audit this package
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="page__inner">
        <div className="banner banner--danger" role="alert">
          {state.message}
        </div>
      </div>
    );
  }

  const { report, packageName, version: reportVersion } = state.data;
  const tone = verdictTone(report.verdict);

  return (
    <div className="page__inner fade-up" style={{ display: "grid", gap: 20 }}>
      <header
        style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}
      >
        <span className="mono headline headline--sm" style={{ marginRight: "auto" }}>
          {packageName}
          <span className="microtext"> @{reportVersion}</span>
        </span>
        <span className={`pill pill--${tone}`}>{report.verdict}</span>
        <button
          type="button"
          className="btn btn--sm"
          aria-label={`re-audit ${packageName}`}
          onClick={() => void reaudit()}
        >
          Re-audit
        </button>
      </header>

      <ReportView report={report} packageName={packageName} version={reportVersion} variant="full" />
    </div>
  );
}
