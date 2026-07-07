import { useMemo } from "react";
import type { VerdictEnum, Hypothesis, HypothesisCounts } from "../lib/types";
import { verdictDisplay, countsSummary } from "../lib/types";
import { HypothesisList } from "./HypothesisList";
import { AuditTrail } from "./AuditTrail";
import type { TrailEntry } from "../lib/report-helpers";
import { PaymentProofBadge, type PaymentProofBadgeProps } from "./PaymentProofBadge";
import { DownloadButton } from "./DownloadButton";
import { CertificateFooter } from "./CertificateFooter";
import { PrintableReport } from "./PrintableReport";
import type { ExportableReport } from "../lib/report-export";

export interface ReportViewProps {
  packageName: string;
  version?: string | null;
  verdict: VerdictEnum | null;
  rationale: string | null;
  counts: HypothesisCounts | null;
  hypotheses: Hypothesis[];
  trail: TrailEntry[];
  /** Optional — when provided, focus-file references become clickable. */
  onSelectFile?: (file: string) => void;
  /** Payment proof — if omitted, the badge auto-reads URL params. */
  paymentProof?: PaymentProofBadgeProps;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportView({
  packageName,
  version,
  verdict,
  rationale,
  counts,
  hypotheses,
  trail,
  onSelectFile,
  paymentProof,
}: ReportViewProps) {
  const display = verdictDisplay(verdict);
  const stats = countsSummary(counts);

  const exportable: ExportableReport = useMemo(
    () => ({ packageName, version, verdict, rationale: rationale ?? "", counts, hypotheses }),
    [packageName, version, verdict, rationale, counts, hypotheses],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 report-view-screen">
      {/* Print-only flat rendering — hidden on screen, revealed by @media print */}
      <PrintableReport report={exportable} />

      {/* Header */}
      <div
        className="shrink-0"
        style={{
          padding: "16px 24px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <h1 style={{ fontFamily: "var(--font-mono)", fontSize: "1.15rem", fontWeight: 700, color: "var(--text)" }}>
            {packageName}
          </h1>
          {version && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-muted)" }}>
              v{version}
            </span>
          )}
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
            <PaymentProofBadge {...(paymentProof ?? {})} />
            <DownloadButton report={exportable} />
          </span>
        </div>

        {/* Verdict line */}
        <div
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
            paddingLeft: 12,
            borderLeft: `3px solid ${display.color}`,
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-heading)",
              fontWeight: 800,
              fontSize: "1rem",
              letterSpacing: "0.04em",
              color: display.color,
            }}
          >
            {display.label}
          </span>
          <span style={{ fontSize: "0.82rem", color: "var(--text-dim)", lineHeight: 1.4 }}>
            {rationale || display.note}
          </span>
          {stats && (
            <span
              style={{
                marginLeft: "auto",
                fontFamily: "var(--font-mono)",
                fontSize: "0.7rem",
                color: "var(--text-muted)",
              }}
            >
              {stats}
            </span>
          )}
        </div>

        {/* Coverage-gap notice — UNKNOWN must never read as a quiet pass */}
        {display.isCoverageGap && (
          <div
            style={{
              marginTop: 10,
              marginLeft: 12,
              padding: "8px 12px",
              background: "var(--suspected-bg)",
              border: "1px solid var(--warning)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.76rem",
              color: "var(--warning)",
              lineHeight: 1.5,
            }}
          >
            <strong>Coverage gap.</strong> The analysis resolved but could not confirm or refute the
            open hypotheses. Treat this as <strong>unreviewed</strong>, not safe.
          </div>
        )}
      </div>

      {/* Hypotheses — the finding surface */}
      <div className="flex-1 flex flex-col min-h-0" style={{ background: "var(--bg-secondary)" }}>
        <HypothesisList hypotheses={hypotheses} onSelectFile={onSelectFile} />
      </div>

      {/* Audit trail */}
      <AuditTrail entries={trail} />

      {/* Audit certificate strip — visible on screen + included in print */}
      <CertificateFooter report={exportable} />
    </div>
  );
}
