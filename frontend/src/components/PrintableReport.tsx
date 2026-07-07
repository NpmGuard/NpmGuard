import { useEffect, useState } from "react";
import type { Hypothesis } from "../lib/types";
import { verdictDisplay, countsSummary, HYP_STATE_META, claimKindLabel } from "../lib/types";
import {
  buildCertificate,
  explorerUrl,
  type AuditCertificate,
  type ExportableReport,
} from "../lib/report-export";

/**
 * A linear, printer-friendly rendering of the full audit report. Hidden on
 * screen (display: none); revealed by the @media print stylesheet so window.print()
 * lays out the whole audit on paper rather than the live UI.
 */

export interface PrintableReportProps {
  report: ExportableReport;
}

function HypothesisBlock({ hyp, idx }: { hyp: Hypothesis; idx: number }) {
  const meta = HYP_STATE_META[hyp.state];
  const run = hyp.evidenceRefs.find((r) => r.kind === "run");
  return (
    <section className="print-finding" style={{ pageBreakInside: "avoid", marginBottom: 16 }}>
      <h3 style={{ fontSize: "12pt", margin: "0 0 4px", fontFamily: "var(--font-mono)" }}>
        {idx + 1}. <span style={{ fontWeight: 700 }}>{meta.label.toUpperCase()}</span>{" "}
        <span style={{ color: "#333" }}>{hyp.description || claimKindLabel(hyp.claim.kind)}</span>
      </h3>
      <div style={{ fontSize: "9.5pt", margin: "2px 0 6px", color: "#555" }}>
        claim: {hyp.claim.kind}
        {hyp.claim.gating ? ` · gating: ${hyp.claim.gating}` : ""} · severity: {hyp.severity}
      </div>
      {hyp.resolution?.reason && (
        <p style={{ fontSize: "10pt", lineHeight: 1.45, margin: "4px 0" }}>{hyp.resolution.reason}</p>
      )}
      {hyp.focusFiles.length > 0 && (
        <p style={{ fontSize: "9pt", lineHeight: 1.5, margin: "4px 0", color: "#444", fontFamily: "var(--font-mono)" }}>
          <strong>Files:</strong> {hyp.focusFiles.join(", ")}
        </p>
      )}
      {run && (
        <p style={{ fontSize: "9pt", lineHeight: 1.5, margin: "4px 0", color: "#444", fontFamily: "var(--font-mono)" }}>
          <strong>Evidence:</strong> reproduced in run {run.id}
        </p>
      )}
    </section>
  );
}

export function PrintableReport({ report }: PrintableReportProps) {
  const [cert, setCert] = useState<AuditCertificate | null>(null);

  useEffect(() => {
    let cancelled = false;
    buildCertificate(report)
      .then((c) => {
        if (!cancelled) setCert(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [report]);

  const display = verdictDisplay(report.verdict);
  const stats = countsSummary(report.counts);
  const sorted = [...report.hypotheses].sort(
    (a, b) => HYP_STATE_META[a.state].order - HYP_STATE_META[b.state].order,
  );

  return (
    <div className="print-only-root" aria-hidden="true">
      {/* Header */}
      <header style={{ borderBottom: "2pt solid #000", paddingBottom: 8, marginBottom: 14 }}>
        <div style={{ fontSize: "9pt", color: "#888", fontFamily: "var(--font-mono)", letterSpacing: "0.1em" }}>
          NPMGUARD AUDIT REPORT
        </div>
        <h1 style={{ fontSize: "20pt", margin: "4px 0", fontFamily: "var(--font-mono)" }}>
          {report.packageName}
          {report.version && (
            <span style={{ fontSize: "13pt", color: "#777", marginLeft: 10 }}>v{report.version}</span>
          )}
        </h1>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 6 }}>
          <span style={{ fontSize: "16pt", fontWeight: 800, fontFamily: "var(--font-heading)" }}>
            {display.label}
          </span>
          <span style={{ fontSize: "10pt", color: "#555", fontFamily: "var(--font-mono)" }}>
            {report.rationale || display.note}
          </span>
        </div>
        {stats && (
          <div style={{ marginTop: 6, fontSize: "9pt", color: "#666", fontFamily: "var(--font-mono)" }}>
            {stats}
          </div>
        )}
        {display.isCoverageGap && (
          <div style={{ marginTop: 8, padding: "6px 10px", border: "1pt solid #a67c00", background: "#fff8e1", fontSize: "9.5pt", color: "#7a5c00" }}>
            <strong>Coverage gap.</strong> The analysis could not confirm or refute the open
            hypotheses. Treat this as unreviewed, not safe.
          </div>
        )}
      </header>

      {/* Hypotheses */}
      {sorted.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: "14pt", margin: "0 0 8px", fontFamily: "var(--font-heading)" }}>Hypotheses</h2>
          {sorted.map((h, i) => (
            <HypothesisBlock key={h.hypId} hyp={h} idx={i} />
          ))}
        </section>
      )}

      {/* Audit certificate */}
      {cert && (
        <section
          style={{
            marginTop: 18,
            paddingTop: 10,
            borderTop: "1pt solid #000",
            fontSize: "8.5pt",
            fontFamily: "var(--font-mono)",
            color: "#333",
          }}
        >
          <h2 style={{ fontSize: "11pt", margin: "0 0 6px", fontFamily: "var(--font-heading)" }}>
            Audit certificate
          </h2>
          <table style={{ borderCollapse: "collapse" }}>
            <tbody>
              <CertRow label="Package" value={`${cert.packageName}@${cert.version}`} />
              <CertRow label="Verdict" value={cert.verdict} />
              <CertRow label="Content hash" value={`sha256:${cert.contentHash}`} mono />
              {cert.paymentProof.txHash && (
                <CertRow
                  label="Payment proof"
                  value={`${cert.paymentProof.txHash} (${cert.paymentProof.chain})`}
                  mono
                  link={explorerUrl(cert.paymentProof) ?? undefined}
                />
              )}
              {cert.paymentProof.stripeSessionId && !cert.paymentProof.txHash && (
                <CertRow label="Payment proof" value={`Stripe session ${cert.paymentProof.stripeSessionId.slice(-12)}`} />
              )}
              <CertRow label="Exported at" value={cert.exportedAt} />
            </tbody>
          </table>
          <p style={{ marginTop: 8, fontSize: "8pt", color: "#666", lineHeight: 1.45 }}>
            Verify the payment via the explorer link above, then recompute the SHA-256 hash of the
            raw JSON report from the API to confirm the content hasn't been tampered with.
          </p>
        </section>
      )}
    </div>
  );
}

function CertRow({ label, value, mono = false, link }: { label: string; value: string; mono?: boolean; link?: string }) {
  return (
    <tr>
      <td style={{ padding: "1px 12px 1px 0", color: "#666", verticalAlign: "top", whiteSpace: "nowrap" }}>{label}</td>
      <td style={{ padding: "1px 0", fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)", wordBreak: "break-all" }}>
        {link ? (
          <a href={link} style={{ color: "#000", textDecoration: "underline" }}>{value}</a>
        ) : (
          value
        )}
      </td>
    </tr>
  );
}
