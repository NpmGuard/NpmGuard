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
}

function deriveVerdict(verdict: ReportViewProps["verdict"], findings: Finding[], proofs: Proof[]): VerdictDisplay {
  if (verdict === "SAFE") {
    return { label: "SAFE", color: "var(--safe)" };
  }
  const { verified, observed, dealbreaker } = computeProofStats(findings, proofs);
  if (dealbreaker) return { label: "DANGEROUS", color: "var(--danger)" };
  if (verified > 0) return { label: "DANGEROUS", color: "var(--danger)" };
  if (observed > 0) return { label: "SUSPICIOUS", color: "var(--suspected)" };
  if (verdict === "DANGEROUS") return { label: "DANGEROUS", color: "var(--danger)" };
  return { label: "REVIEW", color: "var(--text-muted)" };
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

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function totalTrailDuration(trail: TrailEntry[]): number {
  return trail.reduce((acc, entry) => acc + (entry.durationMs ?? 0), 0);
}

function outputOf(entry: TrailEntry | undefined): Record<string, unknown> {
  return entry?.output ?? {};
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function entryPointCount(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object") return null;
  const entry = (value as Record<string, unknown>)[key];
  return Array.isArray(entry) ? entry.length : null;
}

function safeInstallCommand(packageName: string, version?: string | null): string {
  return `npx npmguard-cli@latest install ${packageName}${version ? `@${version}` : ""}`;
}

function SafeReportDetail({
  packageName,
  version,
  trail,
  findings,
  proofs,
}: {
  packageName: string;
  version?: string | null;
  trail: TrailEntry[];
  findings: Finding[];
  proofs: Proof[];
}) {
  const inventory = outputOf(trail.find((entry) => entry.phase === "inventory"));
  const triage = outputOf(trail.find((entry) => entry.phase === "triage"));
  const fileCount = numberField(inventory.fileCount);
  const sourceFiles = numberField(inventory.sourceFiles);
  const flagCount = numberField(inventory.flagCount);
  const installEntrypoints = entryPointCount(inventory.entryPoints, "install");
  const runtimeEntrypoints = entryPointCount(inventory.entryPoints, "runtime");
  const hypothesisCount = numberField(triage.hypothesisCount);
  const summarizedFiles = arrayLength(triage.fileSummaries);
  const totalMs = totalTrailDuration(trail);
  const completedPhases = trail.filter((entry) => entry.status === "done").length;
  const verifyRan = trail.some((entry) => entry.phase === "verify");
  const installCommand = safeInstallCommand(packageName, version);
  const [copied, setCopied] = useState(false);

  async function copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  const checks = [
    {
      label: "Package inventory",
      value: fileCount !== null
        ? `${fileCount} files · ${sourceFiles ?? 0} source`
        : "Completed",
      detail: `${flagCount ?? 0} structural flags found`,
    },
    {
      label: "Install surface",
      value: installEntrypoints === 0 ? "No install hooks" : `${installEntrypoints ?? 0} install hook(s)`,
      detail: `${runtimeEntrypoints ?? 0} runtime entrypoint(s) inventoried`,
    },
    {
      label: "Static triage",
      value: `${hypothesisCount ?? 0} hypotheses`,
      detail: summarizedFiles !== null ? `${summarizedFiles} source summary` : "Source reviewed",
    },
    {
      label: "Exploit proof",
      value: verifyRan ? `${proofs.length} proof(s)` : "Not required",
      detail: verifyRan
        ? "Verification phase completed"
        : "No reportable finding reached proof generation",
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "var(--bg)" }}>
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "34px 32px 40px" }}>
        <section
          style={{
            border: "1px solid var(--border)",
            borderLeft: "4px solid var(--safe)",
            borderRadius: 8,
            background: "var(--bg-secondary)",
            padding: 20,
            marginBottom: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 18,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.66rem",
                  fontWeight: 800,
                  color: "var(--safe)",
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: 8,
                }}
              >
                Install gate cleared
              </div>
              <h2
                style={{
                  fontFamily: "var(--font-heading)",
                  fontSize: "1.55rem",
                  fontWeight: 800,
                  letterSpacing: 0,
                  margin: 0,
                  color: "var(--text)",
                }}
              >
                No reportable suspicious behavior
              </h2>
              <p
                style={{
                  maxWidth: 640,
                  margin: "10px 0 0",
                  color: "var(--text-dim)",
                  lineHeight: 1.55,
                  fontSize: "0.9rem",
                }}
              >
                NpmGuard inspected this package version and produced no findings.
                The install gate can continue without a security prompt.
              </p>
            </div>
            <div
              style={{
                minWidth: 170,
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg)",
                padding: "12px 14px",
              }}
            >
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Audit time
              </div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: "1.4rem", color: "var(--text)", marginTop: 3 }}>
                {formatDuration(totalMs)}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-dim)", marginTop: 2 }}>
                {completedPhases} phase{completedPhases === 1 ? "" : "s"} completed
              </div>
            </div>
          </div>
        </section>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 10,
            marginBottom: 16,
          }}
        >
          {[
            { label: "Verdict", value: "SAFE", tone: "var(--safe)" },
            { label: "Findings", value: String(findings.length), tone: "var(--text)" },
            { label: "Confirmed exploits", value: "0", tone: "var(--text)" },
            { label: "Structural flags", value: String(flagCount ?? 0), tone: "var(--text)" },
          ].map((metric) => (
            <div
              key={metric.label}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 6,
                background: "var(--bg-secondary)",
                padding: "12px 14px",
              }}
            >
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {metric.label}
              </div>
              <div style={{ fontFamily: "var(--font-heading)", fontSize: "1.25rem", fontWeight: 800, color: metric.tone, marginTop: 4 }}>
                {metric.value}
              </div>
            </div>
          ))}
        </div>

        <section
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-secondary)",
            overflow: "hidden",
            marginBottom: 16,
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.68rem",
              fontWeight: 800,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Safe decision evidence
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))" }}>
            {checks.map((check) => (
              <div
                key={check.label}
                style={{
                  padding: "14px 16px",
                  borderRight: "1px solid var(--border)",
                  borderBottom: "1px solid var(--border)",
                  minHeight: 104,
                }}
              >
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.64rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {check.label}
                </div>
                <div style={{ fontSize: "0.95rem", fontWeight: 700, color: "var(--text)", marginTop: 8 }}>
                  {check.value}
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-dim)", marginTop: 6, lineHeight: 1.45 }}>
                  {check.detail}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg-code)",
            padding: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.62rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                Continue install
              </div>
              <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", fontSize: "0.86rem", wordBreak: "break-word" }}>
                {installCommand}
              </code>
            </div>
            <button
              type="button"
              onClick={copyInstallCommand}
              style={{
                border: "1px solid var(--border-strong)",
                borderRadius: 5,
                background: copied ? "var(--safe-bg)" : "var(--bg)",
                color: copied ? "var(--safe)" : "var(--text)",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                fontSize: "0.72rem",
                fontWeight: 700,
                padding: "8px 12px",
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
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

      {/* Two-pane: findings list | proof detail */}
      <div
        className="flex-1 flex min-h-0"
        style={{ background: "var(--bg-secondary)" }}
      >
        <div
          className="shrink-0 flex flex-col"
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
          {findings.length === 0 && verdict === "SAFE" ? (
            <SafeReportDetail
              packageName={packageName}
              version={version}
              trail={trail}
              findings={findings}
              proofs={proofs}
            />
          ) : (
            <ProofDetail
              finding={safeIndex !== null ? findings[safeIndex] : null}
              proof={safeIndex !== null ? proofs[safeIndex] : undefined}
              fetchSource={fetchSource}
              runtimeEvidence={runtimeEvidence}
            />
          )}
        </div>
      </div>

      {/* Audit trail */}
      <AuditTrail entries={trail} />

      {/* Audit certificate strip — visible on screen + included in print */}
      <CertificateFooter report={exportable} />
    </div>
  );
}
