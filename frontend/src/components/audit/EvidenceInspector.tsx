/**
 * The evidence inspector — everything frontend-safe the audit holds about one
 * selected node.
 *
 * It REPLACES the transcript rail rather than sitting beside it, because the two
 * answer different questions and a viewer asking "what is this node" is not
 * simultaneously reading the stream. On mobile it is a bottom sheet.
 *
 * ── Source excerpts are a READ, not a string ────────────────────────────────
 *
 * The source pane renders a `LoadState<string>`. That is not ceremony: a failed
 * fetch used to be written into the viewer as `"// " + err.message`, so engine
 * prose appeared in a code pane where the file's first line belongs — in the one
 * view whose entire job is showing what was audited. A viewer had no way to tell
 * a comment in the package from a message from us. The union makes the confusion
 * unspellable, and a failure names the file and offers a retry instead.
 */

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { DisplayObservation } from "@npmguard/shared";
import type { GraphNode } from "../../lib/evidence-graph.ts";
import { describeObservation, describeToolCall } from "../../lib/investigator-copy.ts";
import { useAuditStore } from "../../stores/auditStore.ts";
import { cn } from "../../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { DegradedRegion } from "../ui/degraded-state.tsx";
import { SourceViewer } from "../report/SourceViewer.tsx";
import { HypothesisStateStamp } from "../ui/verdict-stamp.tsx";
import { STATE_LABELS, hypothesisTone } from "../../lib/report-helpers.ts";

export interface EvidenceInspectorProps {
  node: GraphNode;
  onClose: () => void;
}

export function EvidenceInspector({ node, onClose }: EvidenceInspectorProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // Focus moves to the inspector when it opens, so a keyboard user is inside
    // the thing they just asked for rather than still on the canvas behind it.
    headingRef.current?.focus();
  }, [node.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <section
      aria-label="Evidence inspector"
      className="flex h-full min-h-0 flex-col bg-surface"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-2xs tracking-wide text-text-3 uppercase outline-none"
        >
          {node.kind}
        </h2>
        <Button variant="ghost" size="sm" aria-label="Close inspector" onClick={onClose}>
          <X aria-hidden="true" className="size-icon-sm" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <InspectorBody node={node} />
      </div>
    </section>
  );
}

function InspectorBody({ node }: { node: GraphNode }) {
  switch (node.data.kind) {
    case "package":
      return (
        <Facts
          rows={[
            ["Package", node.data.label],
            ["Version", node.data.version ?? "unresolved"],
          ]}
        />
      );

    case "coverage": {
      const { coverage } = node.data;
      return (
        <>
          <Facts
            rows={[
              ["Files in package", String(coverage.total)],
              ["Files read", String(coverage.scanned)],
              ["Cleared", String(coverage.cleared)],
              ["Flagged", String(coverage.flagged)],
            ]}
          />
          <p className="mt-3 text-2xs text-text-3">
            Coverage is a count of what was read. It is not a claim that the cleared files are
            safe — only that nothing in them raised a suspicion worth running.
          </p>
        </>
      );
    }

    case "source":
      return <SourceInspector file={node.data.source.file} ranges={node.data.source.ranges.map((r) => r.range).join(",")} summary={node.data.source.summary} />;

    case "cluster":
      return (
        <Facts
          rows={[
            ["File", node.data.cluster.file],
            ["Claim", node.data.cluster.claim],
            ["Suspicions", node.data.cluster.hypIds.join(", ")],
          ]}
        />
      );

    case "hypothesis": {
      const { hypothesis, absorbed } = node.data.hypothesis;
      return (
        <div className="grid gap-3">
          <div className="flex items-center gap-2">
            <HypothesisStateStamp
              state={hypothesis.state}
              tone={hypothesisTone(hypothesis.state)}
              label={STATE_LABELS[hypothesis.state]}
            />
            <span className="font-mono text-2xs text-text-3">{hypothesis.hypId}</span>
          </div>
          <p className="text-xs leading-relaxed text-text">{hypothesis.description}</p>
          <Facts
            rows={[
              ["Claim", hypothesis.claim],
              ["Severity", hypothesis.severity],
              ["Focus files", hypothesis.focusFiles.join(", ") || "—"],
              [
                "Focus lines",
                hypothesis.focusLines.map((range) => `${range.file}:${range.range}`).join(", ") ||
                  "none recorded",
              ],
              ["Resolved by", hypothesis.by ?? "—"],
              ...(absorbed.length
                ? ([["Also answers", absorbed.map((item) => item.hypId).join(", ")]] as [
                    string,
                    string,
                  ][])
                : []),
            ]}
          />
          {hypothesis.reason ? (
            <div>
              <SectionHead>Judgment</SectionHead>
              <p className="text-xs leading-relaxed text-text-2">{hypothesis.reason}</p>
            </div>
          ) : null}
          {hypothesis.evidenceRefs.length > 0 ? (
            <div>
              <SectionHead>Evidence</SectionHead>
              <Facts
                mono
                rows={hypothesis.evidenceRefs.map((ref) => [ref.kind, `${ref.id} · ${ref.hash.slice(0, 16)}…`])}
              />
            </div>
          ) : null}
        </div>
      );
    }

    case "run": {
      const { run, cited } = node.data.run;
      const display = run.display;
      return (
        <div className="grid gap-3">
          <Facts
            mono
            rows={[
              ["Run", run.runId],
              ["Trigger", `${run.trigger.kind}:${run.trigger.target}`],
              ...(display
                ? ([
                    ["Wall time", `${Math.round(display.wallMs)}ms`],
                    ["Exit", display.timedOut ? "timed out" : String(display.exitCode)],
                    ["Events", String(display.eventCount)],
                    ["Content hash", `${display.contentHash.slice(0, 16)}…`],
                  ] as [string, string][])
                : ([["State", run.stage]] as [string, string][])),
            ]}
          />

          {display?.error ? (
            <div>
              <SectionHead>Run error</SectionHead>
              <p className="text-xs text-error-text">
                {display.error.kind}: {display.error.detail}
              </p>
            </div>
          ) : null}

          <div>
            <SectionHead>Experiment</SectionHead>
            <Facts mono rows={run.experiment.map((call) => {
              const described = describeToolCall(call);
              return [described.label, described.value];
            })} />
            <p className="mt-1 text-2xs text-text-3">
              Planted values are synthetic bait, never real credentials.
            </p>
          </div>

          {display ? (
            <div>
              <SectionHead>Setup applied</SectionHead>
              <Facts
                mono
                rows={[
                  [
                    "Environment",
                    display.setupApplied.envKeys.length
                      ? `${display.setupApplied.envKeys.join(", ")} · [synthetic secret]`
                      : "—",
                  ],
                  [
                    "Planted files",
                    display.setupApplied.plantedFiles.map((file) => file.path).join(", ") || "—",
                  ],
                  [
                    "Stubs",
                    display.setupApplied.stubUrls
                      .map((stub) => `${stub.pattern} ${stub.served ? "· served" : "· never contacted"}`)
                      .join(", ") || "—",
                  ],
                  ["Patched", display.setupApplied.patchedFiles.join(", ") || "—"],
                  ["Preload", display.setupApplied.preloaded ? "injected" : "—"],
                ]}
              />
            </div>
          ) : null}

          {display ? (
            <div>
              <SectionHead>Observations</SectionHead>
              <ObservationList observations={run.observations} cited={new Set(run.citedEventIds)} />
              {display.omittedObservationCount > 0 ? (
                // Truncation is stated, never silent: a shortened list that reads
                // as complete is the same lie as a green badge over unread code.
                <p className="mt-1.5 text-2xs text-text-3 tabular-nums">
                  {display.omittedObservationCount} further event
                  {display.omittedObservationCount === 1 ? "" : "s"} were recorded and are not
                  shown. Every event the judgment cited is above.
                </p>
              ) : null}
            </div>
          ) : null}

          {cited.length > 0 ? (
            <div>
              <SectionHead>Cited by the judgment</SectionHead>
              <ObservationList observations={cited} cited={new Set(cited.map((o) => o.eventId))} />
            </div>
          ) : null}

          {display ? (
            <div>
              <SectionHead>Captures</SectionHead>
              <Facts
                mono
                rows={Object.entries(display.captures).map(([name, hash]) => [
                  name.replace(/Hash$/, ""),
                  hash ? `${hash.slice(0, 16)}…` : "not captured",
                ])}
              />
            </div>
          ) : null}
        </div>
      );
    }

    case "verdict": {
      const { verdict } = node.data;
      return (
        <div className="grid gap-3">
          <p className="text-sm font-semibold text-text">
            {verdict.verdict === "INCOMPLETE" ? "Could not conclude" : verdict.verdict}
          </p>
          <p className="text-xs leading-relaxed text-text-2">{verdict.rationale}</p>
          <Facts
            rows={[
              ["Files read", `${verdict.coverage.scanned} of ${verdict.coverage.total}`],
              ["Cleared", String(verdict.coverage.cleared)],
              ["Confirmed", verdict.confirmedHypIds.join(", ") || "none"],
            ]}
          />
        </div>
      );
    }
  }
}

/**
 * The source excerpt for a flagged file.
 *
 * The read is fetched on selection and rendered from its `LoadState`. A failure
 * renders a degraded region naming the file — it never becomes text in the code
 * pane, which is the only way a reader could mistake our message for the
 * package's own first line.
 */
function SourceInspector({
  file,
  ranges,
  summary,
}: {
  file: string;
  ranges: string;
  summary: string;
}) {
  const selectFile = useAuditStore((s) => s.selectFile);
  const selectedFile = useAuditStore((s) => s.selectedFile);
  const source = useAuditStore((s) => s.source);

  useEffect(() => {
    if (selectedFile !== file) selectFile(file);
  }, [file, selectFile, selectedFile]);

  return (
    <div className="grid gap-3">
      <p className="font-mono text-xs break-all text-text">{file}</p>
      {ranges ? <p className="font-mono text-2xs text-accent-text">lines {ranges}</p> : null}
      {summary ? <p className="text-xs leading-relaxed text-text-2">{summary}</p> : null}
      <SectionHead>Source</SectionHead>
      {source.status === "failed" ? (
        <DegradedRegion title="Source" failure={source.failure} />
      ) : (
        <div className="overflow-hidden rounded border border-border-faint">
          <SourceViewer
            code={source.status === "ok" ? source.data : null}
            filename={file}
            loading={source.status === "loading"}
            highlightLines={ranges || undefined}
          />
        </div>
      )}
    </div>
  );
}

function ObservationList({
  observations,
  cited,
}: {
  observations: readonly DisplayObservation[];
  cited: ReadonlySet<string>;
}) {
  if (observations.length === 0) {
    return <p className="text-2xs text-text-3">No sensor events were recorded for this run.</p>;
  }
  return (
    <ol className="grid gap-0.5">
      {observations.map((observation) => (
        <li
          key={observation.eventId}
          className={cn(
            "flex items-baseline gap-2 font-mono text-2xs",
            cited.has(observation.eventId) ? "text-danger-text" : "text-text-2",
          )}
        >
          <span className="w-10 shrink-0 text-text-3">{observation.eventId}</span>
          <span className="min-w-0 break-all">{describeObservation(observation)}</span>
        </li>
      ))}
    </ol>
  );
}

function SectionHead({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1 text-2xs tracking-wide text-text-3 uppercase">{children}</h3>
  );
}

function Facts({ rows, mono = false }: { rows: [string, string][]; mono?: boolean }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-2xs whitespace-nowrap text-text-3">{label}</dt>
          <dd className={cn("break-all text-2xs text-text-2", mono && "font-mono")}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
