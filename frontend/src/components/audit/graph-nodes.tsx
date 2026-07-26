/**
 * The evidence graph's node components.
 *
 * Every node is a projection row (`lib/evidence-graph.ts`) rendered as a card.
 * They hold no state and fetch nothing: what a node shows is decided by the fold
 * and the projector, so two viewers at the same playhead see the same graph.
 *
 * ── What a node carries ──────────────────────────────────────────────────────
 *
 * An eyebrow (what kind of thing), a title (the value that identifies it), one
 * meta line. Nothing else. An earlier pass put three lines of model description
 * on every hypothesis, and a canvas of paragraphs is not a graph — the reader
 * stops tracing causality and starts reading, which is the job the transcript
 * and the inspector already do. Everything else is one click away.
 *
 * ── The colour rule, which this file is the main place to break ──────────────
 *
 * Outcome colour makes a claim about the PACKAGE. Progress does not.
 *
 *   danger red  — a CONFIRMED hypothesis, and a DANGEROUS verdict. Carried as a
 *                 tinted panel with a rule down its left edge — the wash steps
 *                 are built to be legible backgrounds, so a confirmation reads
 *                 as a marked card rather than as a red block.
 *   safe green  — the SAFE verdict only. Never a cleared file and never a refuted
 *                 branch: "this one experiment found nothing" is not a claim of
 *                 safety, and a wall of green on a running audit reads as a tally
 *                 of good news the audit has not earned.
 *   error violet— DEFERRED, and an audit that could not conclude. Both mean "we
 *                 don't know", which is not "nothing is wrong".
 *   achromatic  — everything else, including coverage and every in-flight state.
 */

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { motion, useReducedMotion } from "motion/react";
import {
  Boxes,
  FileCode2,
  FlaskConical,
  Layers,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
import { CLAIM_LABEL } from "../../lib/investigator-copy.ts";

/** What the canvas passes through React Flow's opaque `data` slot. */
export type EvidenceNodeData = GraphNodeData & {
  onProofPath: boolean;
  contracted: boolean;
  /** true only for a node released by the replay clock — never after a seek */
  entering: boolean;
  /** shortened at high speed so arrivals stay legible instead of smearing */
  motionScale: number;
  selected: boolean;
};

export type EvidenceNodeProps = NodeProps & { data: EvidenceNodeData };

type Tone = "neutral" | "danger" | "safe" | "error";

/**
 * The shared card.
 *
 * Handles are rendered but never connectable — the application owns graph
 * structure and the library owns only the viewport, so a node a user could wire
 * to another would be a shape no event produced.
 *
 * The entrance is a POP: opacity, a short rise from the left (the direction
 * causality flows) and a touch of scale. It fires only for nodes the clock
 * released, so a seek reconstructs the graph without replaying its history —
 * fifty cards animating at once is what makes a scrub feel like a crash.
 */
function NodeShell({
  children,
  tone = "neutral",
  label,
  data,
}: {
  children: React.ReactNode;
  tone?: Tone;
  label: string;
  data: EvidenceNodeData;
}) {
  const reduce = useReducedMotion();
  const animated = data.entering && !reduce;
  return (
    <motion.div
      aria-label={label}
      initial={animated ? { opacity: 0, scale: 0.9, x: -18 } : false}
      animate={{ opacity: data.contracted ? 0.4 : 1, scale: 1, x: 0 }}
      transition={{ duration: 0.36 * data.motionScale, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "w-[13.5rem] rounded-lg border px-2.5 py-2 text-left shadow-sm",
        "transition-[box-shadow,border-color] duration-fast hover:shadow-pop",
        // Chips sit on `surface` over a `sunken` field, so they read as objects
        // on a plane rather than as text floating on the page.
        TONE_SKIN[tone],
        // Selection is an accent ring, never a colour change: the tone already
        // means something, and overloading it would make "selected" and
        // "confirmed" the same signal.
        data.selected && "ring-2 ring-accent shadow-pop",
      )}
      data-selected={data.selected ? "true" : undefined}
      data-tone={tone}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="!opacity-0" />
      {children}
      <Handle type="source" position={Position.Right} isConnectable={false} className="!opacity-0" />
    </motion.div>
  );
}

/** The node's dot — the one place outcome colour appears on the canvas.
 *
 * A dot rather than a border or a fill: twelve confirmations then read as twelve
 * marks along a path instead of as a red screen, and the colour still lands on
 * the thing it is about. */
const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-progress-idle",
  danger: "bg-danger",
  safe: "bg-safe",
  error: "bg-error",
};

/** The chip's skin. The wash steps are authored as legible backgrounds, so a
 * tinted panel with a left rule is the strongest signal available that costs no
 * legibility — the same device the report surfaces use for a finding. */
const TONE_SKIN: Record<Tone, string> = {
  neutral: "border-border bg-surface",
  danger: "border-danger-border border-l-[3px] border-l-danger bg-danger-wash",
  safe: "border-safe-border border-l-[3px] border-l-safe bg-safe-wash",
  error: "border-error-border border-l-[3px] border-l-error bg-error-wash",
};

/** The eyebrow: what KIND of thing this is, in the mono caps the whole product
 * uses for machine-authored labels. */
function Eyebrow({
  icon: Icon,
  tone = "neutral",
  children,
}: {
  icon: LucideIcon;
  tone?: Tone;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-text-3 uppercase">
      <span className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE[tone])} aria-hidden="true" />
      <Icon aria-hidden="true" strokeWidth={1.5} className="size-3 shrink-0 opacity-70" />
      <span className="truncate">{children}</span>
    </div>
  );
}

function Title({ children }: { children: React.ReactNode }) {
  return <p className="mt-0.5 truncate font-mono text-xs text-text">{children}</p>;
}

function Meta({ children }: { children: React.ReactNode }) {
  return <p className="truncate font-mono text-[11px] text-text-3 tabular-nums">{children}</p>;
}

export function PackageNode({ data }: EvidenceNodeProps) {
  const node = data as Extract<GraphNodeData, { kind: "package" }>;
  return (
    <NodeShell label={`Package ${node.label}`} data={data}>
      <Eyebrow icon={Boxes}>package</Eyebrow>
      <p className="mt-0.5 truncate font-mono text-xs font-semibold text-accent-text">
        {node.label || "…"}
      </p>
      {node.version ? <Meta>{node.version}</Meta> : null}
    </NodeShell>
  );
}

export function CoverageNode({ data }: EvidenceNodeProps) {
  const { coverage } = data as { coverage: CoverageData };
  return (
    // Achromatic on purpose. A cleared file is COVERAGE, not a SAFE verdict, and
    // a green node per clean file would be hundreds of individual safety claims
    // the audit never made.
    <NodeShell label={`${coverage.cleared} files cleared`} data={data}>
      <Eyebrow icon={ScanLine}>coverage</Eyebrow>
      <Title>
        {coverage.cleared} cleared · {coverage.flagged} flagged
      </Title>
      <Meta>
        {coverage.scanned}/{coverage.total} files read
      </Meta>
    </NodeShell>
  );
}

export function SourceNode({ data }: EvidenceNodeProps) {
  const { source } = data as { source: SourceData };
  // At most three ranges on the card; the rest are in the inspector. Twelve
  // comma-separated ranges wrap to four lines and stop being readable as
  // locations.
  const shown = source.ranges.slice(0, 3).map((range) => range.range);
  const extra = source.ranges.length - shown.length;
  return (
    <NodeShell label={`Suspicious source ${source.file}`} data={data}>
      <Eyebrow icon={FileCode2}>source</Eyebrow>
      <Title>{source.file}</Title>
      {shown.length > 0 ? (
        <p className="truncate font-mono text-[11px] tabular-nums">
          <span className="rounded-sm bg-accent-wash px-1 text-accent-text">
            {shown.join(" · ")}
          </span>
          {extra > 0 ? <span className="text-text-3"> +{extra}</span> : null}
        </p>
      ) : (
        // Stated, never guessed. A hypothesis edge originates at a real range;
        // when the producer sent none, the node says so.
        <Meta>
          <span className="text-error-text">no line range recorded</span>
        </Meta>
      )}
    </NodeShell>
  );
}

export function ClusterNode({ data }: EvidenceNodeProps) {
  const { cluster } = data as { cluster: ClusterData };
  return (
    <NodeShell label={`${cluster.hypIds.length} related ${cluster.claim} suspicions`} data={data}>
      <Eyebrow icon={Layers}>cluster</Eyebrow>
      <Title>
        {cluster.hypIds.length} × {CLAIM_LABEL[cluster.claim] ?? cluster.claim}
      </Title>
      <Meta>{cluster.file}</Meta>
    </NodeShell>
  );
}

const STAGE_LABEL: Record<string, string> = {
  emitted: "awaiting an experiment",
  merged: "answered by another run",
  experiment: "experiment armed",
  sandbox: "running in the sandbox",
  judging: "weighing evidence",
};

const STATE_TONE: Record<string, Tone> = {
  CONFIRMED: "danger",
  DEFERRED: "error",
  REFUTED: "neutral",
  OPEN: "neutral",
  IN_PROGRESS: "neutral",
};

export function HypothesisNode({ data }: EvidenceNodeProps) {
  const { hypothesis } = data as { hypothesis: HypothesisData };
  const node = hypothesis.hypothesis;
  const resolved = node.stage === "resolved";
  return (
    <NodeShell
      tone={STATE_TONE[node.state]}
      label={`Hypothesis ${node.claim}: ${node.description}`}
      data={data}
    >
      <Eyebrow icon={ShieldAlert} tone={STATE_TONE[node.state]}>
        {CLAIM_LABEL[node.claim] ?? node.claim}
      </Eyebrow>
      <Title>
        {node.focusLines[0]
          ? `${node.focusLines[0].file}:${node.focusLines[0].range}`
          : (node.focusFiles[0] ?? node.hypId)}
      </Title>
      <Meta>
        {resolved ? (
          <span
            className={cn(
              node.state === "CONFIRMED" && "text-danger-text",
              node.state === "DEFERRED" && "text-error-text",
            )}
          >
            {node.state.toLowerCase()}
          </span>
        ) : (
          STAGE_LABEL[node.stage]
        )}
        {hypothesis.absorbed.length > 0 ? ` · +${hypothesis.absorbed.length} identical` : null}
      </Meta>
    </NodeShell>
  );
}

/**
 * The sandbox run, contracted to one node.
 *
 * The four steps are the experiment's shape — setup, trigger, observe, judge —
 * shown as a filled progress track rather than as four nodes, because a
 * completed run is one fact. Clicking opens the inspector, which is where the
 * ordered tool calls, the sensor rows and the capture hashes live.
 */
const RUN_STEPS = ["setup", "trigger", "observe", "judge"] as const;
const RUN_STAGE_INDEX: Record<string, number> = {
  planned: 1,
  running: 2,
  judging: 3,
  done: 4,
};

export function RunNode({ data }: EvidenceNodeProps) {
  const { run, cited } = (data as { run: RunData }).run;
  const display = run.display;
  const reached = RUN_STAGE_INDEX[run.stage] ?? 0;
  return (
    <NodeShell tone="neutral" label={`Sandbox run ${run.runId}`} data={data}>
      <Eyebrow icon={FlaskConical}>sandbox run</Eyebrow>
      <ol aria-hidden="true" className="mt-1 flex items-center gap-1">
        {RUN_STEPS.map((step, index) => (
          <li
            key={step}
            className={cn(
              "h-0.5 flex-1 rounded-full",
              index < reached ? "bg-progress-ink" : "bg-progress-track",
            )}
          />
        ))}
      </ol>
      <Title>
        {RUN_STEPS[Math.max(0, reached - 1)]} · {run.trigger.target}
      </Title>
      <Meta>
        {display ? (
          <>
            {Math.round(display.wallMs)}ms · {display.eventCount} events
            {cited.length > 0 ? (
              <span className="text-danger-text"> · {cited.length} cited</span>
            ) : null}
          </>
        ) : (
          "running"
        )}
      </Meta>
    </NodeShell>
  );
}

export function VerdictNode({ data }: EvidenceNodeProps) {
  const { verdict } = data as { verdict: VerdictData };
  const tone: Tone =
    verdict.verdict === "DANGEROUS" ? "danger" : verdict.verdict === "SAFE" ? "safe" : "error";
  return (
    <NodeShell tone={tone} label={`Verdict ${verdict.verdict}`} data={data}>
      <Eyebrow icon={verdict.verdict === "SAFE" ? ShieldCheck : ShieldAlert} tone={tone}>
        verdict
      </Eyebrow>
      <p
        className={cn(
          "mt-0.5 font-mono text-sm font-semibold tracking-wide",
          tone === "danger" && "text-danger-text",
          tone === "safe" && "text-safe-text",
          tone === "error" && "text-error-text",
        )}
      >
        {verdict.verdict === "INCOMPLETE" ? "COULD NOT CONCLUDE" : verdict.verdict}
      </p>
      <Meta>
        {verdict.confirmedHypIds.length > 0
          ? `${verdict.confirmedHypIds.length} confirmed · ${verdict.coverage.cleared} cleared`
          : `${verdict.coverage.cleared} cleared of ${verdict.coverage.total}`}
      </Meta>
      {verdict.verdict === "SAFE" ? (
        // The caveat travels WITH the headline, never as a footnote a layout can
        // drop. Overstating a clean result is the credibility failure this
        // product cannot afford.
        <p className="mt-1 text-[11px] leading-snug text-text-3">Not a proof of absence.</p>
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
