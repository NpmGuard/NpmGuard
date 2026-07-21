import type { Finding, Proof, InstrumentationLog, VerdictEnum } from "./types";

// ---------------------------------------------------------------------------
// Shared input shape for the 3 export formats. Mirrors what PackageLookup and
// AuditView already build — kept loose so callers don't need to import zod.
// ---------------------------------------------------------------------------

export interface ExportableReport {
  packageName: string;
  version?: string | null;
  verdict: VerdictEnum | null;
  capabilities: string[];
  findings: Finding[];
  proofs: Proof[];
  runtimeEvidence?: InstrumentationLog | null;
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

// ---------------------------------------------------------------------------
// Stats — same logic the verdict header uses, copied here so we don't take a
// dep on the React component code.
// ---------------------------------------------------------------------------

interface ReportStats {
  verified: number;
  observed: number;
  flagged: number;
  total: number;
}

function statsOf(report: ExportableReport): ReportStats {
  const verified = report.proofs.filter((p) => p.kind === "TEST_CONFIRMED").length;
  const observed = report.proofs.filter((p) => p.kind === "AI_DYNAMIC").length;
  const total = report.findings.length;
  return { verified, observed, flagged: total - verified - observed, total };
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

function mdEscape(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function findingHeader(proof: Proof | undefined): string {
  if (!proof) return "FLAGGED";
  switch (proof.kind) {
    case "TEST_CONFIRMED": return "✓ VERIFIED";
    case "AI_DYNAMIC": return "OBSERVED";
    case "TEST_UNCONFIRMED": return proof.verifyError ? "INFRA ERROR" : "UNVERIFIED";
    case "AI_STATIC": return "STATIC";
    case "STRUCTURAL": return "STRUCTURAL";
    default: return "FLAGGED";
  }
}

function groupByCapability(report: ExportableReport): Map<string, Array<{ finding: Finding; proof: Proof | undefined }>> {
  const map = new Map<string, Array<{ finding: Finding; proof: Proof | undefined }>>();
  for (let i = 0; i < report.findings.length; i++) {
    const f = report.findings[i];
    const cap = (f.capability.split(",")[0] || "OTHER").trim();
    if (!map.has(cap)) map.set(cap, []);
    map.get(cap)!.push({ finding: f, proof: report.proofs[i] });
  }
  return map;
}

export async function exportAsMarkdown(report: ExportableReport): Promise<void> {
  const cert = await buildCertificate(report);
  const stats = statsOf(report);

  const lines: string[] = [];
  lines.push(`# NpmGuard audit: \`${report.packageName}@${report.version ?? "unknown"}\``);
  lines.push("");
  const verdictBadge =
    report.verdict === "SAFE"
      ? "✓ SAFE"
      : report.verdict === "DANGEROUS"
        ? "⛔ DANGEROUS"
        : report.verdict === "SUSPECT"
          ? "⚠ SUSPECT"
          : "? UNKNOWN";
  lines.push(`**Verdict: ${verdictBadge}** · ${stats.verified} verified · ${stats.observed} observed · ${stats.flagged} flagged`);
  lines.push("");

  // Capability summary
  if (report.capabilities.length > 0) {
    lines.push("## Capabilities");
    lines.push("");
    for (const cap of report.capabilities) {
      lines.push(`- \`${cap}\``);
    }
    lines.push("");
  }

  // Findings, grouped by capability
  const groups = groupByCapability(report);
  if (groups.size > 0) {
    lines.push("## Findings");
    lines.push("");
    for (const [cap, items] of groups) {
      lines.push(`### ${cap.replace(/_/g, " ")}`);
      lines.push("");
      for (const { finding, proof } of items) {
        const status = findingHeader(proof);
        lines.push(`- **${status}** — \`${finding.fileLine}\``);
        lines.push(`  ${finding.problem}`);
        if (finding.evidence) lines.push(`  > ${finding.evidence.slice(0, 400).replace(/\n/g, " ")}`);
        if (proof?.testHash) lines.push(`  _proof hash:_ \`${proof.testHash.slice(0, 16)}\``);
      }
      lines.push("");
    }
  }

  // Runtime evidence
  const re = report.runtimeEvidence;
  if (re && (re.networkCalls.length || re.envAccess.length || re.fsOperations.length || re.processSpawns.length)) {
    lines.push("## Runtime evidence");
    lines.push("");
    if (re.networkCalls.length) {
      lines.push("### Network calls");
      lines.push("");
      lines.push("| Method | URL |");
      lines.push("|---|---|");
      for (const c of re.networkCalls) lines.push(`| \`${mdEscape(c.method)}\` | \`${mdEscape(c.url)}\` |`);
      lines.push("");
    }
    if (re.envAccess.length) {
      lines.push("### Environment variables read");
      lines.push("");
      lines.push(re.envAccess.map((k) => `\`${k}\``).join(", "));
      lines.push("");
    }
    if (re.fsOperations.length) {
      lines.push("### Filesystem operations");
      lines.push("");
      lines.push("| Op | Path |");
      lines.push("|---|---|");
      for (const op of re.fsOperations) lines.push(`| \`${mdEscape(op.op)}\` | \`${mdEscape(op.path)}\` |`);
      lines.push("");
    }
    if (re.processSpawns.length) {
      lines.push("### Process spawns");
      lines.push("");
      for (const s of re.processSpawns) lines.push(`- \`${mdEscape(s.cmd)} ${s.args.map(mdEscape).join(" ")}\``);
      lines.push("");
    }
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
