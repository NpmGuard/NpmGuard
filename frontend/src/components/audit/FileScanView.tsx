/**
 * The file rail — every file in the package, and what the audit made of it.
 *
 * It is present for the whole audit, not just the scan. The files are what the
 * verdict is ABOUT, and a workspace that drops them the moment a graph appears
 * makes the graph look like it came from nowhere. Here they stay: reading, then
 * cleared, then flagged with the exact ranges that become the graph's roots.
 *
 * ── The colour rule, where it is easiest to break ───────────────────────────
 *
 * A cleared file is ACHROMATIC. Not green. Two hundred green rows is two hundred
 * individual safety claims and the audit made none of them — it read the file
 * and found nothing worth running. Red marks a file the audit means to TEST,
 * which is a statement about what happens next, not a verdict.
 */

import { useEffect, useRef } from "react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { RISK_SUSPICIOUS_THRESHOLD } from "../../lib/types.ts";
import { cn } from "../../lib/cn.ts";

type FileState = "pending" | "reading" | "cleared" | "flagged";

export interface FileScanViewProps {
  /** the file whose source the code pane is showing */
  selected: string | null;
  onSelect: (path: string) => void;
}

export function FileScanView({ selected, onSelect }: FileScanViewProps) {
  const files = useAuditStore((s) => s.files);
  const verdicts = useAuditStore((s) => s.fileVerdicts);
  const analyzing = useAuditStore((s) => s.analyzing);
  const scanned = useAuditStore((s) => s.scannedCount);
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [analyzing]);

  const flagged = Object.values(verdicts).filter(
    (verdict) => verdict.riskContribution >= RISK_SUSPICIOUS_THRESHOLD,
  ).length;
  const cleared = Object.values(verdicts).length - flagged;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border px-3 py-2">
        <h2 className="font-mono text-[10px] tracking-wider text-text-3 uppercase">files</h2>
        <p className="mt-0.5 font-mono text-xs text-text tabular-nums">
          {scanned}
          <span className="text-text-3">/{files.length || "…"} read</span>
        </p>
        <p className="font-mono text-[11px] text-text-3 tabular-nums">
          {cleared} cleared
          {flagged > 0 ? (
            <span className="text-danger-text"> · {flagged} flagged</span>
          ) : null}
        </p>
      </header>

      <ol className="min-h-0 flex-1 overflow-y-auto py-1">
        {files.map((file) => {
          const verdict = verdicts[file.path];
          const state: FileState =
            analyzing === file.path
              ? "reading"
              : verdict === undefined
                ? "pending"
                : verdict.riskContribution >= RISK_SUSPICIOUS_THRESHOLD
                  ? "flagged"
                  : "cleared";
          return (
            <li key={file.path} ref={state === "reading" ? activeRef : undefined}>
              <button
                type="button"
                onClick={() => onSelect(file.path)}
                aria-current={file.path === selected ? "true" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left",
                  "transition-colors duration-fast hover:bg-sunken",
                  state === "reading" && "bg-accent-wash",
                  state === "flagged" && "border-l-2 border-l-danger",
                  file.path === selected && "bg-sunken",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    state === "pending" && "bg-progress-track",
                    state === "reading" && "bg-accent motion-safe:animate-pulse",
                    state === "cleared" && "bg-progress-idle",
                    state === "flagged" && "bg-danger",
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate font-mono text-[11px]",
                    state === "pending" ? "text-text-3" : "text-text-2",
                  )}
                  title={file.path}
                >
                  {file.path}
                </span>
                {verdict?.suspiciousLines ? (
                  <span className="shrink-0 font-mono text-[10px] text-danger-text tabular-nums">
                    {verdict.suspiciousLines.split(",").length}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        {files.length === 0 ? (
          <li className="px-3 py-3 font-mono text-[11px] text-text-3">Waiting for the file list…</li>
        ) : null}
      </ol>
    </div>
  );
}
