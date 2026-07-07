import type { VerdictEnum, Hypothesis, HypothesisCounts } from "./types";
import { HYP_STATE_META, claimKindLabel, countsSummary } from "./types";

// ---------------------------------------------------------------------------
// Shared input shape for the 3 export formats. Mirrors the engine v2 AuditReport
// surface — the hypothesis graph is the finding surface now.
// ---------------------------------------------------------------------------

export interface ExportableReport {
  packageName: string;
  version?: string | null;
  verdict: VerdictEnum | null;
  rationale: string;
  counts: HypothesisCounts | null;
  hypotheses: Hypothesis[];
}

export interface PaymentProof {
  txHash?: string | null;
  chain?: string | null;
  stripeSessionId?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EXPLORERS: Record<string, string> = {
  "base-sepolia": "https://sepolia.basescan.org/tx/",
  "base": "https://basescan.org/tx/",
  "ethereum": "https://etherscan.io/tx/",
};

export function readPaymentProofFromUrl(): PaymentProof {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  return {
    txHash: params.get("tx") || params.get("txHash") || null,
    chain: params.get("chain") || "base-sepolia",
    stripeSessionId: params.get("session_id") || params.get("sessionId") || null,
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function downloadBlob(content: string | Blob, filename: string, mime = "text/plain"): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to start the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFilename(part: string): string {
  return part.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** Plain-text verdict badge for the markdown export. */
export function verdictBadge(verdict: VerdictEnum | null): string {
  switch (verdict) {
    case "SAFE": return "✓ SAFE";
    case "DANGEROUS": return "⚠ DANGEROUS";
    case "SUSPECT": return "◐ SUSPECT";
    case "UNKNOWN": return "? UNKNOWN (coverage gap)";
    default: return "PENDING";
  }
}

// ---------------------------------------------------------------------------
// Audit certificate — the unique angle. Anyone receiving an exported report
// can independently verify by clicking the on-chain link.
// ---------------------------------------------------------------------------

export interface AuditCertificate {
  packageName: string;
  version: string;
  verdict: string;
  contentHash: string; // sha256 of the canonical report JSON
  paymentProof: PaymentProof;
  exportedAt: string; // ISO
}

export async function buildCertificate(
  report: ExportableReport,
  paymentProof: PaymentProof = readPaymentProofFromUrl(),
): Promise<AuditCertificate> {
  // Hash the report content (without _meta noise) so two exports of the
  // same report share the same hash.
  const canonical = JSON.stringify(report);
  const contentHash = await sha256Hex(canonical);
  return {
    packageName: report.packageName,
    version: report.version ?? "unknown",
    verdict: report.verdict ?? "UNKNOWN",
    contentHash,
    paymentProof,
    exportedAt: new Date().toISOString(),
  };
}

export function explorerUrl(payment: PaymentProof): string | null {
  if (!payment.txHash) return null;
  const explorer = EXPLORERS[payment.chain || "base-sepolia"] || EXPLORERS["base-sepolia"];
  return `${explorer}${payment.txHash}`;
}

// ---------------------------------------------------------------------------
// JSON export — the raw report, no wrapping. CI/automation friendly.
// ---------------------------------------------------------------------------

export function exportAsJson(report: ExportableReport): void {
  const json = JSON.stringify(report, null, 2);
  const filename = `${safeFilename(report.packageName)}-${safeFilename(report.version ?? "audit")}.json`;
  downloadBlob(json, filename, "application/json");
}

// ---------------------------------------------------------------------------
// Markdown export — for PR comments, Slack, Linear.
// ---------------------------------------------------------------------------

export async function exportAsMarkdown(report: ExportableReport): Promise<void> {
  const cert = await buildCertificate(report);

  const lines: string[] = [];
  lines.push(`# NpmGuard audit: \`${report.packageName}@${report.version ?? "unknown"}\``);
  lines.push("");
  lines.push(`**Verdict: ${verdictBadge(report.verdict)}**${report.rationale ? ` — ${report.rationale}` : ""}`);
  lines.push("");
  if (report.counts) {
    lines.push(`_${countsSummary(report.counts)}_`);
    lines.push("");
  }

  // Hypotheses, grouped/sorted by state (confirmed first)
  if (report.hypotheses.length > 0) {
    const sorted = [...report.hypotheses].sort(
      (a, b) => HYP_STATE_META[a.state].order - HYP_STATE_META[b.state].order,
    );
    lines.push("## Hypotheses");
    lines.push("");
    for (const h of sorted) {
      const label = HYP_STATE_META[h.state].label.toUpperCase();
      lines.push(`- **${label}** — ${h.description || claimKindLabel(h.claim.kind)}`);
      lines.push(
        `  - claim: \`${h.claim.kind}\`${h.claim.gating ? ` · gating: \`${h.claim.gating}\`` : ""} · severity: ${h.severity}`,
      );
      if (h.focusFiles.length) lines.push(`  - files: ${h.focusFiles.map((f) => `\`${f}\``).join(", ")}`);
      if (h.resolution?.reason) lines.push(`  - resolution: ${h.resolution.reason.replace(/\n/g, " ")}`);
      const run = h.evidenceRefs.find((r) => r.kind === "run");
      if (run) lines.push(`  - evidence: reproduced in run \`${run.id}\``);
    }
    lines.push("");
  }

  // Audit certificate
  lines.push("---");
  lines.push("");
  lines.push("## Audit certificate");
  lines.push("");
  lines.push(`- **Package**: \`${cert.packageName}@${cert.version}\``);
  lines.push(`- **Verdict**: ${cert.verdict}`);
  lines.push(`- **Content hash**: \`sha256:${cert.contentHash}\``);
  const explorer = explorerUrl(cert.paymentProof);
  if (explorer && cert.paymentProof.txHash) {
    lines.push(`- **Payment proof**: [\`${cert.paymentProof.txHash}\`](${explorer}) (${cert.paymentProof.chain})`);
  } else if (cert.paymentProof.stripeSessionId) {
    lines.push(`- **Payment proof**: Stripe session \`${cert.paymentProof.stripeSessionId.slice(-12)}\``);
  }
  lines.push(`- **Exported at**: ${cert.exportedAt}`);
  lines.push("");
  lines.push("_Verify the payment on the explorer link, then recompute the SHA-256 hash of the raw JSON report from the API to confirm the content hasn't been tampered with._");
  lines.push("");

  const filename = `${safeFilename(report.packageName)}-${safeFilename(report.version ?? "audit")}.md`;
  downloadBlob(lines.join("\n"), filename, "text/markdown");
}

// ---------------------------------------------------------------------------
// PDF export — relies on the @media print stylesheet. The print() call opens
// the browser's print dialog where the user picks "Save as PDF".
// ---------------------------------------------------------------------------

export function exportAsPdf(): void {
  if (typeof window === "undefined") return;
  // The print stylesheet is responsible for the layout — the body of the page
  // is what gets rendered. A small delay lets any tab transition finish.
  setTimeout(() => window.print(), 50);
}
