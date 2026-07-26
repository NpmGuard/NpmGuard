/**
 * The audit workspace — the product's signature surface.
 *
 * ── The shape, and why it changes over the run ──────────────────────────────
 *
 * It opens as an editor, in the arrangement this product already had: the
 * ACTIVITY log on the left, the CODE in the middle with a scan crossing it and
 * ranges turning red behind, the FILE EXPLORER on the right. None of that is
 * new, and keeping it is the point — someone who has used this before should
 * recognise the screen.
 *
 * What is new is the GRAPH, and it arrives the way a panel does rather than the
 * way a new screen does. It opens on the right once there is a suspicion to put
 * in it, takes the file explorer's slot as the investigation moves into the
 * sandbox, and by the verdict it has the room. The code shrinks but stays: a
 * hypothesis is still ABOUT lines somebody may want to look at.
 *
 * So the active file becomes less relevant over the run rather than being taken
 * away, and the graph reads as something that grew out of the files — the red
 * bands in the source are literally the ranges its first edges are drawn from. A
 * cross-fade between two screens would claim the same thing and prove none of it.
 *
 * ── Why the dock is rendered from the first frame ───────────────────────────
 *
 * Playback controls and the verdict dock occupy stable bottom regions that exist
 * before there is anything to put in them. A verdict that arrives into a slot the
 * eye is already watching lands; a verdict that CREATES its slot pushes the whole
 * layout at the exact moment the viewer is reading it.
 *
 * ── The three states this screen must never confuse ─────────────────────────
 *
 *   DANGEROUS   — a confirmed hypothesis with cited evidence. Red.
 *   SAFE        — every suspicion ran and none confirmed. Green, quiet, and
 *                 always with its coverage and its caveat.
 *   INCOMPLETE  — the audit could not conclude. Violet, never red and never
 *                 green: "our sandbox would not start" is not a claim about the
 *                 package, and rendering it in either outcome colour manufactures
 *                 a verdict out of an infrastructure failure.
 */

import { useEffect, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { motion } from "motion/react";
import { PanelRight } from "lucide-react";
import { useAuditStore, unseenCount } from "../../stores/auditStore.ts";
import { isRichReplay } from "../../lib/audit-fold.ts";
import { projectEvidenceGraph } from "../../lib/evidence-graph.ts";
import { PHASE_LABELS, RISK_SUSPICIOUS_THRESHOLD } from "../../lib/types.ts";
import { HOLD_MS, animationScale, fileScanScale } from "../../lib/replay-clock.ts";
import { cn } from "../../lib/cn.ts";
import { DegradedSurface } from "../ui/degraded-state.tsx";
import { ProgressStamp, VerdictStamp } from "../ui/verdict-stamp.tsx";
import { Button } from "../ui/button.tsx";
import { CodeScanPane } from "./CodeScanPane.tsx";
import { EvidenceGraphCanvas } from "./EvidenceGraph.tsx";
import { EvidenceInspector } from "./EvidenceInspector.tsx";
import { FileScanView } from "./FileScanView.tsx";
import { InvestigationTranscript } from "./InvestigationTranscript.tsx";
import { MobileEvidenceSpine } from "./MobileEvidenceSpine.tsx";
import { PhaseRail } from "./PhaseRail.tsx";
import { ReplayControls, useReplayKeyboard } from "./ReplayControls.tsx";
import { VerdictReveal } from "./VerdictReveal.tsx";

/**
 * How much of the middle the graph has taken, 0 → 1.
 *
 * Driven by what the investigation has REACHED, not by a timer: nothing to show
 * (0), suspicions raised, experiments running, concluded. The code keeps a share
 * until the very end, because a hypothesis is still ABOUT lines somebody may
 * want to look at while it is being tested.
 */
function graphWeight(hasHypotheses: boolean, hasRuns: boolean, concluded: boolean): number {
  if (concluded) return 1;
  if (hasRuns) return 0.72;
  if (hasHypotheses) return 0.45;
  return 0;
}

export function AuditView() {
  const packageName = useAuditStore((s) => s.packageName);
  const version = useAuditStore((s) => s.inventoryMeta?.metadata.version ?? null);
  const auditId = useAuditStore((s) => s.auditId);
  const running = useAuditStore((s) => s.running);
  const phase = useAuditStore((s) => s.phase);
  const verdict = useAuditStore((s) => s.verdict);
  const error = useAuditStore((s) => s.error);
  const analyzing = useAuditStore((s) => s.analyzing);
  const fileVerdicts = useAuditStore((s) => s.fileVerdicts);
  const reconnecting = useAuditStore((s) => s.reconnecting);
  const connectionLost = useAuditStore((s) => s.connectionLost);
  const retryConnection = useAuditStore((s) => s.retryConnection);
  const replaying = useAuditStore((s) => s.replaying);
  const inspecting = useAuditStore((s) => s.inspecting);
  const inspect = useAuditStore((s) => s.inspect);
  const cameraFollows = useAuditStore((s) => s.cameraFollows);
  const setCameraFollows = useAuditStore((s) => s.setCameraFollows);
  const lastMove = useAuditStore((s) => s.lastMove);
  const speed = useAuditStore((s) => s.speed);
  const unseen = useAuditStore(unseenCount);

  // The whole projection recomputes from visible state. Cheap, pure and
  // deterministic — the same playhead always draws the same graph.
  const state = useAuditStore();
  const graph = useMemo(() => projectEvidenceGraph(state), [state]);
  const rich = isRichReplay(state);

  // The file the code pane shows: whatever the viewer pinned, else whatever the
  // audit is reading, else the last file it flagged — so the pane is never blank
  // once there is something worth looking at.
  const [pinnedFile, setPinnedFile] = useState<string | null>(null);
  useEffect(() => {
    // A new read releases the pin, so the pane keeps up with the scan unless the
    // viewer has deliberately gone somewhere else.
    if (analyzing) setPinnedFile(null);
  }, [analyzing]);

  const lastFlagged = Object.values(fileVerdicts)
    .filter((item) => item.riskContribution >= RISK_SUSPICIOUS_THRESHOLD)
    .at(-1)?.file;
  const shownFile = pinnedFile ?? analyzing ?? lastFlagged ?? null;
  const shownRanges = shownFile ? (fileVerdicts[shownFile]?.suspiciousLines ?? null) : null;

  // The explorer closes when the graph takes the room, and a viewer can put it
  // back. Tri-state on purpose: null means "follow the audit", which is what it
  // does until somebody says otherwise.
  const [userFiles, setUserFiles] = useState<boolean | null>(null);

  const weight = graphWeight(
    graph.nodes.some((node) => node.kind === "hypothesis"),
    Object.keys(state.runs).length > 0,
    Boolean(verdict || error),
  );

  const filesOpen = userFiles ?? weight < 0.72;

  useReplayKeyboard();

  const selected = inspecting
    ? (graph.nodes.find((node) => node.id === inspecting.nodeId) ?? null)
    : null;

  // A dead link, not a failed package: nothing ever streamed.
  if (error && !packageName && !running && !verdict && phase === null) {
    return (
      <div className="grid min-h-full place-items-center p-6">
        <DegradedSurface
          failure={{ what: "This audit", detail: error }}
          escape={{ label: "Back to home", href: "/" }}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2">
        <div className="flex min-w-0 items-baseline gap-2">
          {/* A replay is byte-identical to the run it replays, which is exactly
              why it has to say which one it is. "Live audit" over stored frames
              is the only untrue thing this view could say. */}
          <span className="font-mono text-[10px] tracking-wider text-text-3 uppercase">
            {replaying ? "replay" : "live audit"}
          </span>
          <h1 className="truncate font-mono text-sm font-semibold text-text">
            {packageName || "…"}
            {version ? <span className="text-text-3">@{version}</span> : null}
          </h1>
        </div>

        <PhaseRail compact />

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto hidden xl:inline-flex"
          aria-pressed={filesOpen}
          onClick={() => setUserFiles(!filesOpen)}
        >
          <PanelRight aria-hidden="true" className="size-icon-sm" />
          <span className="font-mono text-[11px]">files</span>
        </Button>

        <div className="flex items-center gap-2" role="status" aria-live="polite">
          {running && phase === null ? (
            <ProgressStamp state="queued">Starting…</ProgressStamp>
          ) : null}
          {verdict ? <ProgressStamp state="queued">Completed</ProgressStamp> : null}
          {/* Violet, not red. The audit failed; the package is not implicated. */}
          {error ? <VerdictStamp outcome="ERROR" /> : null}
          {reconnecting ? <span className="text-2xs text-text-3">Reconnecting…</span> : null}
          {connectionLost ? (
            <span className="flex items-center gap-1.5 text-2xs text-error-text">
              Connection lost
              <Button size="sm" variant="outline" onClick={retryConnection}>
                Retry connection
              </Button>
            </span>
          ) : null}
        </div>
      </header>

      {rich ? (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* ACTIVITY — the investigation log, on the left, where it has always
              been. The inspector never takes this rail. */}
          <aside className="hidden w-[20rem] shrink-0 flex-col border-r border-border bg-surface lg:flex">
            <InvestigationTranscript />
          </aside>

          {/* CODE — the middle. Shrinks as the graph grows and steps aside once
              the audit has concluded. */}
          <motion.div
            className="hidden min-h-0 min-w-0 flex-col bg-surface lg:flex"
            style={{ flexBasis: 0, overflow: "hidden" }}
            initial={false}
            animate={{ flexGrow: Math.max(1 - weight, 0.001), opacity: weight === 1 ? 0 : 1 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
            aria-hidden={weight === 1}
          >
            <CodeScanPane
              auditId={auditId}
              path={shownFile}
              ranges={shownRanges}
              scanning={Boolean(analyzing) && shownFile === analyzing}
              dwellMs={Math.round(
                (HOLD_MS.file_analyzing * fileScanScale(state.tape.frames)) / speed,
              )}
            />
          </motion.div>

          {/* GRAPH — opens on the right once there is a suspicion to show, and
              takes the room as the investigation earns it. */}
          <motion.div
            className="relative min-h-0 min-w-0 border-l border-border bg-sunken"
            style={{ flexBasis: 0 }}
            initial={false}
            animate={{ flexGrow: Math.max(weight, 0.001), opacity: weight === 0 ? 0 : 1 }}
            transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="hidden h-full lg:block">
              <ReactFlowProvider>
                <EvidenceGraphCanvas
                  graph={graph}
                  selectedId={inspecting?.nodeId ?? null}
                  onSelect={inspect}
                  cameraFollows={cameraFollows}
                  onUserTookCamera={() => setCameraFollows(false)}
                  animateEntrance={lastMove === "release"}
                  motionScale={animationScale(speed)}
                />
              </ReactFlowProvider>
            </div>
            <div className="h-full overflow-y-auto lg:hidden">
              <MobileEvidenceSpine
                graph={graph}
                selectedId={inspecting?.nodeId ?? null}
                onSelect={inspect}
              />
            </div>

            {/* The inspector floats OVER the canvas, beside what was clicked.
                It used to take a rail, which cost the viewer their place in the
                stream to answer a question about one node — and it opened
                through a Sheet whose scrim dimmed the whole workspace on
                desktop, including the text they wanted to read. */}
            {selected ? (
              <motion.div
                key={selected.id}
                initial={{ opacity: 0, x: 14 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                className={cn(
                  "absolute top-3 right-3 bottom-3 z-20 w-[23rem] max-w-[calc(100%-1.5rem)]",
                  "overflow-hidden rounded-lg border border-border bg-surface shadow-modal",
                )}
              >
                <EvidenceInspector node={selected} onClose={() => inspect(null)} />
              </motion.div>
            ) : null}

            {graph.ungroundedHypIds.length > 0 ? (
              <p className="absolute bottom-3 left-3 rounded border border-error-border bg-surface px-2 py-1 text-2xs text-error-text">
                {graph.ungroundedHypIds.length} hypothes
                {graph.ungroundedHypIds.length === 1 ? "is" : "es"} arrived without a source range
              </p>
            ) : null}
          </motion.div>

          {/* FILE EXPLORER — right, and it CLOSES when the graph takes over.
              Collapsed rather than deleted: the files are still what the verdict
              is about, and the header keeps a way back to them. */}
          <motion.aside
            className="hidden shrink-0 overflow-hidden border-l border-border bg-surface xl:block"
            initial={false}
            animate={{ width: filesOpen ? 224 : 0, opacity: filesOpen ? 1 : 0 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            aria-hidden={!filesOpen}
          >
            <div className="h-full w-56">
              <FileScanView selected={shownFile} onSelect={setPinnedFile} />
            </div>
          </motion.aside>
        </div>
      ) : (
        <UnsupportedReplay packageName={packageName} />
      )}

      {/* Stable bottom regions, present from the first frame, and BOUNDED.
          The graph is the surface; a dock that grows takes it. */}
      <ReplayControls />
      <section
        aria-label="Verdict"
        className="max-h-[32vh] shrink-0 overflow-y-auto border-t border-border bg-surface px-4 py-2.5"
        data-unseen={unseen}
      >
        {verdict || error ? (
          <VerdictReveal />
        ) : (
          <p className="text-2xs text-text-3">
            {PHASE_LABELS[phase ?? ""] ?? "No verdict yet"} — the audit is still running.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * The hard format cut, made visible.
 *
 * A stream below replay format 2 carries no experiment, sandbox or judgment
 * frames. There is no compatibility renderer and no reconstruction from the
 * final report — an animation assembled out of a report would show a viewer an
 * investigation that was never recorded, which is precisely the claim this
 * surface exists to make honestly. So it says what it has, and links to what it
 * does have.
 */
function UnsupportedReplay({ packageName }: { packageName: string }) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6">
      <div className="max-w-prose text-center">
        <h2 className="text-sm font-medium text-text">This audit predates the evidence graph</h2>
        <p className="mt-2 text-xs leading-relaxed text-text-2">
          It was recorded before the stream carried experiment, sandbox and judgment steps, so
          there is no investigation to replay. Nothing here is reconstructed from the final
          report — a drawing of events that were never recorded would be worse than none.
        </p>
        {packageName ? (
          <Button asChild variant="outline" className="mt-4">
            <a href={`/package/${packageName}`}>Open the package report</a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
