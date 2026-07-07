import { useEffect } from "react";
import { useNavigate } from "react-router";
import { usePanelStore } from "../stores/panelStore";
import type { RepoSummary } from "../lib/panel-types";

const API_BASE = "/api";

function verdictColor(verdict: string | null | undefined): string {
  switch (verdict) {
    case "DANGEROUS":
      return "var(--danger)";
    case "SUSPECT":
      return "var(--suspected)";
    case "SAFE":
      return "var(--safe)";
    default:
      return "var(--text-muted)";
  }
}

function ScanCell({ repo }: { repo: RepoSummary }) {
  const scan = repo.lastScan;
  if (!scan) {
    return <span style={{ color: "var(--text-muted)" }}>never scanned</span>;
  }
  if (scan.status === "running") {
    return (
      <span style={{ color: "var(--investigating)" }}>
        scanning… {scan.cached + scan.audited + scan.failed}/{scan.total}
      </span>
    );
  }
  if (scan.status === "failed") {
    return <span style={{ color: "var(--danger)" }}>scan failed</span>;
  }
  return (
    <span style={{ color: verdictColor(scan.verdict) }}>
      {scan.verdict ?? "done"}
      <span style={{ color: "var(--text-muted)" }}>
        {" "}
        · {scan.total} deps · {new Date(scan.startedAt).toLocaleDateString()}
      </span>
    </span>
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
    loading,
    error,
    capError,
    fetchMe,
    refresh,
    triggerScan,
    setProtect,
  } = usePanelStore();

  useEffect(() => {
    if (!userLoaded) void fetchMe();
  }, [userLoaded, fetchMe]);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  if (!userLoaded) {
    return (
      <div className="flex-1 flex items-center justify-center" style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
        loading…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            background: "var(--bg-secondary)",
            padding: "40px 48px",
            maxWidth: 460,
            textAlign: "center",
          }}
        >
          <h1
            style={{
              fontFamily: "var(--font-heading)",
              fontSize: "1.3rem",
              fontWeight: 700,
              marginBottom: 12,
            }}
          >
            Protect your repositories
          </h1>
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.8rem",
              color: "var(--text-muted)",
              lineHeight: 1.6,
              marginBottom: 24,
            }}
          >
            Sign in with GitHub, pick your repos, and NpmGuard audits every npm
            dependency — then keeps watching for poisoned versions published
            upstream.
          </p>
          <a
            href={`${API_BASE}/auth/github/login`}
            style={{
              display: "inline-block",
              fontFamily: "var(--font-mono)",
              fontSize: "0.85rem",
              padding: "10px 22px",
              borderRadius: "var(--radius-sm)",
              background: "var(--accent)",
              color: "var(--bg)",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            Sign in with GitHub
          </a>
        </div>
      </div>
    );
  }

  const unseenAlerts = alerts.filter((a) => !a.seen);

  return (
    <div className="flex-1 overflow-y-auto" style={{ padding: "24px var(--header-px)" }}>
      <div className="flex items-center gap-3" style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: "var(--font-heading)", fontSize: "1.1rem", fontWeight: 700 }}>
          Repositories
        </h1>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            padding: "3px 10px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text-muted)",
            cursor: "pointer",
          }}
        >
          {loading ? "refreshing…" : "refresh"}
        </button>
        {installUrl && (
          <a
            href={installUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              padding: "5px 14px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--accent)",
              color: "var(--accent-light)",
              textDecoration: "none",
            }}
          >
            + Install GitHub App
          </a>
        )}
      </div>

      {capError && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.78rem",
            border: "1px solid var(--suspected)",
            background: "var(--suspected-bg)",
            borderRadius: "var(--radius-sm)",
            padding: "10px 14px",
            marginBottom: 14,
          }}
        >
          {capError} — beta limits apply. Email{" "}
          <a href="mailto:hello@npmguard.com" style={{ color: "var(--accent-light)" }}>
            hello@npmguard.com
          </a>{" "}
          to raise them.
        </div>
      )}

      {error && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.78rem",
            border: "1px solid var(--danger)",
            background: "var(--danger-bg)",
            borderRadius: "var(--radius-sm)",
            padding: "10px 14px",
            marginBottom: 14,
          }}
        >
          {error}
        </div>
      )}

      {unseenAlerts.length > 0 && (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.78rem",
            border: "1px solid var(--danger)",
            background: "var(--danger-bg)",
            borderRadius: "var(--radius-sm)",
            padding: "10px 14px",
            marginBottom: 14,
          }}
        >
          <strong>{unseenAlerts.length} alert{unseenAlerts.length > 1 ? "s" : ""}:</strong>{" "}
          {unseenAlerts.slice(0, 3).map((a) => `${a.packageName}@${a.version} is ${a.verdict}`).join(" · ")}
          {unseenAlerts.length > 3 ? " · …" : ""}
        </div>
      )}

      {installations.length === 0 && !loading && (
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
          No GitHub App installations yet.{" "}
          {installUrl && (
            <a href={installUrl} style={{ color: "var(--accent-light)" }}>
              Install the NpmGuard app
            </a>
          )}{" "}
          on your org or account and pick the repos to guard.
        </div>
      )}

      {repos.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: "0.78rem" }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              <th style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>repository</th>
              <th style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>last scan</th>
              <th style={{ padding: "6px 10px", borderBottom: "1px solid var(--border)", width: 220 }}>actions</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <tr key={repo.id}>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
                  <button
                    onClick={() => navigate(`/repo/${repo.owner}/${repo.name}`)}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.78rem",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    {repo.fullName}
                  </button>
                  {repo.private && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: "0.62rem",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "1px 6px",
                      }}
                    >
                      private
                    </span>
                  )}
                  {repo.protected && (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: "0.62rem",
                        color: "var(--safe)",
                        border: "1px solid var(--safe)",
                        borderRadius: 8,
                        padding: "1px 6px",
                      }}
                    >
                      protected
                    </span>
                  )}
                </td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
                  <ScanCell repo={repo} />
                </td>
                <td style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
                  <button
                    onClick={async () => {
                      const scanId = await triggerScan(repo.id);
                      if (scanId) navigate(`/repo/${repo.owner}/${repo.name}`);
                    }}
                    disabled={repo.lastScan?.status === "running"}
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                      padding: "4px 12px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--accent)",
                      background: "transparent",
                      color: "var(--accent-light)",
                      cursor: "pointer",
                      marginRight: 8,
                      opacity: repo.lastScan?.status === "running" ? 0.5 : 1,
                    }}
                  >
                    Audit
                  </button>
                  <button
                    onClick={() => void setProtect(repo.id, !repo.protected)}
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
