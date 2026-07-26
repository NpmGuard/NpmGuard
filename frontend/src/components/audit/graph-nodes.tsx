/**
 * The evidence graph's node components.
 *
 * Every node is a projection row (`lib/evidence-graph.ts`) rendered as a card.
 * They hold no state and fetch nothing: what a node shows is decided by the fold
 * and the projector, so two viewers at the same playhead see the same graph.
 *
 * ── The colour rule, which this file is the main place to break ──────────────
 *
 * Outcome colour makes a claim about the PACKAGE. Progress does not.
 *
 *   danger red  — a confirmed hypothesis, and the DANGEROUS verdict.
 *   safe green  — the SAFE verdict only. Never a cleared file, never a refuted
 *                 branch: "this one experiment found nothing" is not a claim of
 *                 safety, and a wall of green boxes on a running audit reads as
 *                 a tally of good news the audit has not earned.
 *   error violet— DEFERRED, and an audit that could not conclude. Both mean
 *                 "we don't know", which is not the same as "nothing is wrong".
 *   achromatic  — everything else, including coverage and every in-flight state.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Boxes,
  CircleDot,
  FlaskConical,
  Layers,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type {
  ClusterData,
  CoverageData,
  GraphNodeData,
  HypothesisData,
  RunData,
  SourceData,
  VerdictData,
} from "../../lib/evidence-graph.ts";
import { cn } from "../../lib/cn.ts";
import { HypothesisStateStamp } from "../ui/verdict-stamp.tsx";
import { STATE_LABELS, hypothesisTone } from "../../lib/report-helpers.ts";

/** React Flow hands node data through as a record; this is the shape we put in. */
export type EvidenceNodeProps = NodeProps & {
  data: GraphNodeData & { selected?: boolean; onProofPath?: boolean; contracted?: boolean };
};

/**
 * The shared card. Handles are rendered but never connectable — the application
 * owns graph structure and the library owns only the viewport, so a node a user
 * could wire to another would be a shape no event produced.
 */
function NodeShell({
  children,
  tone = "neutral",
  className,
  label,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "danger" | "safe" | "error" | "accent";
  className?: string;
  label: string;
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        "min-w-52 max-w-72 rounded-md border bg-surface px-3 py-2 text-left shadow-sm",
        "transition-[border-color,box-shadow] duration-[--ng-dur-fast]",
        tone === "neutral" && "border-border",
        tone === "danger" && "border-danger-border",
        tone === "safe" && "border-safe-border",
        tone === "error" && "border-error-border",
        tone === "accent" && "border-accent-border",
        className,
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="!opacity-0" />
      {children}
      <Handle type="source" position={Position.Right} isConnectable={false} className="!opacity-0" />
    </div>
  );
}

function NodeTitle({ icon: Icon, children }: { icon: typeof Boxes; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-2xs tracking-wide text-text-3 uppercase">
      <Icon aria-hidden="true" strokeWidth={1.5} className="size-icon-sm shrink-0" />
      {children}
    </div>
  );
}

export function PackageNode({ data }: EvidenceNodeProps) {
  const node = data as Extract<GraphNodeData, { kind: "package" }>;
  return (
    <NodeShell tone="accent" label={`Package ${node.label}`}>
      <NodeTitle icon={Boxes}>Package</NodeTitle>
      <p className="mt-1 font-mono text-sm break-all text-text">
        {node.label || "…"}
        {node.version ? <span className="text-text-3">@{node.version}</span> : null}
      </p>
    </NodeShell>
  );
}

export function CoverageNode({ data }: EvidenceNodeProps) {
  const { coverage } = data as { coverage: CoverageData };
  return (
    // Achromatic on purpose. A cleared file is COVERAGE, not a SAFE verdict, and
    // a green node per clean file would be hundreds of individual safety claims
    // the audit never made.
    <NodeShell label={`${coverage.cleared} files cleared`}>
      <NodeTitle icon={ScanLine}>Coverage</NodeTitle>
      <p className="mt-1 text-sm text-text tabular-nums">
        {coverage.cleared} file{coverage.cleared === 1 ? "" : "s"} cleared
      </p>
      <p className="text-2xs text-text-3 tabular-nums">
        {coverage.scanned} of {coverage.total} read · {coverage.flagged} flagged
      </p>
    </NodeShell>
  );
}

export function SourceNode({ data }: EvidenceNodeProps) {
  const { source } = data as { source: SourceData };
  return (
    <NodeShell label={`Suspicious source ${source.file}`}>
      <NodeTitle icon={CircleDot}>Source</NodeTitle>
      <p className="mt-1 font-mono text-xs break-all text-text">{source.file}</p>
      {source.ranges.length > 0 ? (
        <p className="font-mono text-2xs text-accent-text">
          {source.ranges.map((range) => range.range).join(", ")}
        </p>
      ) : (
        // Stated, never guessed. A hypothesis edge originates at a real range;
        // when the producer sent none, the node says so.
        <p className="text-2xs text-error-text">no line range recorded</p>
      )}
      {source.summary ? (
        <p className="mt-1 line-clamp-3 text-2xs text-text-2">{source.summary}</p>
      ) : null}
    </NodeShell>
  );
}

export function ClusterNode({ data }: EvidenceNodeProps) {
  const { cluster } = data as { cluster: ClusterData };
  return (
    <NodeShell label={`${cluster.hypIds.length} related ${cluster.claim} suspicions`}>
      <NodeTitle icon={Layers}>Cluster</NodeTitle>
      <p className="mt-1 text-sm text-text">
        {cluster.hypIds.length} × <span className="font-mono text-xs">{cluster.claim}</span>
      </p>
      <p className="font-mono text-2xs text-text-3 break-all">{cluster.file}</p>
    </NodeShell>
  );
}

const STAGE_LABEL = {
  emitted: "awaiting an experiment",
  merged: "answered by another run",
  experiment: "experiment armed",
  sandbox: "running in the sandbox",
  judging: "weighing evidence",
  resolved: "",
} as const;

export function HypothesisNode({ data }: EvidenceNodeProps) {
  const { hypothesis } = data as { hypothesis: HypothesisData };
  const node = hypothesis.hypothesis;
  const tone =
    node.state === "CONFIRMED" ? "danger" : node.state === "DEFERRED" ? "error" : "neutral";
  return (
    <NodeShell tone={tone} label={`Hypothesis ${node.claim}: ${node.description}`}>
      <NodeTitle icon={ShieldAlert}>{node.claim}</NodeTitle>
      <p className="mt-1 line-clamp-3 text-xs text-text">{node.description}</p>
      <div className="mt-1.5 flex items-center gap-2">
        {node.stage === "resolved" ? (
          <HypothesisStateStamp
            state={node.state}
            tone={hypothesisTone(node.state)}
            label={STATE_LABELS[node.state]}
          />
        ) : (
          <span className="text-2xs text-text-3">{STAGE_LABEL[node.stage]}</span>
        )}
        {hypothesis.absorbed.length > 0 ? (
          <span className="text-2xs text-text-3">
            +{hypothesis.absorbed.length} identical
          </span>
        ) : null}
      </div>
    </NodeShell>
  );
}

/**
 * The sandbox run, contracted to one node.
 *
 * The four steps are the experiment's shape — setup, trigger, observe, judge —
 * and they stay visible as a strip rather than as four nodes, because a
 * completed run is one fact. Clicking opens the inspector, which is where the
 * ordered tool calls, the sensor rows and the capture hashes live.
 */
export function RunNode({ data }: EvidenceNodeProps) {
  const { run } = data as { run: RunData };
  const display = run.run.display;
  const stage = run.run.stage;
  const steps = [
    { key: "setup", done: true, label: `${run.run.experiment.length} setup` },
    { key: "trigger", done: true, label: run.run.trigger.target },
    {
      key: "observe",
      done: stage === "judging" || stage === "done",
      label: display ? `${display.eventCount} events` : "observing",
    },
    { key: "judge", done: stage === "done", label: run.cited.length ? `${run.cited.length} cited` : "judged" },
  ];
  return (
    <NodeShell
      tone={run.cited.length > 0 ? "danger" : "neutral"}
      label={`Sandbox run ${run.run.runId}`}
    >
      <NodeTitle icon={FlaskConical}>Sandbox run</NodeTitle>
      <ol className="mt-1.5 grid gap-1">
        {steps.map((step) => (
          <li key={step.key} className="flex items-baseline gap-2 text-2xs">
            <span
              aria-hidden="true"
              className={cn(
                "inline-block size-1.5 shrink-0 rounded-full",
                step.done ? "bg-progress-ink" : "bg-progress-idle",
              )}
            />
            <span className="w-12 shrink-0 text-text-3">{step.key}</span>
            <span className="truncate font-mono text-text-2">{step.label}</span>
          </li>
        ))}
      </ol>
      {display ? (
        <p className="mt-1.5 text-2xs text-text-3 tabular-nums">
          {Math.round(display.wallMs)}ms
          {display.omittedObservationCount > 0
            ? ` · showing ${display.observations.length} of ${display.observations.length + display.omittedObservationCount}`
            : null}
        </p>
      ) : null}
    </NodeShell>
  );
}

export function VerdictNode({ data }: EvidenceNodeProps) {
  const { verdict } = data as { verdict: VerdictData };
  const tone =
    verdict.verdict === "DANGEROUS" ? "danger" : verdict.verdict === "SAFE" ? "safe" : "error";
  return (
    <NodeShell tone={tone} label={`Verdict ${verdict.verdict}`}>
      <NodeTitle icon={verdict.verdict === "SAFE" ? ShieldCheck : ShieldAlert}>Verdict</NodeTitle>
      <p
        className={cn(
          "mt-1 text-sm font-semibold",
          tone === "danger" && "text-danger-text",
          tone === "safe" && "text-safe-text",
          tone === "error" && "text-error-text",
        )}
      >
        {verdict.verdict === "INCOMPLETE" ? "Could not conclude" : verdict.verdict}
      </p>
      <p className="mt-0.5 line-clamp-3 text-2xs text-text-2">{verdict.rationale}</p>
      {verdict.verdict === "SAFE" ? (
        // The coverage caveat travels WITH the headline, never as a footnote a
        // layout can drop. Overstating a clean result is the credibility failure
        // this product cannot afford.
        <p className="mt-1 text-2xs text-text-3 tabular-nums">
          {verdict.coverage.cleared} cleared of {verdict.coverage.total} · No confirmed threat
          found. Not a proof of absence.
        </p>
      ) : null}
    </NodeShell>
  );
}

export const NODE_TYPES = {
  package: PackageNode,
  coverage: CoverageNode,
  source: SourceNode,
  cluster: ClusterNode,
  hypothesis: HypothesisNode,
  run: RunNode,
  verdict: VerdictNode,
};
