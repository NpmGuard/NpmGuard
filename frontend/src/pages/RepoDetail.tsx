import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { usePanelStore } from "../stores/panelStore";
import type { RepoDep, RepoDetailPayload } from "../lib/panel-types";

const API_BASE = "/api";

type Filter = "all" | "flagged" | "direct" | "pending";

function verdictColor(verdict: string | null): string {
  switch (verdict) {
    case "DANGEROUS":
      return "var(--danger)";
    case "SUSPECT":
      return "var(--suspected)";
    case "SAFE":
      return "var(--safe)";
    default:
      return "var(--pending)";
  }
}

function rollupBg(verdict: string | null): string {
  switch (verdict) {
    case "DANGEROUS":
      return "var(--danger-bg)";
    case "SUSPECT":
      return "var(--suspected-bg)";
    case "SAFE":
      return "var(--safe-bg)";
    default:
      return "var(--bg-secondary)";
  }
}

export function RepoDetail() {
  const { owner, name } = useParams<{ owner: string; name: string }>();
  const navigate = useNavigate();
  const fetchRepoDetail = usePanelStore((s) => s.fetchRepoDetail);
  const triggerScan = usePanelStore((s) => s.triggerScan);
  const setProtect = usePanelStore((s) => s.setProtect);
  const resync = usePanelStore((s) => s.resync);

  const [detail, setDetail] = useState<RepoDetailPayload | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    if (!owner || !name) return;
    const d = await fetchRepoDetail(owner, name);
    if (!d) {
      setNotFound(true);
      return;
    }
    setDetail(d);
  }, [owner, name, fetchRepoDetail]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live progress: subscribe to the scan SSE stream while a scan is running.
  // Events: {type:"progress", ...counts}, {type:"dep", name, version, verdict},
  // {type:"done"} — then one final reload for the authoritative rollup.
  useEffect(() => {
    const scan = detail?.scan;
    if (!scan || scan.status !== "running" || esRef.current) return;

    const es = new EventSource(`${API_BASE}/panel/scan/${scan.id}/events`);
    esRef.current = es;

    es.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data);
        if (event.type === "dep") {
          setDetail((d) =>
            d
              ? {
                  ...d,
                  deps: d.deps.map((dep) =>
                    dep.name === event.name && dep.version === event.version
                      ? { ...dep, verdict: event.verdict, jobState: event.jobState ?? null }
                      : dep,
                  ),
                }
              : d,
          );
        } else if (event.type === "progress") {
          setDetail((d) =>
            d && d.scan
              ? {
                  ...d,
                  scan: {
                    ...d.scan,
                    cached: event.cached,
                    audited: event.audited,
                    failed: event.failed,
                    total: event.total,
                  },
                }
              : d,
          );
        } else if (event.type === "done") {
          es.close();
          esRef.current = null;
          void load();
        }
      } catch {
        // malformed event — ignore
      }
    };
    es.onerror = () => {
      es.close();
      esRef.current = null;
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [detail?.scan?.id, detail?.scan?.status, load]); // eslint-disable-line react-hooks/exhaustive-deps

  if (notFound) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", color: "var(--text-muted)" }}
      >
        Repo not found — is the NpmGuard app installed on it?
      </div>
    );
  }

  if (!detail) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}
      >
        loading…
      </div>
    );
  }

  const { repo, deps, rollup, scan, alerts } = detail;
  const running = scan?.status === "running";
  const progress = scan ? scan.cached + scan.audited + scan.failed : 0;

  const filtered = deps.filter((d) => {
    if (search && !`${d.name}@${d.version}`.includes(search)) return false;
    switch (filter) {
      case "flagged":
        return d.verdict === "DANGEROUS" || d.verdict === "SUSPECT";
      case "direct":
        return d.direct;
      case "pending":
        return d.verdict === null;
      default:
        return true;
    }
  });

  return (
    <div className="flex-1 overflow-y-auto" style={{ padding: "24px var(--header-px)" }}>
      {/* Breadcrumb + actions */}
      <div className="flex items-center gap-3" style={{ marginBottom: 16 }}>
        <button
          onClick={() => navigate("/dashboard")}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            color: "var(--text-muted)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: 0,
          }}
        >
          ← dashboard
        </button>
        <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "1.05rem", fontWeight: 700 }}>
          {repo.fullName}
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={async () => {
              const scanId = await triggerScan(repo.id);
              if (scanId) void load();
            }}
            disabled={running}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              padding: "4px 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--accent)",
              background: "transparent",
              color: "var(--accent-light)",
              cursor: "pointer",
              opacity: running ? 0.5 : 1,
            }}
          >
            {running ? "scanning…" : "Audit now"}
          </button>
          <button
            onClick={async () => {
              const ok = await setProtect(repo.id, !repo.protected);
              if (ok) void load();
            }}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              padding: "4px 12px",
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${repo.protected ? "var(--safe)" : "var(--border-strong)"}`,
              background: "transparent",
              color: repo.protected ? "var(--safe)" : "var(--text)",
              cursor: "pointer",
            }}
          >
            {repo.protected ? "Protected ✓" : "Protect"}
          </button>
          <button
            onClick={async () => {
              await resync(repo.id);
              void load();
            }}
            title="Re-read the lockfile from GitHub and reconcile"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              padding: "4px 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Re-sync
          </button>
        </div>
      </div>

      {/* Rollup banner */}
      <div
        style={{
          border: `1px solid ${rollup.verdict ? verdictColor(rollup.verdict) : "var(--border)"}`,
          background: rollupBg(rollup.verdict),
          borderRadius: "var(--radius)",
          padding: "16px 20px",
          marginBottom: 16,
          fontFamily: "var(--font-mono)",
        }}
      >
        <div className="flex items-center gap-4">
          <span style={{ fontSize: "1.2rem", fontWeight: 700, color: verdictColor(rollup.verdict) }}>
            {running ? "SCANNING" : (rollup.verdict ?? "NO DATA")}
          </span>
          <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {rollup.dangerous} dangerous · {rollup.suspect} suspect · {rollup.unknown} unknown ·{" "}
            {rollup.safe} safe
          </span>
          {scan && (
            <span className="ml-auto" style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
              {running
                ? `${progress}/${scan.total} checked (${scan.cached} cached)`
                : `last scan: ${scan.trigger} · ${new Date(scan.startedAt).toLocaleString()}`}
            </span>
          )}
        </div>
        {scan?.status === "failed" && (
          <div style={{ marginTop: 8, fontSize: "0.75rem", color: "var(--danger)" }}>
            Scan failed{scan.verdict ? "" : ""} — check that the repo has a supported lockfile
            (package-lock.json, pnpm-lock.yaml, yarn.lock) and try again.
          </div>
        )}
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div
          style={{
            border: "1px solid var(--danger)",
            background: "var(--danger-bg)",
            borderRadius: "var(--radius-sm)",
            padding: "10px 14px",
            marginBottom: 16,
            fontFamily: "var(--font-mono)",
            fontSize: "0.75rem",
          }}
        >
          {alerts.slice(0, 5).map((a) => (
            <div key={a.id} style={{ padding: "2px 0" }}>
              <span style={{ color: verdictColor(a.verdict) }}>{a.verdict}</span>{" "}
              <a
                href={`/package/${encodeURIComponent(a.packageName)}`}
                style={{ color: "var(--accent-light)" }}
              >
                {a.packageName}@{a.version}
              </a>{" "}
              <span style={{ color: "var(--text-muted)" }}>
                ({a.kind}, {new Date(a.createdAt).toLocaleString()})
              </span>
              {a.message ? <span style={{ color: "var(--text-muted)" }}> — {a.message}</span> : null}
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
        {(["all", "flagged", "direct", "pending"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
              padding: "3px 10px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: filter === f ? "var(--bg-secondary)" : "transparent",
              color: filter === f ? "var(--accent-light)" : "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {f}
          </button>
        ))}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="filter packages…"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.72rem",
            padding: "4px 10px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            color: "var(--text)",
            outline: "none",
            width: 220,
          }}
        />
        <span className="ml-auto" style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-muted)" }}>
          {filtered.length}/{deps.length} packages
        </span>
      </div>

      {/* Dep table */}
      {deps.length === 0 ? (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.8rem",
            color: "var(--text-muted)",
            border: "1px dashed var(--border)",
            borderRadius: "var(--radius)",
            padding: "36px",
            textAlign: "center",
          }}
        >
          No dependency data yet — run an audit.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              <th style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)" }}>package</th>
              <th style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)" }}>version</th>
              <th style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)" }}>type</th>
              <th style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)" }}>verdict</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((dep: RepoDep) => (
              <tr key={`${dep.name}@${dep.version}`}>
                <td style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)" }}>
                  {dep.verdict ? (
                    <a
                      href={`/package/${encodeURIComponent(dep.name)}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`/package/${encodeURIComponent(dep.name)}`);
                      }}
                      style={{ color: "var(--text)", textDecoration: "none" }}
                    >
                      {dep.name}
                    </a>
                  ) : (
                    dep.name
                  )}
                </td>
                <td style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>
                  {dep.version}
                </td>
                <td style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)" }}>
                  {dep.direct ? "direct" : "transitive"}
                </td>
                <td style={{ padding: "5px 10px", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ color: verdictColor(dep.verdict) }}>
                    {dep.verdict ??
                      (dep.jobState === "failed"
                        ? "audit failed"
                        : dep.jobState === "running"
                          ? "auditing…"
                          : "queued")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
