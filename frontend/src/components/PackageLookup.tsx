import { useState, useEffect } from "react";
import { ResultsPanel } from "./ResultsPanel";
import type { Finding, Proof } from "../lib/types";

function navigate(href: string) {
  history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

interface ReportData {
  packageName: string;
  version: string;
  report: {
    verdict: "SAFE" | "DANGEROUS";
    capabilities: string[];
    findings: Finding[];
    proofs: Proof[];
  };
}

export function PackageLookup({ packageName }: { packageName: string }) {
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    setLoading(true);
    setNotFound(false);
    setData(null);

    fetch(`/api/package/${encodeURIComponent(packageName)}/report`)
      .then((r) => {
        if (r.status === 404) {
          setNotFound(true);
          setLoading(false);
          return null;
        }
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (json) {
          setData(json);
          setLoading(false);
        }
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });
  }, [packageName]);

  if (loading) {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}
      >
        Loading report...
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div
        className="flex-1 flex flex-col items-center justify-center"
        style={{ padding: 48, gap: 16 }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "1rem",
            color: "var(--text-dim)",
          }}
        >
          This package has not been audited yet.
        </div>
        <button
          type="button"
          onClick={() => navigate("/")}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.8rem",
            fontWeight: 600,
            padding: "8px 20px",
            borderRadius: 6,
            border: "1px solid var(--accent-light)",
            background: "transparent",
            color: "var(--accent-light)",
            cursor: "pointer",
          }}
        >
          Run audit
        </button>
      </div>
    );
  }

  const { report, version } = data;
  const isDangerous = report.verdict === "DANGEROUS";

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ padding: "32px 24px 0" }}>
      {/* Package header */}
      <div style={{ maxWidth: 800, margin: "0 auto", width: "100%" }}>
        <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
          <h1
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "1.3rem",
              fontWeight: 700,
            }}
          >
            {packageName}
          </h1>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              color: "var(--text-muted)",
            }}
          >
            v{version}
          </span>
        </div>

        {/* Verdict banner */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 16px",
            borderRadius: 6,
            marginBottom: 20,
            background: isDangerous ? "var(--danger-bg)" : "var(--safe-bg, rgba(0,200,100,0.08))",
            border: `1px solid ${isDangerous ? "var(--danger)" : "var(--safe)"}`,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              fontWeight: 700,
              color: isDangerous ? "var(--danger)" : "var(--safe)",
            }}
          >
            {report.verdict}
          </span>
          {report.capabilities.length > 0 && (
            <div className="flex items-center gap-1" style={{ flexWrap: "wrap" }}>
              {report.capabilities.map((cap) => (
                <span
                  key={cap}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6rem",
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "var(--bg-tertiary)",
                    color: "var(--text-dim)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {cap}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Findings */}
      <div
        style={{
          maxWidth: 800,
          margin: "0 auto",
          width: "100%",
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          border: "1px solid var(--border)",
          borderRadius: 6,
          marginBottom: 24,
        }}
      >
        <ResultsPanel
          onShowCode={() => {}}
          findings={report.findings}
          proofs={report.proofs}
        />
      </div>

      {/* Action */}
      <div
        style={{
          maxWidth: 800,
          margin: "0 auto 32px",
          width: "100%",
          textAlign: "center",
        }}
      >
        <button
          type="button"
          onClick={() => navigate("/")}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.78rem",
            fontWeight: 600,
            padding: "8px 20px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--bg-secondary)",
            color: "var(--text-dim)",
            cursor: "pointer",
          }}
        >
          Run new audit
        </button>
      </div>
    </div>
  );
}
