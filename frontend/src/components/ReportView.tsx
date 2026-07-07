import { useMemo, useState } from "react";
import type { Finding, Proof, InstrumentationLog } from "../lib/types";
import { computeProofStats } from "../lib/types";
import { FindingsList } from "./FindingsList";
import { ProofDetail } from "./ProofDetail";
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
  verdict: "SAFE" | "DANGEROUS" | null;
  capabilities: string[];
  findings: Finding[];
  proofs: Proof[];
  trail: TrailEntry[];
  /** Optional fetcher for source files. When omitted, the Source tab shows
   *  a graceful "not available" state. */
  fetchSource?: (path: string) => Promise<string | null>;
  /** Payment proof — if omitted, the badge auto-reads URL params. */
  paymentProof?: PaymentProofBadgeProps;
  /** Aggregated runtime evidence for the audit (report-level). */
  runtimeEvidence?: InstrumentationLog | null;
}

// ---------------------------------------------------------------------------
// Verdict header — tighter version of VerdictBanner that doesn't read the store
// ---------------------------------------------------------------------------

interface VerdictDisplay {
  label: string;
  color: string;
  bg: string;
}

function deriveVerdict(verdict: ReportViewProps["verdict"], findings: Finding[], proofs: Proof[]): VerdictDisplay {
  if (verdict === "SAFE") {
    return { label: "SAFE", color: "var(--safe)", bg: "var(--safe-bg)" };
  }
  const { verified, observed, dealbreaker } = computeProofStats(findings, proofs);
  if (dealbreaker) return { label: "DANGEROUS", color: "var(--danger)", bg: "var(--danger-bg)" };
  if (verified > 0) return { label: "DANGEROUS", color: "var(--danger)", bg: "var(--danger-bg)" };
  if (observed > 0) return { label: "SUSPICIOUS", color: "var(--suspected)", bg: "var(--suspected-bg)" };
  if (verdict === "DANGEROUS") return { label: "DANGEROUS", color: "var(--danger)", bg: "var(--danger-bg)" };
  return { label: "REVIEW", color: "var(--text-muted)", bg: "var(--bg-tertiary)" };
}

function statsLine(findings: Finding[], proofs: Proof[]): string {
  const { verified, observed, rest, dealbreaker } = computeProofStats(findings, proofs);
  if (dealbreaker) return `Dealbreaker: ${dealbreaker.problem}`;
  if (verified > 0) return `${verified} verified${rest > 0 ? ` · ${rest} flagged` : ""}`;
  if (observed > 0) return `${observed} observed · ${rest} unverified`;
  if (findings.length > 0) return `${findings.length} flagged · none verified`;
  return "No issues found";
}

// Capability → count of proofs that targeted it. Capability strings can be
// comma-joined ("NETWORK,DNS_EXFIL"); we count each token once per finding.
function capabilityCounts(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    const caps = f.capability.split(",").map((c) => c.trim()).filter(Boolean);
    for (const cap of caps) counts[cap] = (counts[cap] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ReportView({
  packageName,
  version,
  verdict,
  capabilities,
  findings,
  proofs,
  trail,
  fetchSource,
  paymentProof,
  runtimeEvidence,
}: ReportViewProps) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(
    findings.length > 0 ? 0 : null,
  );

  // Keep selection in range when findings list changes
  const safeIndex = selectedIndex !== null && selectedIndex < findings.length ? selectedIndex : null;

  const display = useMemo(() => deriveVerdict(verdict, findings, proofs), [verdict, findings, proofs]);
  const stats = useMemo(() => statsLine(findings, proofs), [findings, proofs]);
  const capCounts = useMemo(() => capabilityCounts(findings), [findings]);

  // Unique capabilities to display: union of report-level capabilities and finding-derived
  const displayCaps = useMemo(() => {
    const set = new Set<string>(capabilities);
    for (const cap of Object.keys(capCounts)) set.add(cap);
    return Array.from(set);
  }, [capabilities, capCounts]);

  const exportable: ExportableReport = {
    packageName,
    version,
    verdict,
    capabilities,
    findings,
    proofs,
    runtimeEvidence: runtimeEvidence ?? null,
  };

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
          <h1
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "1.15rem",
              fontWeight: 700,
              color: "var(--text)",
            }}
          >
            {packageName}
          </h1>
          {version && (
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.75rem",
                color: "var(--text-muted)",
              }}
            >
              v{version}
            </span>
          )}
          <span
            style={{
              marginLeft: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <PaymentProofBadge {...(paymentProof ?? {})} />
            <DownloadButton report={exportable} />
          </span>
        </div>

        {/* Verdict line — the answer leads; package name above is the context */}
        <div
          style={{
            marginTop: 10,
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            flexWrap: "wrap",
            padding: "8px 12px",
            borderLeft: `3px solid ${display.color}`,
            background: display.bg,
            borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-heading)",
              fontWeight: 800,
              fontSize: "1.3rem",
              lineHeight: 1,
              letterSpacing: "0.04em",
              color: display.color,
            }}
          >
            {display.label}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.72rem",
              color: "var(--text-dim)",
            }}
          >
            {stats}
          </span>
        </div>

        {/* Capability chips with counts */}
        {displayCaps.length > 0 && (
          <div
            style={{
              marginTop: 10,
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              paddingLeft: 12,
            }}
          >
            {displayCaps.map((cap) => {
              const count = capCounts[cap] ?? 0;
              return (
                <span
                  key={cap}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.6rem",
                    padding: "2px 7px",
                    borderRadius: "var(--radius-sm)",
                    background: "var(--bg-tertiary)",
                    color: "var(--text-dim)",
                    border: "1px solid var(--border)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{cap.replace(/_/g, " ")}</span>
                  {count > 0 && (
                    <span style={{ color: "var(--text-muted)" }}>· {count}</span>
                  )}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* Two-pane: findings list | proof detail — stacks on mobile (index.css) */}
      <div
        className="report-panes flex-1 flex min-h-0"
        style={{ background: "var(--bg-secondary)" }}
      >
        <div
          className="report-findings-pane shrink-0 flex flex-col"
          style={{
            width: 320,
            minWidth: 280,
            borderRight: "1px solid var(--border)",
            background: "var(--bg)",
          }}
        >
          <FindingsList
            findings={findings}
            proofs={proofs}
            selectedIndex={safeIndex}
            onSelect={setSelectedIndex}
          />
        </div>
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <ProofDetail
            finding={safeIndex !== null ? findings[safeIndex] : null}
            proof={safeIndex !== null ? proofs[safeIndex] : undefined}
            fetchSource={fetchSource}
            runtimeEvidence={runtimeEvidence}
          />
        </div>
      </div>

      {/* Audit trail */}
      <AuditTrail entries={trail} />

      {/* Audit certificate strip — visible on screen + included in print */}
      <CertificateFooter report={exportable} />
    </div>
  );
}
