import { useMemo } from "react";
import type { Hypothesis, HypothesisState } from "../lib/types";
import { HYP_STATE_META, hypSeverityColor, claimKindLabel } from "../lib/types";

export interface HypothesisListProps {
  hypotheses: Hypothesis[];
  /** Optional — when provided, focus-file chips become clickable. */
  onSelectFile?: (file: string) => void;
}

// ---------------------------------------------------------------------------
// Single hypothesis card — "a finding with a state"
// ---------------------------------------------------------------------------

function HypothesisCard({ hyp, onSelectFile }: { hyp: Hypothesis; onSelectFile?: (file: string) => void }) {
  const meta = HYP_STATE_META[hyp.state];
  const confirmedRun = hyp.evidenceRefs.find((r) => r.kind === "run");

  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        borderLeft: `3px solid ${meta.color}`,
        background: meta.isGap ? meta.bg : "transparent",
        padding: "12px 18px",
      }}
    >
      {/* Title row: description + state badge */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ flex: 1, fontSize: "0.85rem", fontWeight: 600, color: "var(--text)", lineHeight: 1.4 }}>
          {hyp.description || claimKindLabel(hyp.claim.kind)}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.55rem",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            padding: "1px 6px",
            borderRadius: 3,
            flexShrink: 0,
            background: meta.bg,
            color: meta.color,
          }}
        >
          {hyp.state === "CONFIRMED" ? "✓ " : ""}{meta.label}
        </span>
      </div>

      {/* Meta chips: claim kind, gating, severity */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        <Chip>{claimKindLabel(hyp.claim.kind)}</Chip>
        {hyp.claim.gating && <Chip>{claimKindLabel(hyp.claim.gating)}</Chip>}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            fontWeight: 700,
            padding: "1px 6px",
            borderRadius: 3,
            color: hypSeverityColor(hyp.severity),
            border: `1px solid ${hypSeverityColor(hyp.severity)}`,
            textTransform: "uppercase",
          }}
        >
          {hyp.severity}
        </span>
        {confirmedRun && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              padding: "1px 6px",
              borderRadius: 3,
              background: "var(--danger-bg)",
              color: "var(--danger)",
            }}
            title={`run:${confirmedRun.id}`}
          >
            reproduced
          </span>
        )}
      </div>

      {/* Resolution reason — why it landed in this terminal state */}
      {hyp.resolution?.reason && (
        <div style={{ marginTop: 6, fontSize: "0.76rem", color: "var(--text-dim)", lineHeight: 1.55 }}>
          {hyp.resolution.reason}
          {hyp.resolution.by && (
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "0.65rem" }}>
              {" "}· {hyp.resolution.by}
            </span>
          )}
        </div>
      )}

      {/* Focus files */}
      {hyp.focusFiles.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
          {hyp.focusFiles.map((file) =>
            onSelectFile ? (
              <button
                key={file}
                type="button"
                onClick={() => onSelectFile(file)}
                aria-label={`Open ${file}`}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.65rem",
                  color: "var(--accent-light)",
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                → {file}
              </button>
            ) : (
              <span key={file} style={{ fontFamily: "var(--font-mono)", fontSize: "0.65rem", color: "var(--text-muted)" }}>
                {file}
              </span>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "0.6rem",
        fontWeight: 600,
        padding: "1px 6px",
        borderRadius: 3,
        background: "var(--bg-tertiary)",
        color: "var(--text-dim)",
        border: "1px solid var(--border)",
      }}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Grouped list — CONFIRMED first, REFUTED last; gaps (open/inconclusive/…) loud
// ---------------------------------------------------------------------------

export function HypothesisList({ hypotheses, onSelectFile }: HypothesisListProps) {
  const groups = useMemo(() => {
    const byState = new Map<HypothesisState, Hypothesis[]>();
    for (const h of hypotheses) {
      const arr = byState.get(h.state) ?? [];
      arr.push(h);
      byState.set(h.state, arr);
    }
    return Array.from(byState.entries()).sort(
      (a, b) => HYP_STATE_META[a[0]].order - HYP_STATE_META[b[0]].order,
    );
  }, [hypotheses]);

  if (hypotheses.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2"
        style={{ padding: "48px 20px", color: "var(--text-muted)", fontSize: "0.85rem", textAlign: "center" }}
      >
        <div style={{ fontSize: "1.5rem", opacity: 0.3 }}>&#10003;</div>
        No hypotheses were raised
        <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>
          Nothing in this package looked worth investigating
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto" style={{ background: "var(--bg)" }}>
      {groups.map(([state, items]) => {
        const meta = HYP_STATE_META[state];
        return (
          <div key={state}>
            <div
              style={{
                padding: "10px 18px 4px",
                fontFamily: "var(--font-mono)",
                fontSize: "0.6rem",
                fontWeight: 700,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: meta.color,
                display: "flex",
                alignItems: "baseline",
                gap: 6,
              }}
            >
              <span>{meta.label}</span>
              <span style={{ color: "var(--text-muted)", opacity: 0.7 }}>· {items.length}</span>
              {meta.isGap && (
                <span style={{ color: "var(--text-muted)", opacity: 0.7, textTransform: "none", letterSpacing: 0 }}>
                  coverage gap
                </span>
              )}
            </div>
            {items.map((hyp) => (
              <HypothesisCard key={hyp.hypId} hyp={hyp} onSelectFile={onSelectFile} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
