import { useState, useEffect } from "react";
import { ReportView } from "./ReportView";
import { trailFromTrace } from "../lib/report-helpers";
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
    trace?: Array<{
      phase: string;
      durationMs: number;
      input?: Record<string, unknown>;
      output?: Record<string, unknown>;
    }>;
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
  const trail = trailFromTrace(report.trace ?? []);

  return (
    <ReportView
      packageName={packageName}
      version={version}
      verdict={report.verdict}
      capabilities={report.capabilities}
      findings={report.findings}
      proofs={report.proofs}
      trail={trail}
    />
  );
}
