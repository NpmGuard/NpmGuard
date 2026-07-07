import { useAuditStore } from "../stores/auditStore";
import { verdictDisplay, countsSummary } from "../lib/types";
import { HypothesisList } from "./HypothesisList";

export function ResultsPanel({ onShowCode }: { onShowCode: () => void }) {
  const hypotheses = useAuditStore((s) => s.hypotheses);
  const verdict = useAuditStore((s) => s.verdict);
  const rationale = useAuditStore((s) => s.rationale);
  const counts = useAuditStore((s) => s.counts);
  const selectFile = useAuditStore((s) => s.selectFile);

  const display = verdictDisplay(verdict);
  const stats = countsSummary(counts);

  return (
    <div className="h-full flex flex-col">
      {/* Top bar — verdict + counts */}
      <div
        className="flex items-center shrink-0"
        style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", gap: 10 }}
      >
        <span
          className="section-header"
          style={{ color: display.color, fontWeight: 700, letterSpacing: "0.04em" }}
        >
          {display.label}
        </span>
        {stats && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
            {stats}
          </span>
        )}
        <button onClick={onShowCode} className="btn-ghost" style={{ marginLeft: "auto", padding: "4px 10px" }}>
          view source
        </button>
      </div>

      {/* Rationale */}
      {(rationale || display.note) && (
        <div
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid var(--border)",
            fontSize: "0.78rem",
            color: "var(--text-dim)",
            lineHeight: 1.5,
          }}
        >
          {rationale || display.note}
        </div>
      )}

      {/* Coverage-gap notice — UNKNOWN must never read as a quiet pass */}
      {display.isCoverageGap && (
        <div
          style={{
            margin: "10px 16px 0",
            padding: "8px 12px",
            background: "var(--suspected-bg)",
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius-sm)",
            fontSize: "0.75rem",
            color: "var(--warning)",
            lineHeight: 1.5,
          }}
        >
          <strong>Coverage gap.</strong> Could not confirm or refute the open hypotheses. Treat as
          unreviewed, not safe.
        </div>
      )}

      {/* Hypotheses */}
      <div className="flex-1 min-h-0">
        <HypothesisList
          hypotheses={hypotheses}
          onSelectFile={(f) => {
            selectFile(f);
            onShowCode();
          }}
        />
      </div>
    </div>
  );
}
