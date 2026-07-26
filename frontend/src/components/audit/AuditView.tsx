/**
 * The audit workspace — the product's signature surface.
 *
 * Graph-first and full-viewport. The graph owns all flexible width; a fixed
 * contextual rail carries the transcript, or the inspector when a node is
 * selected. Phase and connection state are compact chrome rather than a
 * dashboard card, because they are conditions of the work, not the work.
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

import { useMemo } from "react";
import { motion } from "motion/react";
import { ReactFlowProvider } from "@xyflow/react";
import { useAuditStore, unseenCount } from "../../stores/auditStore.ts";
import { isRichReplay } from "../../lib/audit-fold.ts";
import { projectEvidenceGraph } from "../../lib/evidence-graph.ts";
import { PHASE_LABELS } from "../../lib/types.ts";
import { cn } from "../../lib/cn.ts";
import { animationScale } from "../../lib/replay-clock.ts";
import { DegradedSurface } from "../ui/degraded-state.tsx";
import { ProgressStamp, VerdictStamp } from "../ui/verdict-stamp.tsx";
import { Button } from "../ui/button.tsx";
import { Sheet, SheetContent } from "../ui/sheet.tsx";
import { EvidenceGraphCanvas } from "./EvidenceGraph.tsx";
import { FileScanView } from "./FileScanView.tsx";
import { EvidenceInspector } from "./EvidenceInspector.tsx";
import { InvestigationTranscript } from "./InvestigationTranscript.tsx";
import { MobileEvidenceSpine } from "./MobileEvidenceSpine.tsx";
import { PhaseRail } from "./PhaseRail.tsx";
import { ReplayControls, useReplayKeyboard } from "./ReplayControls.tsx";
import { VerdictReveal } from "./VerdictReveal.tsx";

export function AuditView() {
  const packageName = useAuditStore((s) => s.packageName);
  const version = useAuditStore((s) => s.inventoryMeta?.metadata.version ?? null);
  const running = useAuditStore((s) => s.running);
  const phase = useAuditStore((s) => s.phase);
  const verdict = useAuditStore((s) => s.verdict);
  const error = useAuditStore((s) => s.error);
  const reconnecting = useAuditStore((s) => s.reconnecting);
  const connectionLost = useAuditStore((s) => s.connectionLost);
  const retryConnection = useAuditStore((s) => s.retryConnection);
  const replaying = useAuditStore((s) => s.replaying);
  const inspecting = useAuditStore((s) => s.inspecting);
  const inspect = useAuditStore((s) => s.inspect);
  const cameraFollows = useAuditStore((s) => s.cameraFollows);
  const lastMove = useAuditStore((s) => s.lastMove);
  const speed = useAuditStore((s) => s.speed);
  const setCameraFollows = useAuditStore((s) => s.setCameraFollows);
  const unseen = useAuditStore(unseenCount);

  // The whole projection recomputes from visible state. Cheap, pure and
  // deterministic — the same playhead always draws the same graph.
  const state = useAuditStore();
  const graph = useMemo(() => projectEvidenceGraph(state), [state]);
  const rich = isRichReplay(state);
  // The scan holds the canvas until there is a suspicion to draw. `graph_built`
  // is the engine's own boundary between "reading" and "investigating", and the
  // first hypothesis node is the first thing the graph could show that the scan
  // could not.
  const scanning = graph.nodes.every((node) => node.kind !== "hypothesis") && !verdict && !error;

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
          <span className="text-2xs tracking-wide text-text-3 uppercase">
            {replaying ? "Replay" : "Live audit"}
          </span>
          <h1 className="truncate font-mono text-sm font-semibold text-text">
            {packageName || "…"}
            {version ? <span className="text-text-3">@{version}</span> : null}
          </h1>
        </div>

        <PhaseRail compact />

        <div className="ml-auto flex items-center gap-2" role="status" aria-live="polite">
          {running && phase === null ? <ProgressStamp state="queued">Starting…</ProgressStamp> : null}
          {running && phase !== null ? (
            <ProgressStamp state="running">{PHASE_LABELS[phase] ?? "Running"}</ProgressStamp>
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
          <div className="relative min-h-0 min-w-0 flex-1 bg-sunken">
            {/* THE TWO ACTS.
                
                The audit opens on the scan — every file in the package, read one
                by one, settling into cleared or flagged. Then it becomes the
                graph, whose roots ARE the files that turned red. Opening on an
                empty canvas asked a viewer to believe the package had been read;
                this shows it, and the transform is a continuation rather than a
                scene change. */}
            {scanning ? (
              <motion.div
                key="scan"
                className="h-full"
                initial={false}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
              >
                <FileScanView />
              </motion.div>
            ) : null}
            <div className={cn("hidden h-full lg:block", scanning && "hidden lg:hidden")}>
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
            <div className={cn("h-full overflow-y-auto lg:hidden", scanning && "hidden")}>
              <MobileEvidenceSpine
                graph={graph}
                selectedId={inspecting?.nodeId ?? null}
                onSelect={inspect}
              />
            </div>
            {graph.ungroundedHypIds.length > 0 ? (
              <p className="absolute bottom-2 left-2 rounded border border-error-border bg-surface px-2 py-1 text-2xs text-error-text">
                {graph.ungroundedHypIds.length} hypothes
                {graph.ungroundedHypIds.length === 1 ? "is" : "es"} arrived without a source range
              </p>
            ) : null}
          </div>

          {/* The contextual rail. One rail, two occupants: the transcript by
              default, the inspector when a node is selected. */}
          <aside className="hidden min-h-0 w-[360px] shrink-0 flex-col border-l border-border bg-surface lg:flex xl:w-[400px]">
            {selected ? (
              <EvidenceInspector node={selected} onClose={() => inspect(null)} />
            ) : (
              // No wrapper scroll: the transcript owns its own, so it can pin the
              // live-activity line to its foot.
              <InvestigationTranscript />
            )}
          </aside>

          {/* Mobile inspection is a bottom sheet — the rail has nowhere to go. */}
          <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && inspect(null)}>
            <SheetContent side="bottom" className="h-[70vh] p-0 lg:hidden">
              {selected ? (
                <EvidenceInspector node={selected} onClose={() => inspect(null)} />
              ) : null}
            </SheetContent>
          </Sheet>
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
          <p className="text-2xs text-text-3">No verdict yet — the audit is still running.</p>
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
