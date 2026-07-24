/**
 * FileSummaryRow — one analyzed file: its path (clickable to open source when a
 * handler is wired), the capabilities observed in it, and a one-line summary.
 */

import type { FileSummary } from "../../lib/engine-types.ts";

export interface FileSummaryRowProps {
  summary: FileSummary;
  onOpen?: (file: string) => void;
}

export function FileSummaryRow({ summary, onOpen }: FileSummaryRowProps) {
  return (
    <div className="report-file">
      <div className="report-file__head">
        {onOpen ? (
          <button
            type="button"
            className="report-file__name mono"
            onClick={() => onOpen(summary.file)}
            aria-label={`view source of ${summary.file}`}
          >
            {summary.file}
          </button>
        ) : (
          <span className="report-file__name mono">{summary.file}</span>
        )}
        {summary.capabilities.length > 0 ? (
          <div className="report-file__caps">
            {summary.capabilities.map((cap) => (
              <span key={cap} className="tag">
                {cap}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {summary.summary ? <p className="report-file__summary subtext">{summary.summary}</p> : null}
    </div>
  );
}
