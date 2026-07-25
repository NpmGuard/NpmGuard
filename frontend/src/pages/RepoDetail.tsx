/** Repository detail: overview posture, review queue, and the full
 * dependency inventory. While a scan is running it follows ONE scan-events SSE
 * stream (unnamed messages: dep snapshots, progress ticks, done).
 *
 * The page holds no copy of the response. The old version kept the detail in
 * `useState` and the stream wrote into that copy, which made the fetched value
 * and the streamed value two facts about one thing — and the page then had to
 * reconcile them by hand on every action (`toggleProtect` re-read the store to
 * decide whether its own optimistic write was safe). Now the query cache is the
 * single source of truth and the stream is one of its writers.
 */

import type { AuditSetItem } from "@npmguard/shared";
import { ArrowLeft, RefreshCw, Search, Shield, ShieldCheck, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  OutcomePill,
  depPriority,
  depTone,
  outcomeTone,
  toneAccent,
  toneDotClass,
  type Tone,
} from "../components/panel/tone.tsx";
import { DegradedSurface } from "../components/ui/degraded-state.tsx";
import { UpgradeDialog } from "../features/billing/components/UpgradeDialog.tsx";
import {
  useRepoDetail,
  useRepoDetailStream,
  useResync,
  useSetProtect,
  useTriggerScan,
} from "../features/repos/hooks.ts";
import { formatDate } from "../lib/format.ts";
import { actionFailure } from "../lib/query-state.ts";
import { usePanelUi } from "../stores/panelStore.ts";

type DepFilter = "all" | "flagged" | "direct" | "pending";
const PAGE = 100;

/** The rollup of a repo that has never been scanned: a set of nothing. Zeroes
 * rather than null, so the rail, the tiles and the counters read one shape and no
 * consumer branches on "is there a set" to answer "how many are dangerous". The
 * "never scanned" vs "nothing to audit" distinction is made ONCE, from `set`
 * itself, where it actually lives. */
const NO_SET_ROLLUP = {
  outcome: null,
  total: 0,
  safe: 0,
  dangerous: 0,
  error: 0,
  pending: 0,
  cached: 0,
} as const;

const DEP_FILTERS: { key: DepFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "flagged", label: "Flagged" },
  { key: "direct", label: "Direct" },
  { key: "pending", label: "Pending" },
];

function DepStatusPill({ dep }: { dep: AuditSetItem }) {
  // Outcome first, progress only for the not-concluded case: a null outcome
  // ALWAYS resolves itself (a job is live), so it gets a spinner and never the
  // "Audit failed" copy — that belongs to ERROR, which needs a retry.
  if (dep.outcome) return <OutcomePill outcome={dep.outcome} />;
  if (dep.jobState === "running")
    return (
      <span className="pill pill--running">
        <span className="spinner" aria-hidden="true" /> Auditing
      </span>
    );
  return <span className="pill">Queued</span>;
}

export function RepoDetail() {
  const params = useParams<{ owner: string; name: string }>();
  const owner = params.owner ?? "";
  const name = params.name ?? "";
  const navigate = useNavigate();

  const state = useRepoDetail(owner, name);
  const detail = state.status === "ok" ? state.data : null;
  const triggerScan = useTriggerScan();
  const setProtect = useSetProtect();
  const resync = useResync();
  const paywall = usePanelUi((s) => s.paywall);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DepFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const inventoryRef = useRef<HTMLElement | null>(null);

  // ONE stream per live set, writing into the query cache: a dep frame REPLACES
  // the matching item (the frame carries the whole contract item, not a lossier
  // subset), a progress frame replaces the set's status + rollup, and the
  // terminal frame invalidates so the authoritative response lands. Every frame
  // is a snapshot, so a Last-Event-ID replay is idempotent without a seq guard.
  useRepoDetailStream(owner, name, detail?.set?.status === "running" ? detail.set.id : null);

  useEffect(() => {
    setQuery("");
    setFilter("all");
    setVisibleCount(PAGE);
  }, [owner, name]);

  useEffect(() => {
    setVisibleCount(PAGE);
  }, [query, filter]);

  const deps = useMemo(() => detail?.deps ?? [], [detail]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return deps
      .filter((dep) => {
        // "Flagged" is what needs a human: confirmed danger, or an audit that
        // could not conclude. A pending dep is neither — it resolves itself.
        if (filter === "flagged" && dep.outcome !== "DANGEROUS" && dep.outcome !== "ERROR")
          return false;
        if (filter === "direct" && !dep.direct) return false;
        if (filter === "pending" && dep.outcome !== null) return false;
        if (q && !`${dep.name}@${dep.version}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          depPriority(a) - depPriority(b) ||
          Number(b.direct) - Number(a.direct) ||
          a.name.localeCompare(b.name),
      );
  }, [deps, filter, query]);

  const queueDeps = useMemo(
    () =>
      deps
        .filter((dep) => dep.outcome === "DANGEROUS" || dep.outcome === "ERROR")
        .sort((a, b) => depPriority(a) - depPriority(b) || a.name.localeCompare(b.name))
        .slice(0, 4),
    [deps],
  );

  if (state.status === "loading") {
    return (
      <div className="page__inner" aria-busy="true">
        <div className="empty-state" role="status">
          <span className="spinner" /> Loading repository…
        </div>
      </div>
    );
  }

  // A repo we cannot read is a FAILED read, not an empty one — which is why this
  // is a degraded surface and not the `empty-state` box it used to be. The
  // distinction matters most in exactly this case: "no dependencies" and "we
  // could not see this repository" look identical in a grey box.
  //
  // A 404 offers no retry (there is nothing to retry into) but does offer a way
  // out; anything else offers the retry the query itself provides.
  if (state.status === "failed" || detail === null) {
    const failure =
      state.status === "failed"
        ? state.failure
        : { what: `${owner}/${name}`, detail: "The repository detail could not be read." };
    return (
      <div className="page__inner">
        <DegradedSurface failure={failure} escape={{ label: "Back to dashboard", href: "/dashboard" }} />
      </div>
    );
  }

  const repo = detail.repo;
  const scan = detail.set;
  const alerts = detail.alerts;
  // One banner over three mutations: each holds its own error, and a cap is
  // filtered out because the paywall dialog owns it.
  const actionFailed =
    actionFailure(triggerScan.error, "Starting the audit") ??
    actionFailure(setProtect.error, "Changing protection") ??
    actionFailure(resync.error, "Re-syncing the lockfile");
  const busy = triggerScan.isPending || setProtect.isPending || resync.isPending;

  // The ONE rollup, computed server-side over THIS SET's items — the same
  // population `deps` carries, so summing deps reproduces it. The client used to
  // recompute these counters from `deps` while the engine sent a rollup over the
  // repo's dep INDEX: three implementations of one sum over two populations.
  const rollup = scan?.rollup ?? NO_SET_ROLLUP;
  const running = scan?.status === "running";
  const completed = rollup.total - rollup.pending;
  const pct = rollup.total > 0 ? Math.round((completed / rollup.total) * 100) : 0;
  const flagged = rollup.dangerous + rollup.error;
  const checked = completed;

  const lastScanCopy = scan
    ? `Last ${scan.trigger} scan started ${formatDate(scan.startedAt)}`
    : "Run the first audit to establish a dependency baseline.";

  let overview: { label: string; tone: Tone; copy: string };
  if (running) {
    overview = {
      label: `Scan in progress · ${pct}%`,
      tone: "running",
      copy: `${pct}% complete · ${rollup.cached} results reused from cache`,
    };
  } else if (scan === null || rollup.total === 0) {
    overview = {
      label: scan === null ? "Not audited" : "Nothing to audit",
      tone: "unknown",
      copy:
        scan === null
          ? "Run the first audit to establish a dependency baseline."
          : "This commit's lockfile declares no npm dependencies.",
    };
  } else if (rollup.dangerous > 0) {
    overview = { label: "Action required", tone: "danger", copy: lastScanCopy };
  } else if (rollup.error > 0) {
    // Severity DANGEROUS > ERROR > SAFE: audits that could not conclude are a
    // coverage gap, so this repo is NOT reported as having no known threats.
    overview = {
      label: `${rollup.error} could not be audited`,
      tone: "error",
      copy: lastScanCopy,
    };
  } else if (rollup.pending > 0) {
    overview = { label: "Coverage incomplete", tone: "unknown", copy: lastScanCopy };
  } else {
    overview = { label: "No known threats", tone: "safe", copy: lastScanCopy };
  }

  // The four buckets partition the set (safe + dangerous + error + pending ==
  // total), so the rail is a true proportion rather than an overlapping tally.
  const railSegments: { key: string; tone: Tone; count: number }[] = [
    { key: "dangerous", tone: "danger", count: rollup.dangerous },
    { key: "error", tone: "error", count: rollup.error },
    { key: "pending", tone: running ? "running" : "unknown", count: rollup.pending },
    { key: "safe", tone: "safe", count: rollup.safe },
  ];

  const tiles: { label: string; value: number; tone: Tone }[] = [
    { label: "Dangerous", value: rollup.dangerous, tone: "danger" },
    { label: "Audit failed", value: rollup.error, tone: "error" },
    { label: "Safe", value: rollup.safe, tone: "safe" },
    { label: "Pending", value: rollup.pending, tone: running ? "running" : "unknown" },
  ];

  const filterCounts: Record<DepFilter, number> = {
    all: deps.length,
    flagged,
    direct: deps.filter((dep) => dep.direct).length,
    pending: rollup.pending,
  };

  // No hand-written reload and no local re-derivation of what succeeded: each
  // mutation's `onSuccess` already patches or invalidates the entries it
  // invalidated, so a successful protect flips the flag everywhere it is shown
  // and a failed one flips nothing.
  const dismissActionFailure = () => {
    triggerScan.reset();
    setProtect.reset();
    resync.reset();
  };

  const reviewFlagged = () => {
    setFilter("flagged");
    inventoryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="page__inner">
      <button
        type="button"
        className="btn btn--bare btn--sm panel-back"
        onClick={() => navigate("/dashboard")}
      >
        <ArrowLeft size={14} /> Dashboard
      </button>

      <header className="panel-detail-head fade-up">
        <div>
          <span className="microtext">{repo.owner}</span>
          <h1 className="headline headline--lg">{repo.name}</h1>
          <div className="panel-detail-head__meta">
            <span className="microtext mono">{repo.defaultBranch}</span>
            {repo.private && <span className="tag">Private</span>}
            <span className={`tag${repo.protected ? " tag--violet" : ""}`}>
              {repo.protected ? "Continuous protection" : "Manual monitoring"}
            </span>
          </div>
        </div>
        <div className="panel-detail-head__actions">
          <button
            type="button"
            className="btn btn--dark"
            disabled={running || busy}
            onClick={() => triggerScan.mutate(repo.id)}
          >
            {triggerScan.isPending
              ? "Starting…"
              : running
                ? "Scanning…"
                : scan
                  ? "Run audit again"
                  : "Run first audit"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setProtect.mutate({ repoId: repo.id, on: !repo.protected })}
          >
            {repo.protected ? <ShieldCheck size={14} /> : <Shield size={14} />}
            {repo.protected ? "Protected" : "Protect"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || running}
            title="Re-read the lockfile from GitHub"
            onClick={() => resync.mutate(repo.id)}
          >
            <RefreshCw size={14} /> {resync.isPending ? "Re-syncing…" : "Re-sync"}
          </button>
        </div>
      </header>

      {actionFailed && (
        <div className="banner banner--danger panel-banner-gap" role="alert">
          <span>{`${actionFailed.what} failed — ${actionFailed.detail ?? "no detail"}`}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Dismiss error"
            onClick={dismissActionFailure}
          >
            <X size={13} />
          </button>
        </div>
      )}

      <section
        className="card card--accent panel-overview"
        style={{ "--accent": toneAccent(overview.tone) } as CSSProperties}
        aria-label="Audit posture"
      >
        <div className="panel-overview__head">
          <div>
            <h2 className="headline panel-overview__label">{overview.label}</h2>
            <p className="subtext">
              {checked} of {rollup.total} dependencies checked
            </p>
          </div>
          <p className="microtext">{overview.copy}</p>
        </div>
        <div
          className="rail"
          role="img"
          aria-label={`${rollup.dangerous} dangerous, ${rollup.error} could not be audited, ${rollup.safe} safe, ${rollup.pending} pending`}
        >
          {railSegments
            .filter((segment) => segment.count > 0)
            .map((segment) => (
              <span
                key={segment.key}
                className={`rail__seg rail__seg--${segment.tone}`}
                style={{ flexGrow: segment.count }}
              />
            ))}
        </div>
        <div className="panel-tiles">
          {tiles.map((tile) => (
            <div key={tile.label} className="panel-tile">
              <span className="panel-tile__value mono">{tile.value}</span>
              <span className="panel-tile__label">
                <span className={toneDotClass(tile.tone)} />
                <span className="eyebrow eyebrow--faint">{tile.label}</span>
              </span>
            </div>
          ))}
        </div>
      </section>

      {flagged > 0 && (
        <section className="panel-section" aria-label="Review queue">
          <div className="section-title">
            <span className="eyebrow eyebrow--danger">Review queue</span>
            <span className="microtext">
              {flagged} flagged {flagged === 1 ? "dependency" : "dependencies"}
            </span>
            <button
              type="button"
              className="btn btn--sm panel-queue__jump"
              onClick={reviewFlagged}
            >
              Review flagged
            </button>
          </div>
          <div className="card panel-queue">
            {alerts.length > 0
              ? alerts.slice(0, 4).map((alert) => (
                  <button
                    key={alert.id}
                    type="button"
                    className="panel-queue__row"
                    onClick={() => navigate(`/package/${alert.packageName}`)}
                  >
                    <span className={toneDotClass(outcomeTone(alert.outcome))} />
                    <span className="mono">
                      {alert.packageName}@{alert.version}
                    </span>
                    <OutcomePill outcome={alert.outcome} />
                    <span className="microtext panel-queue__meta">
                      {alert.origin} · {formatDate(alert.createdAt)}
                    </span>
                  </button>
                ))
              : queueDeps.map((dep) => (
                  <button
                    key={`${dep.name}@${dep.version}`}
                    type="button"
                    className="panel-queue__row"
                    onClick={() => navigate(`/package/${dep.name}`)}
                  >
                    <span className={toneDotClass(depTone(dep))} />
                    <span className="mono">
                      {dep.name}@{dep.version}
                    </span>
                    {dep.outcome && <OutcomePill outcome={dep.outcome} />}
                    <span className="microtext panel-queue__meta">
                      {dep.direct ? "Direct" : "Transitive"}
                    </span>
                  </button>
                ))}
          </div>
        </section>
      )}

      <section className="panel-section" aria-label="Dependency inventory" ref={inventoryRef}>
        <div className="section-title">
          <span className="eyebrow eyebrow--faint">Dependency inventory</span>
          <span className="microtext mono">{filtered.length}</span>
        </div>
        {deps.length === 0 ? (
          <div className="empty-state">
            <strong>No dependency baseline yet</strong>
            <span>Run an audit to index this repository&apos;s lockfile.</span>
          </div>
        ) : (
          <>
            <div className="panel-toolbar">
              <div className="panel-search">
                <Search size={14} aria-hidden="true" />
                <input
                  className="input"
                  type="search"
                  placeholder="Search dependencies"
                  aria-label="Search dependencies"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="panel-filters" role="group" aria-label="Filter dependencies">
                {DEP_FILTERS.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    className={`btn btn--sm panel-filter${filter === entry.key ? " active" : ""}`}
                    aria-pressed={filter === entry.key}
                    onClick={() => setFilter(entry.key)}
                  >
                    {entry.label}{" "}
                    <span className="mono panel-filter__count">{filterCounts[entry.key]}</span>
                  </button>
                ))}
              </div>
            </div>
            {filtered.length === 0 ? (
              <div className="empty-state">
                <strong>No dependencies match this view</strong>
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
              <div className="card panel-inventory">
                <div className="panel-tablewrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Package</th>
                        <th>Version</th>
                        <th>Source</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, visibleCount).map((dep) => (
                        <tr key={`${dep.name}@${dep.version}`}>
                          <td>
                            <div className="panel-dep">
                              <span className={toneDotClass(depTone(dep))} />
                              <div className="panel-dep__id">
                                {/* A report page exists only where an audit
                                    CONCLUDED with a verdict — an ERROR dep has
                                    no report to link to. */}
                                {dep.outcome === "SAFE" || dep.outcome === "DANGEROUS" ? (
                                  <Link className="mono panel-link" to={`/package/${dep.name}`}>
                                    {dep.name}
                                  </Link>
                                ) : (
                                  <span className="mono">{dep.name}</span>
                                )}
                                {dep.range && (
                                  <span className="microtext mono">{dep.range}</span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="mono">{dep.version}</td>
                          <td>{dep.direct ? "Direct" : "Transitive"}</td>
                          <td>
                            <DepStatusPill dep={dep} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {filtered.length > visibleCount && (
                  <div className="panel-inventory__more">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => setVisibleCount((count) => count + PAGE)}
                    >
                      Load 100 more
                    </button>
                    <span className="microtext">
                      Showing {Math.min(visibleCount, filtered.length)} of {filtered.length}
                    </span>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <AnimatePresence>{paywall && <UpgradeDialog key="paywall" />}</AnimatePresence>
    </div>
  );
}
