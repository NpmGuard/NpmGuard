/**
 * The evidence graph — a pure projection of folded audit state into nodes, edges
 * and a synchronized outline.
 *
 * The graph is a VIEW of durable facts, never a second source of them. Every node
 * here traces to an event the engine emitted, and this module has no way to make
 * one up: it reads `AuditFoldState` and nothing else, so a shape on screen that
 * no event produced is not expressible.
 *
 * ── The grammar ──────────────────────────────────────────────────────────────
 *
 *   package
 *     ├─ coverage        "126 files cleared" — a COUNT, never a green node
 *     └─ source          a file the audit flagged, with its exact line ranges
 *          └─ cluster    related suspicions, when one file raises several
 *               └─ hypothesis
 *                    └─ run    setup → trigger → observe → judge, contracted
 *   verdict
 *
 * ── Why the columns are fixed ────────────────────────────────────────────────
 *
 * A general DAG solver would place these nodes differently on every audit, and a
 * force simulation differently on every FRAME. Both break the property this whole
 * surface rests on: that a replay is deterministic, so two people watching the
 * same audit are looking at the same picture, and a seek lands where the viewer
 * expects. The grammar above is small, known and stable, so position is a
 * function of role and depth — computed here, not solved.
 *
 * ── The two density rules, and the honesty behind each ───────────────────────
 *
 * A clean file gets a number, not a node. Partly for legibility — 400 permanent
 * nodes is not a graph — but mostly because a green node per clean file reads as
 * 400 individual SAFE claims, when what the audit actually has is coverage. The
 * coverage node is achromatic for the same reason.
 *
 * Refuted branches contract at the verdict and confirmed/deferred ones stay open,
 * because at that moment the graph stops being a progress display and becomes a
 * proof. What survived is the argument; what was ruled out is available but no
 * longer the point.
 */

import type { DisplayObservation, FocusRange, HypothesisState } from "@npmguard/shared";
import type { AuditFoldState, HypothesisView, RunView } from "./audit-fold.ts";
import { RISK_SUSPICIOUS_THRESHOLD } from "./types.ts";

export type GraphNodeKind =
  | "package"
  | "coverage"
  | "source"
  | "cluster"
  | "hypothesis"
  | "run"
  | "verdict";

/**
 * The semantic column a node lives in. Depth is the node's ROLE in the argument
 * — package, what was suspected, what was suspected of it, what was run, what it
 * proved — so the reading order left-to-right is the causal order.
 */
export const COLUMN = {
  package: 0,
  coverage: 1,
  source: 1,
  cluster: 2,
  hypothesis: 3,
  run: 4,
  verdict: 5,
} as const satisfies Record<GraphNodeKind, number>;

export interface CoverageData {
  scanned: number;
  total: number;
  cleared: number;
  flagged: number;
}

export interface SourceData {
  file: string;
  ranges: FocusRange[];
  summary: string;
  risk: number;
}

export interface ClusterData {
  file: string;
  claim: string;
  hypIds: string[];
}

export interface HypothesisData {
  hypothesis: HypothesisView;
  /** hypotheses folded into this one — their run answers all of them */
  absorbed: HypothesisView[];
}

export interface RunData {
  run: RunView;
  cited: DisplayObservation[];
}

export interface VerdictData {
  verdict: "SAFE" | "DANGEROUS" | "INCOMPLETE";
  rationale: string;
  coverage: CoverageData;
  confirmedHypIds: string[];
}

export type GraphNodeData =
  | { kind: "package"; label: string; version: string | null }
  | { kind: "coverage"; coverage: CoverageData }
  | { kind: "source"; source: SourceData }
  | { kind: "cluster"; cluster: ClusterData }
  | { kind: "hypothesis"; hypothesis: HypothesisData }
  | { kind: "run"; run: RunData }
  | { kind: "verdict"; verdict: VerdictData };

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  column: number;
  /** vertical slot within the column; stable across frames for the same node */
  row: number;
  data: GraphNodeData;
  /** contracted into a quiet, expandable group (a refuted branch at verdict) */
  contracted: boolean;
  /** the causal path a selected verdict highlights */
  onProofPath: boolean;
}

/**
 * Every edge carries a relation in WORDS, not only a line.
 *
 * A screen-reader user navigating the outline gets the same causal statement a
 * sighted user reads off the geometry — "these lines raised this suspicion",
 * "this run answered it". An unlabelled edge is a fact available to one group of
 * users and not the other.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  contracted: boolean;
  onProofPath: boolean;
}

/** One row of the outline — the same hierarchy, as text a reader can traverse. */
export interface OutlineItem {
  id: string;
  depth: number;
  label: string;
  detail: string | null;
  state: HypothesisState | null;
}

export interface EvidenceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  outline: OutlineItem[];
  /**
   * Hypotheses whose `focusLines` are empty. A PRODUCER defect under format 2 —
   * every hypothesis edge must originate at a real highlighted range, so the
   * absence is surfaced rather than papered over with a guessed line number.
   */
  ungroundedHypIds: string[];
}

export const PACKAGE_NODE_ID = "package";
export const COVERAGE_NODE_ID = "coverage";
export const VERDICT_NODE_ID = "verdict";

export const sourceNodeId = (file: string) => `source:${file}`;
export const clusterNodeId = (file: string, claim: string) => `cluster:${file}:${claim}`;
export const hypothesisNodeId = (hypId: string) => `hyp:${hypId}`;
export const runNodeId = (hypId: string) => `run:${hypId}`;

/** A hypothesis whose run still counts toward the argument at the verdict. */
const SURVIVES_VERDICT = new Set<HypothesisState>(["CONFIRMED", "DEFERRED"]);

function primaryFile(hypothesis: HypothesisView): string | null {
  return hypothesis.focusLines[0]?.file ?? hypothesis.focusFiles[0] ?? null;
}

function rangesFor(hypotheses: readonly HypothesisView[], file: string): FocusRange[] {
  const seen = new Set<string>();
  const ranges: FocusRange[] = [];
  for (const hypothesis of hypotheses) {
    for (const range of hypothesis.focusLines) {
      if (range.file !== file || seen.has(range.range)) continue;
      seen.add(range.range);
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * Project folded state into the graph.
 *
 * `atVerdict` is passed rather than read off `state.verdict` so the same
 * projection can be asked what the graph looks like BEFORE the pullback — which
 * is what the verdict transition animates between.
 */
export function projectEvidenceGraph(state: AuditFoldState): EvidenceGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const outline: OutlineItem[] = [];
  const atVerdict = state.verdict !== null || state.error !== null;

  // Hypotheses that were folded into another node never ran; they belong under
  // their survivor rather than as a branch that goes nowhere.
  const absorbedBy = new Map<string, HypothesisView[]>();
  const live: HypothesisView[] = [];
  for (const hypothesis of state.hypotheses) {
    if (hypothesis.mergedInto) {
      const group = absorbedBy.get(hypothesis.mergedInto) ?? [];
      group.push(hypothesis);
      absorbedBy.set(hypothesis.mergedInto, group);
    } else {
      live.push(hypothesis);
    }
  }

  const flaggedFiles = Object.values(state.fileVerdicts).filter(
    (verdict) => verdict.riskContribution >= RISK_SUSPICIOUS_THRESHOLD,
  );
  const clearedFiles = Object.values(state.fileVerdicts).filter(
    (verdict) => verdict.riskContribution < RISK_SUSPICIOUS_THRESHOLD,
  );
  const coverage: CoverageData = {
    scanned: state.scannedCount,
    total: state.files.length,
    cleared: clearedFiles.length,
    flagged: flaggedFiles.length,
  };

  const version = state.inventoryMeta?.metadata.version ?? null;
  nodes.push({
    id: PACKAGE_NODE_ID,
    kind: "package",
    column: COLUMN.package,
    row: 0,
    data: { kind: "package", label: state.packageName, version },
    contracted: false,
    onProofPath: true,
  });
  outline.push({
    id: PACKAGE_NODE_ID,
    depth: 0,
    label: state.packageName || "package",
    detail: version,
    state: null,
  });

  // Coverage first in the column: scanning is what the audit did before it had
  // anything to suspect, and it stays as the achromatic backdrop the suspicions
  // sit against.
  let row = 0;
  if (coverage.total > 0 || coverage.scanned > 0) {
    nodes.push({
      id: COVERAGE_NODE_ID,
      kind: "coverage",
      column: COLUMN.coverage,
      row: row++,
      data: { kind: "coverage", coverage },
      contracted: false,
      onProofPath: false,
    });
    edges.push({
      id: `${PACKAGE_NODE_ID}->${COVERAGE_NODE_ID}`,
      source: PACKAGE_NODE_ID,
      target: COVERAGE_NODE_ID,
      relation: "was scanned for",
      contracted: false,
      onProofPath: false,
    });
    outline.push({
      id: COVERAGE_NODE_ID,
      depth: 1,
      label: `${coverage.cleared} files cleared`,
      detail: `${coverage.scanned} of ${coverage.total} read`,
      state: null,
    });
  }

  // Group live hypotheses by the file they point at. A hypothesis with no focus
  // range has no source to originate from — recorded, never invented.
  const byFile = new Map<string, HypothesisView[]>();
  const ungroundedHypIds: string[] = [];
  for (const hypothesis of live) {
    const file = primaryFile(hypothesis);
    if (file === null || hypothesis.focusLines.length === 0) {
      ungroundedHypIds.push(hypothesis.hypId);
      if (file === null) continue;
    }
    const group = byFile.get(file) ?? [];
    group.push(hypothesis);
    byFile.set(file, group);
  }

  // A flagged file with no surviving hypothesis still gets a source node: the
  // audit suspected it, and dropping the node would erase that.
  for (const verdict of flaggedFiles) {
    if (!byFile.has(verdict.file)) byFile.set(verdict.file, []);
  }

  const runRowByHyp = new Map<string, number>();
  let hypRow = 0;
  let runRow = 0;
  const confirmedHypIds: string[] = [];

  for (const [file, group] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const verdict = state.fileVerdicts[file];
    const sourceId = sourceNodeId(file);
    nodes.push({
      id: sourceId,
      kind: "source",
      column: COLUMN.source,
      row: row++,
      data: {
        kind: "source",
        source: {
          file,
          ranges: rangesFor(group, file),
          summary: verdict?.summary ?? "",
          risk: verdict?.riskContribution ?? 0,
        },
      },
      contracted: false,
      onProofPath: false,
    });
    edges.push({
      id: `${PACKAGE_NODE_ID}->${sourceId}`,
      source: PACKAGE_NODE_ID,
      target: sourceId,
      relation: "contains the suspicious source",
      contracted: false,
      onProofPath: false,
    });
    outline.push({
      id: sourceId,
      depth: 1,
      label: file,
      detail: rangesFor(group, file).map((range) => range.range).join(", ") || null,
      state: null,
    });

    // Cluster only when a file raises the SAME claim more than once. A cluster of
    // one is a box drawn around a single node.
    const byClaim = new Map<string, HypothesisView[]>();
    for (const hypothesis of group) {
      const bucket = byClaim.get(hypothesis.claim) ?? [];
      bucket.push(hypothesis);
      byClaim.set(hypothesis.claim, bucket);
    }

    for (const [claim, members] of [...byClaim.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      let parentId = sourceId;
      let parentDepth = 1;
      if (members.length > 1) {
        const clusterId = clusterNodeId(file, claim);
        nodes.push({
          id: clusterId,
          kind: "cluster",
          column: COLUMN.cluster,
          row: hypRow,
          data: {
            kind: "cluster",
            cluster: { file, claim, hypIds: members.map((item) => item.hypId) },
          },
          contracted: false,
          onProofPath: false,
        });
        edges.push({
          id: `${sourceId}->${clusterId}`,
          source: sourceId,
          target: clusterId,
          relation: "raised the related suspicions",
          contracted: false,
          onProofPath: false,
        });
        outline.push({
          id: clusterId,
          depth: 2,
          label: `${members.length} × ${claim}`,
          detail: null,
          state: null,
        });
        parentId = clusterId;
        parentDepth = 2;
      }

      for (const hypothesis of members) {
        // At the verdict a refuted branch contracts. Confirmed and deferred stay
        // open: one is the proof, the other is the gap in it.
        const contracted =
          atVerdict && hypothesis.state === "REFUTED" && !SURVIVES_VERDICT.has(hypothesis.state);
        const onProofPath = hypothesis.state === "CONFIRMED";
        if (onProofPath) confirmedHypIds.push(hypothesis.hypId);

        const hypId = hypothesisNodeId(hypothesis.hypId);
        nodes.push({
          id: hypId,
          kind: "hypothesis",
          column: COLUMN.hypothesis,
          row: hypRow++,
          data: {
            kind: "hypothesis",
            hypothesis: {
              hypothesis,
              absorbed: absorbedBy.get(hypothesis.hypId) ?? [],
            },
          },
          contracted,
          onProofPath,
        });
        edges.push({
          id: `${parentId}->${hypId}`,
          source: parentId,
          target: hypId,
          relation: "raised the hypothesis",
          contracted,
          onProofPath,
        });
        outline.push({
          id: hypId,
          depth: parentDepth + 1,
          label: hypothesis.description || hypothesis.claim,
          detail: hypothesis.claim,
          state: hypothesis.state,
        });

        const run = state.runs[hypothesis.hypId];
        if (!run) continue;
        const runId = runNodeId(hypothesis.hypId);
        runRowByHyp.set(hypothesis.hypId, runRow);
        const cited = run.observations.filter((item) =>
          run.citedEventIds.includes(item.eventId),
        );
        nodes.push({
          id: runId,
          kind: "run",
          column: COLUMN.run,
          row: runRow++,
          data: { kind: "run", run: { run, cited } },
          contracted,
          onProofPath,
        });
        edges.push({
          id: `${hypId}->${runId}`,
          source: hypId,
          target: runId,
          relation: "was tested by the run",
          contracted,
          onProofPath,
        });
        outline.push({
          id: runId,
          depth: parentDepth + 2,
          label: `run ${run.runId.slice(0, 12)}`,
          detail: run.display
            ? `${run.display.eventCount} events · ${cited.length} cited`
            : "running",
          state: null,
        });
      }
    }
  }

  if (atVerdict) {
    const outcome: VerdictData["verdict"] = state.error
      ? "INCOMPLETE"
      : (state.verdict ?? "INCOMPLETE");
    nodes.push({
      id: VERDICT_NODE_ID,
      kind: "verdict",
      column: COLUMN.verdict,
      row: 0,
      data: {
        kind: "verdict",
        verdict: {
          verdict: outcome,
          rationale: state.verdictRationale ?? state.error ?? "",
          coverage,
          confirmedHypIds,
        },
      },
      contracted: false,
      onProofPath: true,
    });
    // The verdict is drawn from the runs that decided it. A verdict edge from
    // every branch would say the refuted ones argued for it, which is backwards:
    // they are what it survived, not what it rests on.
    const deciding = confirmedHypIds.length
      ? confirmedHypIds
      : [...runRowByHyp.keys()].filter(
          (hypId) =>
            state.hypotheses.find((item) => item.hypId === hypId)?.state === "DEFERRED",
        );
    for (const hypId of deciding) {
      if (!runRowByHyp.has(hypId)) continue;
      edges.push({
        id: `${runNodeId(hypId)}->${VERDICT_NODE_ID}`,
        source: runNodeId(hypId),
        target: VERDICT_NODE_ID,
        relation: "supports the verdict",
        contracted: false,
        onProofPath: true,
      });
    }
    outline.push({
      id: VERDICT_NODE_ID,
      depth: 1,
      label: outcome,
      detail: state.verdictRationale ?? state.error,
      state: null,
    });
  }

  return { nodes, edges, outline, ungroundedHypIds };
}
