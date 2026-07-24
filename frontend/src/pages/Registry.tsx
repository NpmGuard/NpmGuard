/**
 * Packages registry (/packages) — the audited-report index.
 *
 * ONE list query (fetchPackages → {packages}), then everything else is derived
 * with .filter/.find/useMemo — no store, no data-grid, no virtualization
 * (patterns-synthesis.md §1.4). Selection lives in the URL: each row is a real
 * <a href> to /package/<name>?version=<v>. A search term that matches no audited
 * row can be resolved (resolveVersion) into an "Audit <pkg>@<version>" CTA.
 *
 * Tri-state gate (plane IssueLayoutHOC): loading → skeleton rows that reuse the
 * real <Row> markup (never drift); empty → reason-aware; rows → the real table.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../lib/api-base.ts";
import { fetchPackages, resolveVersion } from "../lib/api.ts";
import type { PackageSummary, Verdict } from "../lib/engine-types.ts";
import { formatDate } from "../lib/format.ts";
import { parsePackageInput } from "../lib/types.ts";
import { verdictTone } from "../lib/report-helpers.ts";
import { useAuditStore } from "../stores/auditStore.ts";

type QueryState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; packages: PackageSummary[] };

type VerdictFilter = "ALL" | Verdict;

type LookupState =
  | { kind: "idle" }
  | { kind: "resolving"; term: string }
  | { kind: "resolved"; name: string; version: string }
  | { kind: "notfound"; term: string }
  | { kind: "error"; message: string };

const SKELETON_ROWS = 5;

export function Registry() {
  const [query, setQuery] = useState<QueryState>({ kind: "loading" });
  const [search, setSearch] = useState("");
  const [verdict, setVerdict] = useState<VerdictFilter>("ALL");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
  const [starting, setStarting] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let live = true;
    void fetchPackages()
      .then((r) => live && setQuery({ kind: "ready", packages: r.packages }))
      .catch(
        (err) =>
          live &&
          setQuery({
            kind: "error",
            message: err instanceof Error ? err.message : "Could not load audited packages",
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  const allPackages = query.kind === "ready" ? query.packages : [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allPackages.filter((pkg) => {
      const matchesTerm = term === "" || pkg.packageName.toLowerCase().includes(term);
      const matchesVerdict = verdict === "ALL" || pkg.verdict === verdict;
      return matchesTerm && matchesVerdict;
    });
  }, [allPackages, search, verdict]);

  const trimmedSearch = search.trim();

  async function runLookup(raw: string) {
    const { name, version } = parsePackageInput(raw);
    if (!name) return;
    setLookup({ kind: "resolving", term: raw });
    try {
      const resolved = await resolveVersion(name, version ?? undefined);
      setLookup({ kind: "resolved", name: resolved.packageName, version: resolved.version });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setLookup({ kind: "notfound", term: raw });
      } else {
        setLookup({
          kind: "error",
          message: err instanceof Error ? err.message : "Could not resolve the package",
        });
      }
    }
  }

  async function startAuditFor(name: string, version: string) {
    setStarting(true);
    try {
      // Payment verification is a server-side trust boundary — the UI observes.
      // dev (payment off) starts the stream; a 402 means the engine wants payment.
      await useAuditStore.getState().startAudit(name, version);
      // The store now holds an auditId; App's effect navigates to /audit/:id.
    } catch (err) {
      setStarting(false);
      if (err instanceof ApiError && err.status === 402) {
        navigate(`/pay?package=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`);
        return;
      }
      setLookup({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not start the audit",
      });
    }
  }

  const shownCount = query.kind === "ready" ? `${filtered.length}` : "—";

  return (
    <div className="page__inner fade-up pg-registry">
      <header className="pg-registry-head">
        <div className="section-title">
          <span className="eyebrow">Registry</span>
          <h1 className="headline">Audited packages</h1>
        </div>
        <span className="mono pg-registry-count" aria-live="polite">
          {shownCount} shown
        </span>
      </header>

      <form
        className="pg-registry-toolbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmedSearch) void runLookup(trimmedSearch);
        }}
      >
        <input
          className="input pg-registry-search"
          type="search"
          placeholder="Filter by package name…"
          name="q"
          aria-label="filter audited packages by name"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (lookup.kind !== "idle") setLookup({ kind: "idle" });
          }}
        />
        <select
          className="select"
          aria-label="filter by verdict"
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as VerdictFilter)}
        >
          <option value="ALL">All verdicts</option>
          <option value="SAFE">Safe</option>
          <option value="DANGEROUS">Dangerous</option>
        </select>
        <button
          type="submit"
          className="btn btn--dark"
          disabled={!trimmedSearch || lookup.kind === "resolving"}
          aria-label={`look up ${trimmedSearch || "a package"} on the registry`}
        >
          Look up
        </button>
      </form>

      {lookup.kind !== "idle" && (
        <LookupResult
          lookup={lookup}
          starting={starting}
          onAudit={(name, version) => void startAuditFor(name, version)}
        />
      )}

      {query.kind === "error" ? (
        <div className="banner banner--danger" role="alert">
          {query.message}
        </div>
      ) : (
        <div className="pg-registry-table-wrap">
          <table className="table pg-registry-table">
            <thead>
              <tr>
                <th>Package</th>
                <th>Version</th>
                <th>Verdict</th>
                <th>Audited</th>
              </tr>
            </thead>
            <tbody>
              {query.kind === "loading" ? (
                Array.from({ length: SKELETON_ROWS }, (_, i) => <SkeletonRow key={i} />)
              ) : filtered.length > 0 ? (
                filtered.map((pkg) => (
                  <PackageRow key={`${pkg.packageName}@${pkg.version}`} pkg={pkg} />
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="pg-registry-empty-cell">
                    <RegistryEmpty
                      totalCount={allPackages.length}
                      search={trimmedSearch}
                      filtered={verdict !== "ALL"}
                      onLookup={() => trimmedSearch && void runLookup(trimmedSearch)}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One audited package — a real <a href> row (the whole row is the link via a
 * stretched pseudo-element in registry.css; keyboard + cmd-click free). */
function PackageRow({ pkg }: { pkg: PackageSummary }) {
  const tone = verdictTone(pkg.verdict);
  return (
    <tr className="clickable pg-registry-row">
      <td>
        <Link
          className="mono pg-registry-link"
          to={`/package/${pkg.packageName}?version=${pkg.version}`}
          aria-label={`view full audit of ${pkg.packageName}`}
        >
          {pkg.packageName}
        </Link>
      </td>
      <td className="mono">{pkg.version}</td>
      <td>
        <span className={`pill pill--${tone}`}>{pkg.verdict}</span>
      </td>
      <td className="microtext">{formatDate(pkg.auditedAt)}</td>
    </tr>
  );
}

/** Skeleton row — reuses the exact <td> layout of PackageRow so the loading
 * shape can never drift from the loaded one (twenty RecordTableBodyLoading). */
function SkeletonRow() {
  return (
    <tr className="pg-registry-row pg-registry-row--skeleton" aria-hidden="true">
      <td>
        <span className="pg-registry-skel" style={{ width: "58%" }} />
      </td>
      <td>
        <span className="pg-registry-skel" style={{ width: "44px" }} />
      </td>
      <td>
        <span className="pg-registry-skel pg-registry-skel--pill" />
      </td>
      <td>
        <span className="pg-registry-skel" style={{ width: "72px" }} />
      </td>
    </tr>
  );
}

/** Reason-aware empty (twenty §3 empty-state router): a truly empty index reads
 * differently from a filter that hid everything. Honest copy, never a fake 0. */
function RegistryEmpty({
  totalCount,
  search,
  filtered,
  onLookup,
}: {
  totalCount: number;
  search: string;
  filtered: boolean;
  onLookup: () => void;
}) {
  if (totalCount === 0) {
    return (
      <div className="empty-state">
        <p>No reports yet.</p>
        <p className="microtext">Audited packages appear here once a report is stored.</p>
      </div>
    );
  }
  if (search) {
    return (
      <div className="empty-state">
        <p>
          No audited package matches <span className="mono">{search}</span>.
        </p>
        <button type="button" className="btn btn--dark btn--sm" onClick={onLookup}>
          Look up <span className="mono">{search}</span>
        </button>
      </div>
    );
  }
  return (
    <div className="empty-state">
      <p>None match this filter.</p>
      {filtered && <p className="microtext">Try a different verdict.</p>}
    </div>
  );
}

/** Lookup outcome for a term not (yet) in the index — resolve → "Audit" CTA. */
function LookupResult({
  lookup,
  starting,
  onAudit,
}: {
  lookup: LookupState;
  starting: boolean;
  onAudit: (name: string, version: string) => void;
}) {
  if (lookup.kind === "resolving") {
    return (
      <div className="card pg-registry-lookup" role="status">
        <span className="spinner" aria-hidden="true" />
        <span className="subtext">
          Resolving <span className="mono">{lookup.term}</span>…
        </span>
      </div>
    );
  }
  if (lookup.kind === "notfound") {
    return (
      <div className="card pg-registry-lookup">
        <span className="subtext">
          No package named <span className="mono">{lookup.term}</span> on the registry.
        </span>
      </div>
    );
  }
  if (lookup.kind === "error") {
    return (
      <div className="banner banner--danger" role="alert">
        {lookup.message}
      </div>
    );
  }
  if (lookup.kind === "idle") return null; // parent only mounts on non-idle
  // resolved
  return (
    <div className="card pg-registry-lookup pg-registry-lookup--resolved">
      <div className="pg-registry-lookup-id">
        <span className="eyebrow">Not audited yet</span>
        <span className="mono pg-registry-lookup-pkg">
          {lookup.name}
          <span className="microtext"> @{lookup.version}</span>
        </span>
      </div>
      <button
        type="button"
        className="btn btn--violet"
        disabled={starting}
        onClick={() => onAudit(lookup.name, lookup.version)}
        aria-label={`audit ${lookup.name} at ${lookup.version}`}
      >
        {starting ? (
          <>
            <span className="spinner" aria-hidden="true" /> Starting…
          </>
        ) : (
          <>
            Audit <span className="mono">{lookup.name}@{lookup.version}</span>
          </>
        )}
      </button>
    </div>
  );
}
