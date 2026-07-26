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
 */

import { useEffect, useRef } from "react";
import { useAuditStore } from "../../stores/auditStore.ts";
import { transcriptFor, type TranscriptEntry } from "../../lib/investigator-copy.ts";
import { cn } from "../../lib/cn.ts";
import { EmptyState } from "../ui/empty-state.tsx";
import { loaded } from "../ui/load-state.ts";

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

  // The tape is in hand and it says nothing has been recorded yet — a real read
  // of a real absence, which is exactly the proof `EmptyState` demands.
  const read = loaded(entries);
  if (entries.length === 0 && read.status === "ok") {
    return (
      <EmptyState
        read={read.read}
        message="Nothing recorded yet"
        hint="The transcript fills in as the investigation records what it did."
      />
    );
  }

  return (
    <ol className="grid gap-3 px-3 py-3" aria-label="Investigation transcript">
      {entries.map((entry) => (
        <TranscriptRow key={`${entry.index}-${entry.kind}`} entry={entry} />
      ))}
      <div ref={endRef} />
    </ol>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const machine = entry.kind === "action" || entry.kind === "observation";
  return (
    <li className="grid gap-1.5">
      <p
        className={cn(
          "text-xs leading-relaxed",
          entry.kind === "milestone" && "font-medium text-text",
          entry.kind === "narration" && "text-text-2",
          entry.kind === "judgment" && "text-text",
          machine && "text-text-3",
        )}
      >
        {entry.text}
      </p>
      {entry.fields && entry.fields.length > 0 ? (
        <dl
          className={cn(
            "grid gap-x-2 gap-y-0.5 rounded border border-border-faint bg-sunken px-2 py-1.5",
            "grid-cols-[auto_minmax(0,1fr)]",
          )}
        >
          {entry.fields.map((field, index) => (
            <div key={`${field.label}-${index}`} className="contents">
              <dt className="font-mono text-2xs whitespace-nowrap text-text-3">{field.label}</dt>
              <dd className="truncate font-mono text-2xs text-text-2">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
