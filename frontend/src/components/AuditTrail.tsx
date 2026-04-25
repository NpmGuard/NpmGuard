import { useState } from "react";
import { PHASE_LABELS } from "../lib/types";
import type { TrailEntry } from "../lib/report-helpers";

export interface AuditTrailProps {
  entries: TrailEntry[];
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: TrailEntry["status"]): string {
  switch (status) {
    case "done": return "var(--accent-light)";
    case "active": return "var(--investigating)";
    default: return "var(--text-muted)";
  }
}

export function AuditTrail({ entries }: AuditTrailProps) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  if (entries.length === 0) return null;

  const totalMs = entries.reduce((acc, e) => acc + (e.durationMs ?? 0), 0);
  const hasDetails = entries.some((e) => e.input || e.output);

  return (
    <div
      className="shrink-0"
      style={{
        borderTop: "1px solid var(--border)",
        background: "var(--bg-secondary)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          background: "transparent",
          border: "none",
          padding: "10px 18px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          cursor: "pointer",
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.7rem",
          letterSpacing: "0.04em",
        }}
      >
        <span style={{ fontWeight: 700, textTransform: "uppercase" }}>Audit trail</span>
        <span style={{ color: "var(--text-muted)" }}>{entries.length} phases · {formatDuration(totalMs)}</span>
        <span style={{ marginLeft: "auto", fontSize: "0.65rem", color: "var(--text-muted)" }}>
          {open ? "− collapse" : "+ expand"}
        </span>
      </button>

      {open && (
        <div style={{ padding: "0 18px 14px" }}>
          <div
            style={{
              display: "flex",
              gap: 0,
              alignItems: "stretch",
              flexWrap: "wrap",
              paddingBottom: 4,
            }}
          >
            {entries.map((entry, i) => {
              const color = statusColor(entry.status);
              const isExpanded = expanded === i;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => hasDetails && setExpanded(isExpanded ? null : i)}
                  disabled={!entry.input && !entry.output}
                  style={{
                    flex: "1 1 120px",
                    minWidth: 110,
                    padding: "8px 10px",
                    background: isExpanded ? "var(--bg-tertiary)" : "var(--bg)",
                    border: "1px solid var(--border)",
                    borderLeft: `3px solid ${color}`,
                    borderRadius: "var(--radius-sm)",
                    margin: "0 4px 4px 0",
                    cursor: entry.input || entry.output ? "pointer" : "default",
                    textAlign: "left",
                    transition: "background 0.12s",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      color: "var(--text)",
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                    }}
                  >
                    {entry.phase}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.7rem",
                      color: color,
                      marginTop: 2,
                    }}
                  >
                    {entry.status === "active" ? "running…" : formatDuration(entry.durationMs)}
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-sans)",
                      fontSize: "0.65rem",
                      color: "var(--text-muted)",
                      marginTop: 2,
                      lineHeight: 1.3,
                    }}
                  >
                    {PHASE_LABELS[entry.phase] || ""}
                  </div>
                </button>
              );
            })}
          </div>

          {expanded !== null && (entries[expanded].input || entries[expanded].output) && (
            <div
              style={{
                marginTop: 10,
                padding: 12,
                background: "var(--bg-code)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                maxHeight: 240,
                overflow: "auto",
              }}
            >
              {entries[expanded].input && (
                <details open style={{ marginBottom: 8 }}>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6rem",
                      fontWeight: 700,
                      color: "var(--text-muted)",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    Input
                  </summary>
                  <pre
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.7rem",
                      color: "var(--text-dim)",
                      margin: "6px 0 0",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {JSON.stringify(entries[expanded].input, null, 2)}
                  </pre>
                </details>
              )}
              {entries[expanded].output && (
                <details open>
                  <summary
                    style={{
                      cursor: "pointer",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.6rem",
                      fontWeight: 700,
                      color: "var(--text-muted)",
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    Output
                  </summary>
                  <pre
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.7rem",
                      color: "var(--text-dim)",
                      margin: "6px 0 0",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {JSON.stringify(entries[expanded].output, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
