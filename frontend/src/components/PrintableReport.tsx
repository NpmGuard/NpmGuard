import { useEffect, useState } from "react";
import type { Finding, Proof } from "../lib/types";
import { computeProofStats } from "../lib/types";
import {
  buildCertificate,
  explorerUrl,
  type AuditCertificate,
  type ExportableReport,
} from "../lib/report-export";

/**
 * A linear, printer-friendly rendering of the full audit report. Hidden on
 * screen (display: none); revealed by the @media print stylesheet so window.print()
 * lays out the whole audit on paper rather than the live two-pane UI.
 */

export interface PrintableReportProps {
  report: ExportableReport;
}

function statusLabel(proof: Proof | undefined): string {
  if (!proof) return "FLAGGED";
  switch (proof.kind) {
    case "TEST_CONFIRMED": return "✓ VERIFIED";
    case "AI_DYNAMIC": return "OBSERVED";
    case "TEST_UNCONFIRMED": return proof.verifyError ? "INFRA ERROR" : "UNVERIFIED";
    case "AI_STATIC": return "STATIC";
    case "STRUCTURAL": return "STRUCTURAL";
  }
  return "FLAGGED";
}

function deriveDisplay(report: ExportableReport): { label: string; statsLine: string } {
  const { verified, observed, rest, dealbreaker } = computeProofStats(report.findings, report.proofs);
  let label: string;
  if (report.verdict === "SAFE") label = "SAFE";
  else if (dealbreaker) label = "DANGEROUS";
  else if (verified > 0) label = "DANGEROUS";
  else if (observed > 0) label = "SUSPICIOUS";
  else if (report.verdict === "DANGEROUS") label = "DANGEROUS";
  else label = "REVIEW";

  let statsLine: string;
  if (dealbreaker) statsLine = `Dealbreaker: ${dealbreaker.problem}`;
  else if (verified > 0) statsLine = `${verified} verified${rest > 0 ? ` · ${rest} flagged` : ""}`;
  else if (observed > 0) statsLine = `${observed} observed · ${rest} unverified`;
  else if (report.findings.length > 0) statsLine = `${report.findings.length} flagged · none verified`;
  else statsLine = "No issues found";

  return { label, statsLine };
}

function FindingBlock({ finding, proof, idx }: { finding: Finding; proof: Proof | undefined; idx: number }) {
  return (
    <section className="print-finding" style={{ pageBreakInside: "avoid", marginBottom: 18 }}>
      <h3 style={{ fontSize: "13pt", margin: "0 0 4px", fontFamily: "var(--font-mono)" }}>
        {idx + 1}. <span style={{ fontWeight: 700 }}>{statusLabel(proof)}</span>{" "}
        <span style={{ fontFamily: "var(--font-mono)", color: "#333" }}>{finding.fileLine}</span>
      </h3>
      <div style={{ fontSize: "10pt", margin: "2px 0 6px" }}>{finding.capability}</div>
      <p style={{ fontSize: "10pt", lineHeight: 1.45, margin: "4px 0" }}>{finding.problem}</p>
      {finding.evidence && (
        <p style={{ fontSize: "9pt", lineHeight: 1.5, margin: "4px 0", color: "#444" }}>
          <strong>Evidence:</strong> {finding.evidence}
        </p>
      )}
      {finding.reproductionStrategy && (
        <p style={{ fontSize: "9pt", lineHeight: 1.5, margin: "4px 0", color: "#444", fontFamily: "var(--font-mono)" }}>
          <strong>Reproduction:</strong> {finding.reproductionStrategy}
        </p>
      )}
      {proof?.testCode && (
        <details open>
          <summary style={{ fontSize: "9pt", fontWeight: 700, marginTop: 6 }}>
            Generated exploit test {proof.testHash ? `· sha256:${proof.testHash.slice(0, 12)}` : ""}
          </summary>
          <pre
            style={{
              fontSize: "7.5pt",
              lineHeight: 1.35,
              background: "#f6f3ec",
              border: "1px solid #ddd",
              padding: 8,
              marginTop: 4,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: "none",
            }}
          >
            {proof.testCode}
          </pre>
        </details>
      )}
      {proof?.verifyError && (
        <p style={{ fontSize: "8.5pt", color: "#a00", fontFamily: "var(--font-mono)", marginTop: 4 }}>
          <strong>Verify error:</strong> {proof.verifyError}
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

  const { label, statsLine } = deriveDisplay(report);
  const rt = report.runtimeEvidence;
  const hasRuntime = !!rt && (
    rt.networkCalls.length > 0 ||
    rt.envAccess.length > 0 ||
    rt.fsOperations.length > 0 ||
    rt.processSpawns.length > 0 ||
    rt.evalCalls.length > 0
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
            <span style={{ fontSize: "13pt", color: "#777", marginLeft: 10 }}>
              v{report.version}
            </span>
          )}
        </h1>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 6 }}>
          <span style={{ fontSize: "16pt", fontWeight: 800, fontFamily: "var(--font-heading)" }}>
            {label}
          </span>
          <span style={{ fontSize: "10pt", color: "#555", fontFamily: "var(--font-mono)" }}>
            {statsLine}
          </span>
        </div>
        {report.capabilities.length > 0 && (
          <div style={{ marginTop: 6, fontSize: "9pt", color: "#666", fontFamily: "var(--font-mono)" }}>
            Capabilities: {report.capabilities.join(", ")}
          </div>
        )}
      </header>

      {/* Findings */}
      {report.findings.length > 0 && (
        <section style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: "14pt", margin: "0 0 8px", fontFamily: "var(--font-heading)" }}>
            Findings
          </h2>
          {report.findings.map((f, i) => (
            <FindingBlock key={i} finding={f} proof={report.proofs[i]} idx={i} />
          ))}
        </section>
      )}

      {/* Runtime evidence */}
      {hasRuntime && rt && (
        <section style={{ marginBottom: 16, pageBreakBefore: "auto" }}>
          <h2 style={{ fontSize: "14pt", margin: "0 0 8px", fontFamily: "var(--font-heading)" }}>
            Runtime evidence
          </h2>
          {rt.networkCalls.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <h3 style={{ fontSize: "11pt", margin: "0 0 4px" }}>Network calls</h3>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "9pt" }}>
                <tbody>
                  {rt.networkCalls.map((c, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #ddd" }}>
                      <td style={{ padding: "3px 8px", fontFamily: "var(--font-mono)", width: 60, fontWeight: 700 }}>{c.method}</td>
                      <td style={{ padding: "3px 8px", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{c.url}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rt.envAccess.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <h3 style={{ fontSize: "11pt", margin: "0 0 4px" }}>Environment variables read</h3>
              <p style={{ fontSize: "9pt", fontFamily: "var(--font-mono)", margin: 0 }}>
                {rt.envAccess.join(", ")}
              </p>
            </div>
          )}
          {rt.fsOperations.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <h3 style={{ fontSize: "11pt", margin: "0 0 4px" }}>Filesystem operations</h3>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "9pt" }}>
                <tbody>
                  {rt.fsOperations.map((op, i) => (
                    <tr key={i} style={{ borderTop: "1px solid #ddd" }}>
                      <td style={{ padding: "3px 8px", fontFamily: "var(--font-mono)", width: 110 }}>{op.op}</td>
                      <td style={{ padding: "3px 8px", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>{op.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {rt.processSpawns.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <h3 style={{ fontSize: "11pt", margin: "0 0 4px" }}>Process spawns</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: "9pt", fontFamily: "var(--font-mono)" }}>
                {rt.processSpawns.map((s, i) => (
                  <li key={i}>{s.cmd} {s.args.join(" ")}</li>
                ))}
              </ul>
            </div>
          )}
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
