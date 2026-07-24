/** Repository detail: overview posture, review queue, and the full
 * dependency inventory. While a scan is running it holds ONE scan-events
 * SSE stream (unnamed messages: dep diffs, progress ticks, done). */

import { ArrowLeft, RefreshCw, Search, Shield, ShieldCheck, X } from "lucide-react";
import { AnimatePresence } from "motion/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Link, useNavigate, useParams } from "react-router";
import { UpgradeDialog } from "../components/panel/UpgradeDialog.tsx";
import {
  VerdictPill,
  toneAccent,
  toneDotClass,
  verdictTone,
  type Tone,
} from "../components/panel/tone.tsx";
import { ApiError } from "../lib/api-base.ts";
import type { DepDetail, RepoDetailResponse } from "../lib/engine-types.ts";
import { formatDate } from "../lib/format.ts";
import { scanEventsUrl } from "../lib/panel-api.ts";
import { connectScanStream } from "../lib/sse.ts";
import { usePanelStore } from "../stores/panelStore.ts";

type DepFilter = "all" | "flagged" | "direct" | "pending";
const PAGE = 100;

const DEP_FILTERS: { key: DepFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "flagged", label: "Flagged" },
  { key: "direct", label: "Direct" },
  { key: "pending", label: "Pending" },
];

/** Severity-first sort rank: DANGEROUS > SUSPECT > failed > running >
 * pending > UNKNOWN > SAFE. */
function depPriority(dep: DepDetail): number {
  if (dep.verdict === "DANGEROUS") return 0;
  if (dep.verdict === "SUSPECT") return 1;
  if (dep.verdict === null) {
    if (dep.jobState === "failed") return 2;
    if (dep.jobState === "running") return 3;
    return 4;
  }
  if (dep.verdict === "UNKNOWN") return 5;
  return 6;
}

function depTone(dep: DepDetail): Tone {
  if (dep.verdict) return verdictTone(dep.verdict);
  if (dep.jobState === "running") return "running";
  if (dep.jobState === "failed") return "danger";
  return "unknown";
}

function DepStatusPill({ dep }: { dep: DepDetail }) {
  if (dep.verdict) return <VerdictPill verdict={dep.verdict} />;
  if (dep.jobState === "failed") return <span className="pill pill--danger">Audit failed</span>;
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

  const fetchRepoDetail = usePanelStore((s) => s.fetchRepoDetail);
  const triggerScan = usePanelStore((s) => s.triggerScan);
  const setProtect = usePanelStore((s) => s.setProtect);
  const resync = usePanelStore((s) => s.resync);
  const clearRepoActionError = usePanelStore((s) => s.clearRepoActionError);
  const repoActionErrors = usePanelStore((s) => s.repoActionErrors);
  const paywall = usePanelStore((s) => s.paywall);

  const [detail, setDetail] = useState<RepoDetailResponse | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"audit" | "protect" | "resync" | null>(null);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DepFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const inventoryRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchRepoDetail(owner, name);
      setDetail(data);
      setLoadError(null);
      setPhase("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setPhase("missing");
        return;
      }
      setLoadError(err instanceof Error ? err.message : "Could not load the repository");
      setPhase("error");
    }
  }, [owner, name, fetchRepoDetail]);

  useEffect(() => {
    setDetail(null);
    setPhase("loading");
    setQuery("");
    setFilter("all");
    setVisibleCount(PAGE);
    void load();
  }, [load]);

  useEffect(() => {
    setVisibleCount(PAGE);
  }, [query, filter]);

  // ONE scan stream per running scan id: dep messages patch the matching
  // dep in place, progress patches counters, done triggers a full reload.
  const runningScanId = detail?.scan?.status === "running" ? detail.scan.id : null;
  useEffect(() => {
    if (runningScanId === null) return;
    const handle = connectScanStream(scanEventsUrl(runningScanId), {
      onMessage(message) {
        if (message.type === "dep") {
          setDetail(
            (current) =>
              current && {
                ...current,
                deps: current.deps.map((dep) =>
                  dep.name === message.name && dep.version === message.version
                    ? {
                        ...dep,
                        verdict: message.verdict,
                        verdictReason: message.verdictReason,
                        evidenceCount: message.evidenceCount,
                        jobState: message.jobState,
                      }
                    : dep,
                ),
              },
          );
        } else if (message.type === "progress") {
          setDetail((current) =>
            current && current.scan
              ? {
                  ...current,
                  scan: {
                    ...current.scan,
                    total: message.total,
                    cached: message.cached,
                    audited: message.audited,
                    failed: message.failed,
                  },
                }
              : current,
          );
        } else {
          handle.close();
          void load();
        }
      },
      onError() {
        // Degrade silently — a manual refresh or re-entry recovers.
      },
    });
    return () => handle.close();
  }, [runningScanId, load]);

  const deps = useMemo(() => detail?.deps ?? [], [detail]);

  const counts = useMemo(() => {
    let dangerous = 0;
    let suspect = 0;
    let unknown = 0;
    let safe = 0;
    let pending = 0;
    for (const dep of deps) {
      if (dep.verdict === "DANGEROUS") dangerous += 1;
      else if (dep.verdict === "SUSPECT") suspect += 1;
      else if (dep.verdict === "UNKNOWN") unknown += 1;
      else if (dep.verdict === "SAFE") safe += 1;
      else pending += 1;
    }
    return { dangerous, suspect, unknown, safe, pending };
  }, [deps]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return deps
      .filter((dep) => {
        if (filter === "flagged" && dep.verdict !== "DANGEROUS" && dep.verdict !== "SUSPECT")
          return false;
        if (filter === "direct" && !dep.direct) return false;
        if (filter === "pending" && dep.verdict !== null) return false;
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
        .filter((dep) => dep.verdict === "DANGEROUS" || dep.verdict === "SUSPECT")
        .sort((a, b) => depPriority(a) - depPriority(b) || a.name.localeCompare(b.name))
        .slice(0, 4),
    [deps],
  );

  if (phase === "loading") {
    return (
      <div className="page__inner">
        <div className="empty-state" role="status">
          <span className="spinner" /> Loading repository…
        </div>
      </div>
    );
  }

  if (phase === "missing") {
    return (
      <div className="page__inner">
        <div className="empty-state">
          <strong>Repository unavailable</strong>
          <span>Check that the NpmGuard GitHub App still has access to this repository.</span>
          <button type="button" className="btn" onClick={() => navigate("/dashboard")}>
            <ArrowLeft size={14} /> Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  if (phase === "error" || !detail) {
    return (
      <div className="page__inner">
        <div className="banner banner--danger panel-banner-gap" role="alert">
          <span>{loadError ?? "Could not load the repository"}</span>
          <button type="button" className="btn btn--sm" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const repo = detail.repo;
  const scan = detail.scan;
  const alerts = detail.alerts;
  const actionError = repoActionErrors[repo.id];

  const running = scan?.status === "running";
  const completed = scan ? scan.cached + scan.audited + scan.failed : 0;
  const pct = scan && scan.total > 0 ? Math.round((completed / scan.total) * 100) : 0;
  const flagged = counts.dangerous + counts.suspect;
  const checked = deps.length - counts.pending;

  const lastScanCopy = scan
    ? `Last ${scan.trigger} scan started ${formatDate(scan.startedAt)}`
    : "Run the first audit to establish a dependency baseline.";

  let overview: { label: string; tone: Tone; copy: string };
  if (running && scan) {
    overview = {
      label: `Scan in progress · ${pct}%`,
      tone: "running",
      copy: `${pct}% complete · ${scan.cached} results reused from cache`,
    };
  } else if (scan?.status === "failed") {
    overview = {
      label: "Scan interrupted",
      tone: "danger",
      copy: "Re-sync the lockfile, then run the audit again.",
    };
  } else if (!scan && deps.length === 0) {
    overview = {
      label: "Not audited",
      tone: "unknown",
      copy: "Run the first audit to establish a dependency baseline.",
    };
  } else if (counts.dangerous > 0) {
    overview = { label: "Action required", tone: "danger", copy: lastScanCopy };
  } else if (counts.suspect > 0) {
    overview = { label: "Review recommended", tone: "suspect", copy: lastScanCopy };
  } else if (counts.pending > 0 || counts.unknown > 0) {
    overview = { label: "Coverage incomplete", tone: "unknown", copy: lastScanCopy };
  } else {
    overview = { label: "No known threats", tone: "safe", copy: lastScanCopy };
  }

  const railSegments: { key: string; tone: Tone; count: number }[] = [
    { key: "dangerous", tone: "danger", count: counts.dangerous },
    { key: "suspect", tone: "suspect", count: counts.suspect },
    { key: "pending", tone: running ? "running" : "unknown", count: counts.pending },
    { key: "unknown", tone: "unknown", count: counts.unknown },
    { key: "safe", tone: "safe", count: counts.safe },
  ];

  const tiles: { label: string; value: number; tone: Tone }[] = [
    { label: "Dangerous", value: counts.dangerous, tone: "danger" },
    { label: "Suspect", value: counts.suspect, tone: "suspect" },
    { label: "Unknown", value: counts.unknown, tone: "unknown" },
    { label: "Safe", value: counts.safe, tone: "safe" },
    { label: "Pending", value: counts.pending, tone: running ? "running" : "unknown" },
  ];

  const filterCounts: Record<DepFilter, number> = {
    all: deps.length,
    flagged,
    direct: deps.filter((dep) => dep.direct).length,
    pending: counts.pending,
  };

  const runAudit = async () => {
    setBusy("audit");
    const scanId = await triggerScan(repo.id);
    setBusy(null);
    if (scanId !== null) void load();
  };

  const toggleProtect = async () => {
    const next = !repo.protected;
    const paywallBefore = usePanelStore.getState().paywall;
    setBusy("protect");
    await setProtect(repo.id, next);
    setBusy(null);
    const state = usePanelStore.getState();
    if (!state.repoActionErrors[repo.id] && state.paywall === paywallBefore) {
      setDetail(
        (current) => current && { ...current, repo: { ...current.repo, protected: next } },
      );
    }
  };

  const doResync = async () => {
    setBusy("resync");
    const scanId = await resync(repo.id);
    setBusy(null);
    if (scanId !== null) void load();
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
            disabled={running || busy !== null}
            onClick={() => void runAudit()}
          >
            {busy === "audit"
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
            disabled={busy !== null}
            onClick={() => void toggleProtect()}
          >
            {repo.protected ? <ShieldCheck size={14} /> : <Shield size={14} />}
            {repo.protected ? "Protected" : "Protect"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy !== null || running}
            title="Re-read the lockfile from GitHub"
            onClick={() => void doResync()}
          >
            <RefreshCw size={14} /> {busy === "resync" ? "Re-syncing…" : "Re-sync"}
          </button>
        </div>
      </header>

      {actionError && (
        <div className="banner banner--danger panel-banner-gap" role="alert">
          <span>{actionError.message}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Dismiss error"
            onClick={() => clearRepoActionError(repo.id)}
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
              {checked} of {deps.length} dependencies checked
            </p>
          </div>
          <p className="microtext">{overview.copy}</p>
        </div>
        <div
          className="rail"
          role="img"
          aria-label={`${counts.dangerous} dangerous, ${counts.suspect} suspect, ${counts.unknown} unknown, ${counts.safe} safe, ${counts.pending} pending`}
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
                    <span className={toneDotClass(verdictTone(alert.verdict))} />
                    <span className="mono">
                      {alert.packageName}@{alert.version}
                    </span>
                    <VerdictPill verdict={alert.verdict} />
                    <span className="microtext panel-queue__meta">
                      {alert.kind} · {formatDate(alert.createdAt)}
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
                    {dep.verdict && <VerdictPill verdict={dep.verdict} />}
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
                                {dep.verdict ? (
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
