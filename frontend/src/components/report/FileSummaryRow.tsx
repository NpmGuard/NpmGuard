/**
 * FileSummaryRow — one analyzed file: its path (clickable to open source when a
 * handler is wired), the capabilities observed in it, and a one-line summary.
 */

import type { FileSummary } from "@npmguard/shared";
import { Badge } from "../ui/badge.tsx";
import { FOCUS_RING } from "../ui/focus.ts";
import { cn } from "../../lib/cn.ts";

export interface FileSummaryRowProps {
  summary: FileSummary;
  onOpen?: (file: string) => void;
}

export function FileSummaryRow({ summary, onOpen }: FileSummaryRowProps) {
  return (
    <div className="grid gap-1.5 border-b border-border-faint px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        {onOpen ? (
          <button
            type="button"
            className={cn(
              "min-w-0 truncate rounded-xs font-mono text-2xs text-text",
              "transition-colors duration-fast hover:text-accent-text",
              FOCUS_RING,
            )}
            onClick={() => onOpen(summary.file)}
            aria-label={`view source of ${summary.file}`}
          >
            {summary.file}
          </button>
        ) : (
          <span className="min-w-0 truncate font-mono text-2xs text-text">{summary.file}</span>
        )}
        {/* Capabilities are metadata, never an assessment: a file that can reach
            the network is not thereby suspicious. Neutral chips (§3.2). */}
        {summary.capabilities.map((cap) => (
          <Badge key={cap}>{cap}</Badge>
        ))}
      </div>
      {summary.summary ? <p className="text-sm text-text-2">{summary.summary}</p> : null}
    </div>
  );
}
