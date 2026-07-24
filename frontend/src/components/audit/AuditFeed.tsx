/**
 * AuditFeed — the streaming narrative. Renders store.pipelineLog as an ordered
 * feed via ONE switch over entry.kind (phase / info / scripts / hypothesis /
 * file-group). Adjacent file-scan / file-flag entries COALESCE into a single
 * "N files · M flagged" disclosure (a flat reduce — never a recursive tree).
 * While running it appends a synthesized indicator row. Intent-based auto-scroll
 * pins to the bottom, releases on user scroll-up, and offers a "jump to latest".
 * All state is fold-derived — this component never re-derives the stream.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { riskContributionToStatus, type PipelineLogEntry } from "../../lib/types.ts";

export interface AuditFeedProps {
  compact?: boolean;
}

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

function riskMeterTone(risk: number): "safe" | "suspect" | "danger" {
  const status = riskContributionToStatus(risk);
  return status === "dangerous" ? "danger" : status === "suspicious" ? "suspect" : "safe";
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
        <li className="audit-feed__row audit-feed__row--phase">
          <span className="eyebrow">{row.text}</span>
        </li>
      );
    case "scripts":
      return (
        <li className="audit-feed__row audit-feed__row--scripts">
          <span className="tag tag--suspect">scripts</span>
          <span className="subtext">{row.text}</span>
        </li>
      );
    case "hypothesis":
      return (
        <li className="audit-feed__row audit-feed__row--hyp">
          <span className="tag tag--suspect">hypothesis</span>
          <span className="subtext">{row.text}</span>
        </li>
      );
    case "file-group":
      return (
        <li className="audit-feed__row audit-feed__row--group">
          <details
            className="audit-group"
            open={open}
            onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary className="audit-group__summary">
              <span
                className={`dot ${row.flagged.length > 0 ? "dot--suspect" : "dot--safe"}`}
                aria-hidden="true"
              />
              <span className="subtext">
                {row.scanned} file{row.scanned === 1 ? "" : "s"} scanned
              </span>
              {row.flagged.length > 0 ? (
                <span className="tag tag--suspect">{row.flagged.length} flagged</span>
              ) : (
                <span className="microtext">· none flagged</span>
              )}
            </summary>
            {row.flagged.length > 0 ? (
              <ul className="audit-group__flags">
                {row.flagged.map((f, i) => (
                  <li key={`${f.file}-${i}`} className="audit-flag">
                    <span className="audit-flag__file mono">{f.file || "(file)"}</span>
                    <span className="meter audit-flag__meter" aria-hidden="true">
                      <span
                        className={`meter__fill meter__fill--${riskMeterTone(f.risk)}`}
                        style={{ width: `${Math.min(100, Math.max(0, f.risk * 10))}%` }}
                      />
                    </span>
                    {f.text ? <span className="subtext audit-flag__text">{f.text}</span> : null}
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
        <li className="audit-feed__row audit-feed__row--info">
          <span className="microtext">{row.text}</span>
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
    <div className={`audit-feed${compact ? " audit-feed--compact" : ""}`}>
      <div
        className="audit-feed__scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Audit activity"
        aria-live="polite"
        aria-busy={running}
      >
        <ol className="audit-feed__list" ref={contentRef}>
          {rows.map((row) => (
            <FeedRowView key={row.key} row={row} compact={compact} />
          ))}
          {running ? (
            <li className="audit-feed__row audit-feed__indicator" aria-label="Audit running">
              <span className="thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="microtext">Working…</span>
            </li>
          ) : null}
          {rows.length === 0 && !running ? (
            <li className="audit-feed__row audit-feed__row--info">
              <span className="microtext">No activity recorded</span>
            </li>
          ) : null}
        </ol>
      </div>

      {!atBottom ? (
        <button
          type="button"
          className="btn btn--sm audit-feed__jump"
          onClick={jump}
          aria-label="jump to latest activity"
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
