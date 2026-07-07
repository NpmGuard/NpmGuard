import type { Finding, Proof } from "../lib/types";
import { verificationStatus, type VerificationStatus as Status } from "../lib/report-helpers";

// Primary capability used for grouping. Findings can declare
// "NETWORK,DNS_EXFIL" — pick the first.
function primaryCapability(finding: Finding): string {
  const parts = finding.capability.split(",").map((c) => c.trim()).filter(Boolean);
  return parts[0] || "OTHER";
}

interface Group {
  capability: string;
  items: Array<{ finding: Finding; proof: Proof | undefined; index: number; status: Status }>;
}

function groupByCapability(findings: Finding[], proofs: Proof[]): Group[] {
  const map = new Map<string, Group>();
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const cap = primaryCapability(f);
    const proof = proofs[i];
    const status = verificationStatus(proof);
    if (!map.has(cap)) map.set(cap, { capability: cap, items: [] });
    map.get(cap)!.items.push({ finding: f, proof, index: i, status });
  }
  // Sort items inside each group by rank, then sort groups by best rank inside
  const groups = Array.from(map.values());
  for (const g of groups) g.items.sort((a, b) => a.status.rank - b.status.rank);
  groups.sort((a, b) => a.items[0].status.rank - b.items[0].status.rank);
  return groups;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface FindingsListProps {
  findings: Finding[];
  proofs: Proof[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

export function FindingsList({ findings, proofs, selectedIndex, onSelect }: FindingsListProps) {
  if (findings.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2"
        style={{
          padding: "48px 20px",
          color: "var(--text-muted)",
          fontSize: "0.85rem",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "1.5rem", opacity: 0.3 }}>&#10003;</div>
        No suspicious behavior detected
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
          Package appears safe to install
        </div>
      </div>
    );
  }

  const groups = groupByCapability(findings, proofs);

  return (
    <div
      className="flex flex-col h-full overflow-y-auto"
      style={{ background: "var(--bg)" }}
    >
      <div
        className="shrink-0 flex items-baseline"
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span className="section-header">Findings</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.65rem",
            color: "var(--text-muted)",
            marginLeft: 8,
          }}
        >
          {findings.length}
        </span>
      </div>

      {groups.map((group) => (
        <div key={group.capability} style={{ marginBottom: 4 }}>
          <div
            style={{
              padding: "10px 16px 4px",
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "baseline",
              gap: 6,
            }}
          >
            <span>{group.capability.replace(/_/g, " ")}</span>
            <span style={{ color: "var(--text-muted)", opacity: 0.6 }}>
              · {group.items.length}
            </span>
          </div>
          {group.items.map(({ finding, proof, index, status }) => {
            const isSelected = index === selectedIndex;
            return (
              <button
                key={index}
                type="button"
                onClick={() => onSelect(index)}
                aria-pressed={isSelected}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 16px",
                  border: "none",
                  borderLeft: `3px solid ${status.border}`,
                  background: isSelected ? "var(--bg-secondary)" : "transparent",
                  cursor: "pointer",
                  borderBottom: "1px solid var(--border)",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => {
                  if (!isSelected) e.currentTarget.style.background = "var(--bg-secondary)";
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) e.currentTarget.style.background = "transparent";
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.78rem",
                      fontWeight: 600,
                      color: "var(--text)",
                      lineHeight: 1.4,
                      flex: 1,
                    }}
                  >
                    {finding.problem}
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6rem",
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      padding: "2px 6px",
                      borderRadius: 3,
                      flexShrink: 0,
                      background: status.bg,
                      color: status.color,
                    }}
                  >
                    {status.label === "VERIFIED" ? "✓ " : ""}{status.label}
                  </span>
                </div>
                {finding.fileLine && (
                  <div
                    style={{
                      marginTop: 4,
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.65rem",
                      color: "var(--text-muted)",
                    }}
                  >
                    {finding.fileLine}
                  </div>
                )}
                {proof?.confidence && proof.confidence !== "SUSPECTED" && (
                  <div
                    style={{
                      marginTop: 4,
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6rem",
                      color: "var(--text-muted)",
                      letterSpacing: "0.05em",
                    }}
                  >
                    confidence: {proof.confidence.toLowerCase()}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

