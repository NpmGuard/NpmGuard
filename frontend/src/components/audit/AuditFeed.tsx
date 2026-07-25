/**
 * AuditFeed — the streaming narrative. Renders store.pipelineLog as an ordered
 * feed via ONE switch over entry.kind (phase / info / scripts / hypothesis /
 * file-group). Adjacent file-scan / file-flag entries COALESCE into a single
 * "N files · M flagged" disclosure (a flat reduce — never a recursive tree).
 * While running it appends a synthesized indicator row. Intent-based auto-scroll
 * pins to the bottom, releases on user scroll-up, and offers a "jump to latest".
 * All state is fold-derived — this component never re-derives the stream.
 */

import { ChevronRight, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { FOCUS_RING } from "../ui/focus.ts";
import { cn } from "../../lib/cn.ts";
import { useAuditStore } from "../../stores/auditStore.ts";
import { riskContributionToStatus, type PipelineLogEntry } from "../../lib/types.ts";

export interface AuditFeedProps {
  compact?: boolean;
}

/** One feed row. Kept as a const rather than repeated per arm so the rows share
 * a rhythm and a new row kind cannot quietly land on a different one. */
const ROW = "flex items-center gap-2 px-3 py-1.5";

interface FileFlag {
  file: string;
  text: string;
  risk: number;
}

type FeedRow =
  | { key: string; kind: "phase"; text: string }
  | { key: string; kind: "info"; text: string }
  | { key: string; kind: "scripts"; text: string; scripts: Record<string, string> }
  | { key: string; kind: "hypothesis"; text: string }
  | { key: string; kind: "file-group"; scanned: number; flagged: FileFlag[] };

/** Flat reduce: fold pipelineLog into render rows, coalescing runs of
 * file-scan/file-flag into one disclosure. Keys are deterministic from the
 * (append-only) log so React never reuses a fiber across two distinct rows. */
function buildRows(log: PipelineLogEntry[]): FeedRow[] {
  const rows: FeedRow[] = [];
  const seen = new Map<string, number>();
  const keyFor = (parts: string): string => {
    const n = (seen.get(parts) ?? 0) + 1;
    seen.set(parts, n);
    return `${parts}#${n}`;
  };

  let group: { key: string; scanned: number; flagged: FileFlag[] } | null = null;
  const flush = () => {
    if (group) {
      rows.push({ key: group.key, kind: "file-group", scanned: group.scanned, flagged: group.flagged });
      group = null;
    }
  };

  for (const e of log) {
    if (e.kind === "file-scan" || e.kind === "file-flag") {
      if (!group) group = { key: keyFor(`fg:${e.timestamp}`), scanned: 0, flagged: [] };
      if (e.kind === "file-scan") group.scanned += 1;
      else group.flagged.push({ file: e.file ?? "", text: e.text, risk: e.risk ?? 0 });
      continue;
    }
    flush();
    const base = `${e.kind}:${e.timestamp}:${e.file ?? e.text}`;
    if (e.kind === "scripts") {
      rows.push({ key: keyFor(base), kind: "scripts", text: e.text, scripts: e.scripts ?? {} });
    } else if (e.kind === "phase") {
      rows.push({ key: keyFor(base), kind: "phase", text: e.text });
    } else if (e.kind === "hypothesis") {
      rows.push({ key: keyFor(base), kind: "hypothesis", text: e.text });
    } else {
      rows.push({ key: keyFor(base), kind: "info", text: e.text });
    }
  }
  flush();
  return rows;
}

/** The risk bar's fill. `dangerous` is the only hue — see FileTree's header: a
 * flag is not a verdict, so a merely-flagged file gets an achromatic bar on the
 * progress axis rather than the deleted `suspect` amber. */
function riskFillClass(risk: number): string {
  return riskContributionToStatus(risk) === "dangerous" ? "bg-danger" : "bg-progress-mark";
}

function FeedRowView({ row, compact }: { row: FeedRow; compact: boolean }): ReactElement {
  // Group disclosure open-state is local (uncontrolled would snap back on every
  // streaming re-render since the row prop is stable). Default-open a flagged
  // group in the full view.
  const [open, setOpen] = useState(
    row.kind === "file-group" && row.flagged.length > 0 && !compact,
  );

  switch (row.kind) {
    case "phase":
      return (
        <li
          data-feed-row="phase"
          className={cn(ROW, "border-t border-border-faint bg-sunken first:border-t-0")}
        >
          <span className="font-mono text-2xs font-medium tracking-wide text-text-3 uppercase">
            {row.text}
          </span>
        </li>
      );
    case "scripts":
      return (
        <li className={ROW}>
          {/* Neutral chips. These label WHAT the line is about — they are the
              metadata voice (§3.2), not an assessment, and the deleted `suspect`
              amber they used to wear made every install-script line read as a
              finding. */}
          <Badge>scripts</Badge>
          <span className="text-sm text-text-2">{row.text}</span>
        </li>
      );
    case "hypothesis":
      return (
        <li className={ROW}>
          <Badge>hypothesis</Badge>
          <span className="text-sm text-text-2">{row.text}</span>
        </li>
      );
    case "file-group":
      return (
        <li className={cn(ROW, "block")}>
          <details
            open={open}
            onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary
              className={cn(
                "flex cursor-pointer list-none items-center gap-2 rounded-sm",
                FOCUS_RING,
              )}
            >
              <ChevronRight
                aria-hidden="true"
                className="size-icon-sm shrink-0 text-text-3 transition-transform duration-fast in-open:rotate-90"
              />
              <span className="text-sm text-text-2">
                {row.scanned} file{row.scanned === 1 ? "" : "s"} scanned
              </span>
              {row.flagged.length > 0 ? (
                <Badge>{row.flagged.length} flagged</Badge>
              ) : (
                <span className="text-2xs text-text-3">· none flagged</span>
              )}
            </summary>
            {row.flagged.length > 0 ? (
              <ul className="mt-2 grid gap-1.5 ps-6">
                {row.flagged.map((f, i) => (
                  <li key={`${f.file}-${i}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-2xs text-text">
                      {f.file || "(file)"}
                    </span>
                    <span
                      aria-hidden="true"
                      className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-progress-track"
                    >
                      <span
                        className={cn("block h-full", riskFillClass(f.risk))}
                        style={{ width: `${Math.min(100, Math.max(0, f.risk * 10))}%` }}
                      />
                    </span>
                    {f.text ? (
                      <span className="min-w-0 flex-1 truncate text-2xs text-text-3">{f.text}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        </li>
      );
    case "info":
    default:
      return (
        <li className={ROW}>
          <span className="text-2xs text-text-3">{row.text}</span>
        </li>
      );
  }
}

export function AuditFeed({ compact = false }: AuditFeedProps) {
  const pipelineLog = useAuditStore((s) => s.pipelineLog);
  const running = useAuditStore((s) => s.running);

  const rows = useMemo(() => buildRows(pipelineLog), [pipelineLog]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLOListElement>(null);
  const pinnedRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // At bottom within a 1px tolerance → keep the pin; a scroll-up releases it.
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    pinnedRef.current = bottom;
    setAtBottom(bottom);
  }, []);

  // Re-pin on content growth ONLY if still at the bottom (ResizeObserver watches
  // the inner list so a row changing height re-pins too).
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  const jump = () => {
    pinnedRef.current = true;
    setAtBottom(true);
    scrollToBottom();
  };

  return (
    <div className="relative">
      <div
        // Wide/tall content scrolls inside its own container, never the page
        // body (§3.1). The height cap is what makes the feed a pane rather than
        // an unbounded column that pushes the verdict dock off screen.
        className={cn("overflow-y-auto", compact ? "max-h-64" : "max-h-[28rem]")}
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Audit activity"
        aria-live="polite"
        aria-busy={running}
      >
        <ol ref={contentRef}>
          {rows.map((row) => (
            <FeedRowView key={row.key} row={row} compact={compact} />
          ))}
          {running ? (
            <li className={ROW} aria-label="Audit running">
              <LoaderCircle
                aria-hidden="true"
                strokeWidth={1.5}
                className="size-icon-sm shrink-0 animate-spin text-progress-mark motion-reduce:animate-none"
              />
              <span className="text-2xs text-text-3">Working…</span>
            </li>
          ) : null}
          {rows.length === 0 && !running ? (
            <li className={ROW}>
              <span className="text-2xs text-text-3">No activity recorded</span>
            </li>
          ) : null}
        </ol>
      </div>

      {!atBottom ? (
        <Button
          variant="outline"
          size="sm"
          onClick={jump}
          aria-label="jump to latest activity"
          className="absolute inset-x-0 bottom-2 mx-auto w-max shadow-pop"
        >
          Jump to latest
        </Button>
      ) : null}
    </div>
  );
}
