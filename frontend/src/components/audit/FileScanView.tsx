/**
 * The scan — what the audit does before it has anything to suspect.
 *
 * The workspace opens here, not on the graph. Every file in the package is a
 * tile; tiles light as the pipeline reads them and settle into cleared or
 * flagged, with the flagged ones carrying the exact line ranges that will become
 * hypothesis edges a moment later.
 *
 * ── Why this phase exists at all ────────────────────────────────────────────
 *
 * A coverage counter is TRUE but it is not legible: "126 files cleared" arriving
 * as a number asks a viewer to take the reading on faith, which is the one thing
 * this product cannot ask for. Watching the files go past is the difference
 * between being told the package was read and seeing it read. It is also where
 * the graph's roots come from — a source node is a tile that turned red — so the
 * transform is a continuation rather than a scene change.
 *
 * ── The colour rule, again, because this is where it is easiest to break ────
 *
 * A cleared file is ACHROMATIC. Not green. Two hundred green tiles is two
 * hundred individual safety claims, and the audit made none of them — it read
 * the file and found nothing worth running. Red marks a file the audit means to
 * test, which is a statement about what happens next, not a verdict.
 */

import { motion, useReducedMotion } from "motion/react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { RISK_SUSPICIOUS_THRESHOLD } from "../../lib/types.ts";
import { cn } from "../../lib/cn.ts";

type TileState = "pending" | "reading" | "cleared" | "flagged";

export function FileScanView() {
  const files = useAuditStore((s) => s.files);
  const verdicts = useAuditStore((s) => s.fileVerdicts);
  const analyzing = useAuditStore((s) => s.analyzing);
  const scanned = useAuditStore((s) => s.scannedCount);
  const reduce = useReducedMotion();

  const flagged = Object.values(verdicts).filter(
    (verdict) => verdict.riskContribution >= RISK_SUSPICIOUS_THRESHOLD,
  ).length;
  const cleared = Object.values(verdicts).length - flagged;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-border px-4 py-2.5">
        <h2 className="font-mono text-[10px] tracking-wider text-text-3 uppercase">
          reading the package
        </h2>
        <p className="font-mono text-xs text-text tabular-nums">
          {scanned}
          <span className="text-text-3">/{files.length || "…"} files</span>
        </p>
        {cleared > 0 ? (
          <p className="font-mono text-[11px] text-text-3 tabular-nums">{cleared} cleared</p>
        ) : null}
        {flagged > 0 ? (
          <p className="font-mono text-[11px] text-danger-text tabular-nums">
            {flagged} to investigate
          </p>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto bg-sunken p-4">
        <ol className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
          {files.map((file) => {
            const verdict = verdicts[file.path];
            const state: TileState = analyzing === file.path
              ? "reading"
              : verdict === undefined
                ? "pending"
                : verdict.riskContribution >= RISK_SUSPICIOUS_THRESHOLD
                  ? "flagged"
                  : "cleared";
            return (
              <Tile
                key={file.path}
                path={file.path}
                state={state}
                lines={verdict?.suspiciousLines ?? null}
                reduce={Boolean(reduce)}
              />
            );
          })}
        </ol>
        {files.length === 0 ? (
          <p className="px-1 py-6 font-mono text-xs text-text-3">Waiting for the file list…</p>
        ) : null}
      </div>
    </div>
  );
}

function Tile({
  path,
  state,
  lines,
  reduce,
}: {
  path: string;
  state: TileState;
  lines: string | null;
  reduce: boolean;
}) {
  return (
    <motion.li
      layout={!reduce}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      data-scan={state}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5",
        state === "pending" && "border-border-faint bg-surface/50",
        // The file being read right now is the ONLY accent on this screen, so
        // the eye tracks the read rather than hunting for it.
        state === "reading" && "border-accent-border bg-accent-wash",
        state === "cleared" && "border-border-faint bg-surface",
        state === "flagged" && "border-danger-border border-l-[3px] border-l-danger bg-danger-wash",
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
      >
        {path}
      </span>
      {lines ? (
        <span className="shrink-0 truncate font-mono text-[11px] text-danger-text tabular-nums">
          {lines.split(",").slice(0, 2).join(" ")}
        </span>
      ) : null}
      {state === "reading" ? (
        <span className="shrink-0 font-mono text-[10px] tracking-wider text-accent-text uppercase">
          reading
        </span>
      ) : null}
    </motion.li>
  );
}
