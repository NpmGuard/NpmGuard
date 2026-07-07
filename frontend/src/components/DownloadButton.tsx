import { useEffect, useRef, useState } from "react";
import {
  exportAsJson,
  exportAsMarkdown,
  exportAsPdf,
  type ExportableReport,
} from "../lib/report-export";

export interface DownloadButtonProps {
  report: ExportableReport;
}

export function DownloadButton({ report }: DownloadButtonProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handle(action: () => void | Promise<void>) {
    setOpen(false);
    Promise.resolve(action()).catch((err) => {
      console.error("[download] export failed:", err);
    });
  }

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-flex" }} className="no-print">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Download this report"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "3px 9px",
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border-strong)",
          background: "var(--bg-secondary)",
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.62rem",
          fontWeight: 600,
          letterSpacing: "0.03em",
          cursor: "pointer",
        }}
      >
        <span style={{ fontSize: "0.6rem", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Download
        </span>
        <span style={{ fontSize: "0.6rem", opacity: 0.6 }}>{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 220,
            background: "var(--bg)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 6px 20px rgba(0, 0, 0, 0.12)",
            zIndex: 50,
            padding: "4px 0",
          }}
        >
          <DownloadMenuItem
            label="PDF"
            hint="open print dialog · Save as PDF"
            onClick={() => handle(() => exportAsPdf())}
          />
          <DownloadMenuItem
            label="Markdown"
            hint="paste into PR / Slack / Linear"
            onClick={() => handle(() => exportAsMarkdown(report))}
          />
          <DownloadMenuItem
            label="JSON"
            hint="raw report · CI / programmatic"
            onClick={() => handle(() => exportAsJson(report))}
          />
        </div>
      )}
    </div>
  );
}

function DownloadMenuItem({
  label,
  hint,
  onClick,
}: {
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "8px 12px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        transition: "background 0.12s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-secondary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.7rem",
          fontWeight: 700,
          color: "var(--text)",
          letterSpacing: "0.03em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.6rem",
          color: "var(--text-muted)",
          marginTop: 2,
        }}
      >
        {hint}
      </div>
    </button>
  );
}
