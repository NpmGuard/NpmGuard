import { useState, useEffect } from "react";
import { ReportView } from "./ReportView";
import { trailFromTrace } from "../lib/report-helpers";
import type { Finding, Proof, InstrumentationLog, VerdictEnum } from "../lib/types";

function navigate(href: string) {
  history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

interface ReportData {
  packageName: string;
  version: string;
  report: {
    verdict: VerdictEnum;
    capabilities: string[];
    findings: Finding[];
    proofs: Proof[];
    trace?: Array<{
      phase: string;
      durationMs: number;
      input?: Record<string, unknown>;
      output?: Record<string, unknown>;
    }>;
    runtimeEvidence?: InstrumentationLog | null;
  };
}

export function PackageLookup({ packageName, version: requestedVersion }: { packageName: string; version?: string }) {
  const requestKey = `${packageName}@${requestedVersion ?? "latest"}`;
  const [result, setResult] = useState<{
    key: string;
    status: "loading" | "ready" | "not-found";
    data: ReportData | null;
  }>({ key: requestKey, status: "loading", data: null });

  useEffect(() => {
    const controller = new AbortController();
    const query = requestedVersion ? `?version=${encodeURIComponent(requestedVersion)}` : "";
    fetch(`/api/package/${encodeURIComponent(packageName)}/report${query}`, {
      signal: controller.signal,
    })
      .then((r) => {
        if (r.status === 404) {
          setResult({ key: requestKey, status: "not-found", data: null });
          return null;
        }
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (json) {
          setResult({ key: requestKey, status: "ready", data: json });
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResult({ key: requestKey, status: "not-found", data: null });
      });
    return () => controller.abort();
  }, [packageName, requestKey, requestedVersion]);

  const current = result.key === requestKey
    ? result
    : { key: requestKey, status: "loading" as const, data: null };
  const { data } = current;

  if (current.status === "loading") {
    return (
      <div
        className="flex-1 flex items-center justify-center"
        style={{ color: "var(--text-muted)", fontSize: "0.9rem" }}
      >
        Loading report...
      </div>
    );
  }

  if (current.status === "not-found" || !data) {
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
      runtimeEvidence={report.runtimeEvidence ?? null}
    />
  );
}
