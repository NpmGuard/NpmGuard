import { useEffect, useState } from "react";
import { useAuditStore } from "../stores/auditStore";
import { verdictDisplay, countsSummary } from "../lib/types";

export function VerdictBanner() {
  const verdict = useAuditStore((s) => s.verdict);
  const rationale = useAuditStore((s) => s.rationale);
  const counts = useAuditStore((s) => s.counts);

  // Staged reveal: 0=hidden, 1=verdict word, 2=rationale, 3=counts/coverage note
  const [stage, setStage] = useState(0);

  useEffect(() => {
    if (!verdict) return;
    const t1 = setTimeout(() => setStage(1), 300);
    const t2 = setTimeout(() => setStage(2), 800);
    const t3 = setTimeout(() => setStage(3), 1200);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [verdict]);

  if (!verdict) return null;

  const display = verdictDisplay(verdict);
  const stats = countsSummary(counts);

  return (
    <div
      role="alert"
      className="verdict-banner animate-slide-down flex items-center gap-4 shrink-0"
      style={{
        padding: "12px var(--header-px)",
        borderTop: `2px solid ${display.color}`,
        background: "var(--bg)",
      }}
    >
      {/* Verdict word */}
      {stage >= 1 && (
        <span
          className="verdict-reveal"
          style={{
            fontFamily: "var(--font-heading)",
            fontWeight: 800,
            fontSize: "1.1rem",
            letterSpacing: "0.04em",
            color: display.color,
          }}
        >
          {display.label}
        </span>
      )}

      {/* Rationale / one-line explanation */}
      {stage >= 2 && (
        <span
          className="fade-in"
          style={{ fontSize: "0.78rem", color: "var(--text-dim)", lineHeight: 1.4 }}
        >
          {rationale || display.note}
        </span>
      )}

      {/* Coverage-gap pill — UNKNOWN must be loud, never a quiet pass */}
      {stage >= 3 && display.isCoverageGap && (
        <span
          className="fade-in"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.62rem",
            fontWeight: 700,
            padding: "2px 8px",
            borderRadius: 3,
            background: "var(--suspected-bg)",
            color: "var(--warning)",
            border: "1px solid var(--warning)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Coverage gap — could not analyze
        </span>
      )}

      {/* Counts summary */}
      {stage >= 3 && stats && (
        <span
          className="fade-in ml-auto"
          style={{ fontFamily: "var(--font-mono)", fontSize: "0.68rem", color: "var(--text-muted)" }}
        >
          {stats}
        </span>
      )}
    </div>
  );
}
