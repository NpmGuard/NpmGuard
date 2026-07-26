/**
 * The investigation transcript — the contextual rail's default occupant.
 *
 * Mixed by design: concise investigator prose for what was suspected and
 * concluded, structured machine cards for what was actually done. The two are
 * visually distinct because a reader must always be able to tell which words are
 * the product's and which are the run's — a tool call rendered as a sentence
 * invites the reader to trust a paraphrase.
 *
 * Every line is generated from an event by a fixed template
 * (`lib/investigator-copy.ts`). No model writes interface copy, and nothing here
 * displays hidden reasoning: what a viewer reads is what the audit RECORDED.
 *
 * ── Rhythm ──────────────────────────────────────────────────────────────────
 *
 * Entries are separated by hairlines and led by a mono eyebrow, so the stream
 * scans as a log rather than as prose. Exactly one entry class gets a tinted
 * panel with a coloured rule — the judgment — because that is the line a reader
 * came to find. Tinting more than one thing is how a dense stream stops having
 * a focal point at all.
 */

import { useEffect, useRef } from "react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { transcriptFor, type TranscriptEntry } from "../../lib/investigator-copy.ts";
import { cn } from "../../lib/cn.ts";
import { LiveStatus } from "./LiveStatus.tsx";

const EYEBROW: Record<TranscriptEntry["kind"], string> = {
  milestone: "audit",
  narration: "observed",
  action: "action",
  observation: "sandbox",
  judgment: "judgment",
};

export function InvestigationTranscript() {
  const frames = useAuditStore((s) => s.tape.frames);
  const playhead = useAuditStore((s) => s.playhead);
  const entries = transcriptFor(frames, playhead);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Follow the tail only while the viewer is at it. Scrolling someone back to
    // the bottom while they are reading history is the same class of theft as a
    // camera that re-frames mid-inspection.
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [entries.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p className="px-3 py-6 text-xs leading-relaxed text-text-3">
            The transcript fills in as the investigation records what it did.
          </p>
        ) : (
          <ol aria-label="Investigation transcript">
            {entries.map((entry) => (
              <TranscriptRow key={`${entry.index}-${entry.kind}`} entry={entry} />
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>
      {/* Pinned: what is happening NOW is the continuation of what has happened,
          and it belongs where the reader's eye already is. */}
      <LiveStatus className="shrink-0" />
    </div>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const judgment = entry.kind === "judgment";
  return (
    <li
      className={cn(
        "border-b border-border-faint px-3 py-2.5",
        judgment && "border-l-[3px] border-l-danger bg-danger-wash pl-2.5",
      )}
    >
      <p className="font-mono text-[10px] tracking-wider text-text-3 uppercase">
        {EYEBROW[entry.kind]}
      </p>
      {/* Clamped. A file summary is model prose and runs to a paragraph; the
          transcript is a stream a reader scans, and one entry that fills the rail
          buries the three around it. The whole text is in the inspector. */}
      <p
        className={cn(
          "mt-1 line-clamp-3 text-xs leading-relaxed",
          entry.kind === "milestone" || judgment ? "font-medium text-text" : "text-text-2",
        )}
      >
        {entry.text}
      </p>
      {entry.fields && entry.fields.length > 0 ? (
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5">
          {entry.fields.slice(0, 6).map((field, index) => (
            <div key={`${field.label}-${index}`} className="contents">
              <dt className="font-mono text-[11px] whitespace-nowrap text-text-3">{field.label}</dt>
              <dd className="truncate font-mono text-[11px] text-text-2">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {entry.fields && entry.fields.length > 6 ? (
        <p className="mt-0.5 font-mono text-[11px] text-text-3">
          +{entry.fields.length - 6} more
        </p>
      ) : null}
    </li>
  );
}
