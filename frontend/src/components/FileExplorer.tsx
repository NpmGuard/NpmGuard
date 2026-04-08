import { useState } from "react";
import { FileTree } from "./FileTree";
import { useAuditStore } from "../stores/auditStore";

function DependencyList() {
  const [expanded, setExpanded] = useState(false);
  const deps = useAuditStore((s) => s.inventoryMeta?.dependencies);

  if (!deps) return null;

  const prodEntries = Object.entries(deps.prod ?? {});
  const devEntries = Object.entries(deps.dev ?? {});
  if (prodEntries.length + devEntries.length === 0) return null;

  const summary = [
    prodEntries.length > 0 ? `${prodEntries.length} prod` : "",
    devEntries.length > 0 ? `${devEntries.length} dev` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <button
        className="section-header"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        style={{
          padding: "8px 14px 6px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          whiteSpace: "nowrap",
          width: "100%",
          background: "none",
          border: "none",
          textAlign: "left",
        }}
      >
        <span style={{
          fontSize: "0.55rem",
          color: "var(--text-muted)",
          transition: "transform 0.15s",
          transform: expanded ? "rotate(90deg)" : "none",
          display: "inline-block",
        }}>&#9656;</span>
        Deps
        <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>{summary}</span>
      </button>
      {expanded && (
        <div style={{ padding: "0 14px 8px" }}>
          {prodEntries.length > 0 && (
            <>
              {prodEntries.map(([name, ver]) => (
                <div
                  key={name}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.65rem",
                    color: "var(--text-dim)",
                    padding: "1px 0",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name}<span style={{ color: "var(--text-muted)" }}>@{ver}</span>
                </div>
              ))}
            </>
          )}
          {devEntries.length > 0 && (
            <>
              <div style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.55rem",
                color: "var(--text-muted)",
                marginTop: prodEntries.length > 0 ? 6 : 0,
                marginBottom: 2,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}>
                dev
              </div>
              {devEntries.map(([name, ver]) => (
                <div
                  key={name}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.65rem",
                    color: "var(--text-muted)",
                    padding: "1px 0",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {name}<span style={{ opacity: 0.6 }}>@{ver}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const files = useAuditStore((s) => s.files);

  return (
    <div
      className="flex flex-col shrink-0 overflow-hidden"
      style={{
        width: open ? "var(--explorer-width)" : 0,
        minWidth: open ? "var(--explorer-width)" : 0,
        borderLeft: open ? "1px solid var(--border)" : "none",
        transition: "width 0.25s ease, min-width 0.25s ease",
      }}
    >
      <div
        className="section-header flex items-center justify-between shrink-0"
        style={{
          padding: "10px 14px 8px",
          borderBottom: "1px solid var(--border)",
          whiteSpace: "nowrap",
        }}
      >
        Files ({files.length})
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "var(--text-muted)",
            fontSize: "0.75rem",
            padding: "0 2px",
            lineHeight: 1,
          }}
          aria-label="Close file explorer"
        >
          &times;
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <FileTree />
        <DependencyList />
      </div>
    </div>
  );
}
