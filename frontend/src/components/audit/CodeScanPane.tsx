/**
 * The code pane — the file the audit is reading, with the scan passing over it.
 *
 * This is the half of the workspace that shows WHAT WAS READ. A coverage counter
 * is true but it is not legible: "126 files cleared" asks a viewer to take the
 * reading on faith, which is the one thing this product cannot ask for. Watching
 * a scan cross real source, and lines turn red behind it, is the difference
 * between being told the package was read and seeing it read.
 *
 * ── The scan line is a PACE, not a claim ────────────────────────────────────
 *
 * ONE pass, top to bottom, taking exactly as long as this file holds the
 * playhead. It does not track a cursor inside the model, because there is no
 * such cursor — the engine reads a file in one call. So the sweep says "this
 * file is being read now", which is true, and says nothing about position,
 * which would not be. A looping sweep would say "still working" for as long as
 * it ran, which is a claim about duration the events do not support.
 *
 * Under `prefers-reduced-motion` it does not run at all; the file is still
 * named and its ranges still land.
 *
 * ── Ranges are the graph's roots ────────────────────────────────────────────
 *
 * The red bands here are the exact `focusLines` that a moment later become the
 * source node a hypothesis edge originates at. Same numbers, same colour, one
 * continuous story — which is why the scan is worth building rather than
 * summarising.
 */

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { fetchAuditFile } from "../../lib/api.ts";
import { parseLineRanges } from "../../lib/types.ts";
import { cn } from "../../lib/cn.ts";

/**
 * Sources for the scan, fetched once per file and kept.
 *
 * A module-level cache rather than store state: it is not a fact about the
 * audit, it is a copy of bytes the engine already served, and putting it in the
 * fold would make every seek re-derive a network read.
 */
const cache = new Map<string, string>();

function useSource(auditId: string | null, path: string | null): string | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!auditId || !path || cache.has(path)) return;
    let live = true;
    void fetchAuditFile(auditId, path)
      .then((text) => {
        cache.set(path, text);
        if (live) force((tick) => tick + 1);
      })
      .catch(() => {
        // A source the engine will not serve is not an error worth interrupting
        // a replay for — the pane names the file and shows no body, which is
        // exactly what it knows.
      });
    return () => {
      live = false;
    };
  }, [auditId, path]);
  return path ? (cache.get(path) ?? null) : null;
}

export interface CodeScanPaneProps {
  auditId: string | null;
  /** the file to show, or null */
  path: string | null;
  /** comma-separated 1-based ranges to mark, e.g. "18-42,84-84" */
  ranges: string | null;
  /** true while this file is the one being read */
  scanning: boolean;
  /** how long this file holds the playhead — the sweep takes exactly that long */
  dwellMs: number;
}

const MAX_LINES = 400;

export function CodeScanPane({ auditId, path, ranges, scanning, dwellMs }: CodeScanPaneProps) {
  const source = useSource(auditId, path);
  const reduce = useReducedMotion();

  if (!path) {
    return (
      <div className="grid h-full place-items-center p-6">
        <p className="max-w-xs text-center text-xs leading-relaxed text-text-3">
          The source of each file appears here as the audit reads it.
        </p>
      </div>
    );
  }

  const flagged = new Set<number>();
  for (const [from, to] of parseLineRanges(ranges)) {
    for (let line = from; line <= to; line += 1) flagged.add(line);
  }

  const lines = (source ?? "").split("\n").slice(0, MAX_LINES);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            scanning ? "bg-accent motion-safe:animate-pulse" : flagged.size ? "bg-danger" : "bg-progress-idle",
          )}
        />
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-text">{path}</p>
        {flagged.size > 0 ? (
          <p className="shrink-0 font-mono text-[11px] text-danger-text tabular-nums">
            {flagged.size} line{flagged.size === 1 ? "" : "s"} flagged
          </p>
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-sunken">
        {/* The sweep. `key` on the path restarts it for each file, so every file
            gets its own pass rather than inheriting the previous one's phase. */}
        {scanning && !reduce ? (
          <div
            key={path}
            aria-hidden="true"
            className="ng-scanline z-10"
            style={{ "--ng-scan-duration": `${dwellMs}ms` } as React.CSSProperties}
          />
        ) : null}

        <pre className="h-full overflow-auto px-3 py-2 font-mono text-[11px] leading-[1.45]">
          {source === null ? (
            <span className="text-text-3">reading…</span>
          ) : (
            lines.map((line, index) => {
              const number = index + 1;
              const marked = flagged.has(number);
              return (
                <span
                  key={number}
                  data-flagged={marked ? "true" : undefined}
                  className={cn(
                    "flex gap-3 px-1",
                    // The band persists once the file is judged: these are the
                    // exact ranges the graph will draw a hypothesis edge from.
                    marked && "border-l-2 border-l-danger bg-danger-wash",
                  )}
                >
                  <span className="w-8 shrink-0 text-right text-text-3 tabular-nums select-none">
                    {number}
                  </span>
                  <span className={cn("min-w-0 whitespace-pre", marked ? "text-text" : "text-text-2")}>
                    {line || " "}
                  </span>
                </span>
              );
            })
          )}
        </pre>
      </div>
    </div>
  );
}
