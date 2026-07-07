import { useEffect, useState } from "react";
import {
  buildCertificate,
  explorerUrl,
  type AuditCertificate,
  type ExportableReport,
} from "../lib/report-export";

export interface CertificateFooterProps {
  report: ExportableReport;
}

/** Compact certificate strip displayed below the audit trail. Shows the
 *  content hash and on-chain payment proof so the user (and anyone receiving
 *  a screenshot) can verify the audit independently. */
export function CertificateFooter({ report }: CertificateFooterProps) {
  const [cert, setCert] = useState<AuditCertificate | null>(null);
  // Cheap content signal — only re-hash when the report shape actually shifts.
  const signature = report.proofs.length + ":" + report.findings.length + ":" + (report.verdict ?? "");
  const [prevSignature, setPrevSignature] = useState<string | null>(null);

  // Adjust state during render so we re-trigger the async hash on signature change
  // without a cascading-render warning.
  if (signature !== prevSignature) {
    setPrevSignature(signature);
    setCert(null);
  }

  useEffect(() => {
    let cancelled = false;
    buildCertificate(report)
      .then((c) => {
        if (!cancelled) setCert(c);
      })
      .catch(() => {
        if (!cancelled) setCert(null);
      });
    return () => {
      cancelled = true;
    };
  }, [report, signature]);

  if (!cert) return null;

  const explorer = explorerUrl(cert.paymentProof);
  const hasPayment = !!cert.paymentProof.txHash || !!cert.paymentProof.stripeSessionId;

  return (
    <div
      className="audit-certificate"
      style={{
        padding: "12px 24px",
        borderTop: "1px solid var(--border)",
        background: "var(--bg-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: "0.65rem",
        color: "var(--text-muted)",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        gap: "12px 18px",
        lineHeight: 1.5,
      }}
    >
      <span
        style={{
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-dim)",
        }}
      >
        Audit certificate
      </span>
      <CertField label="content">
        <code style={{ fontSize: "0.62rem" }}>sha256:{cert.contentHash.slice(0, 16)}…</code>
      </CertField>
      {hasPayment && cert.paymentProof.txHash && explorer && (
        <CertField label="paid">
          <a
            href={explorer}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: "var(--accent-light)",
              textDecoration: "none",
              fontSize: "0.62rem",
            }}
            title={cert.paymentProof.txHash}
          >
            {cert.paymentProof.txHash.slice(0, 6)}…{cert.paymentProof.txHash.slice(-4)} ↗
          </a>
        </CertField>
      )}
      {hasPayment && cert.paymentProof.stripeSessionId && !cert.paymentProof.txHash && (
        <CertField label="paid">
          <span style={{ fontSize: "0.62rem" }}>
            Stripe · {cert.paymentProof.stripeSessionId.slice(-8)}
          </span>
        </CertField>
      )}
      <CertField label="exported">
        <span style={{ fontSize: "0.62rem" }}>{cert.exportedAt.replace("T", " ").slice(0, 19)}Z</span>
      </CertField>
    </div>
  );
}

function CertField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5 }}>
      <span style={{ color: "var(--text-muted)", textTransform: "uppercase", fontSize: "0.6rem", letterSpacing: "0.08em" }}>
        {label}
      </span>
      {children}
    </span>
  );
}
