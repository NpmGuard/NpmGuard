/**
 * The evidence graph canvas.
 *
 * React Flow is used as a NON-EDITABLE viewport: it owns pan, zoom, selection,
 * keyboard focus and the fit camera; the application owns every node and edge.
 * Dragging, connecting and deleting are all off, because a node a user could
 * move or remove would be a shape no event produced — and the whole claim this
 * surface makes is that everything on it came off the wire.
 *
 * Layout is computed here from the projection's semantic (column, row), not
 * solved. A DAG solver would place the same audit differently on a different
 * run and a force simulation differently on every frame; either breaks the
 * property that two people watching one replay see one picture.
 *
 * ── Camera ──────────────────────────────────────────────────────────────────
 *
 * The camera follows the active branch until the viewer touches it, and then
 * stops until they ask for it back. Interruptible, and never during an
 * inspection: a canvas that re-frames while someone is reading a node has taken
 * the page away from them.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useReducedMotion } from "motion/react";
import type { EvidenceGraph as EvidenceGraphModel } from "../../lib/evidence-graph.ts";
import { NODE_TYPES } from "./graph-nodes.tsx";

/** Column pitch and row pitch in flow units. Fixed so a replay is reproducible. */
const COLUMN_WIDTH = 300;
const ROW_HEIGHT = 132;

export interface EvidenceGraphProps {
  graph: EvidenceGraphModel;
  selectedId: string | null;
  onSelect: (nodeId: string | null) => void;
  /** the camera may move on its own only while this is true */
  cameraFollows: boolean;
  onUserTookCamera: () => void;
}

export function EvidenceGraphCanvas({
  graph,
  selectedId,
  onSelect,
  cameraFollows,
  onUserTookCamera,
}: EvidenceGraphProps) {
  const reduce = useReducedMotion();

  const nodes = useMemo<Node[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: node.kind,
        position: { x: node.column * COLUMN_WIDTH, y: node.row * ROW_HEIGHT },
        data: { ...node.data, onProofPath: node.onProofPath, contracted: node.contracted },
        selected: node.id === selectedId,
        draggable: false,
        connectable: false,
        deletable: false,
        // A contracted branch is quiet, not gone: it keeps its place in the
        // layout and its position in the keyboard order, so expanding it does
        // not rearrange the graph around the reader.
        style: node.contracted ? { opacity: 0.45 } : undefined,
        ariaLabel: node.id,
      })),
    [graph.nodes, selectedId],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        // The relation is on the edge itself, so a screen reader reading the
        // graph gets the causal statement rather than a line between two boxes.
        ariaLabel: `${edge.source} ${edge.relation} ${edge.target}`,
        animated: false,
        deletable: false,
        selectable: false,
        style: {
          opacity: edge.contracted ? 0.3 : 1,
          stroke: edge.onProofPath ? "var(--ng-danger)" : "var(--ng-border-strong)",
          strokeWidth: edge.onProofPath ? 2 : 1,
        },
      })),
    [graph.edges],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      edgesFocusable={false}
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
      minZoom={0.25}
      maxZoom={1.75}
      onNodeClick={(_event, node) => onSelect(node.id)}
      onPaneClick={() => onSelect(null)}
      onMoveStart={(event) => {
        // Only a USER move takes the camera. A programmatic fit also fires this,
        // and treating that as intent would make camera-follow disable itself
        // the first time it worked.
        if (event) onUserTookCamera();
      }}
      aria-label="Evidence graph"
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--ng-border-faint)" />
      <Controls showInteractive={false} />
      <CameraController
        graph={graph}
        selectedId={selectedId}
        enabled={cameraFollows}
        reduce={Boolean(reduce)}
      />
    </ReactFlow>
  );
}

/**
 * Frames the active branch, and nothing more.
 *
 * "Active" is the newest node the projection produced, which is the one the
 * audit just did something to. At the verdict the frame widens to the whole
 * proof so the argument can be read end to end — that is the pullback §9.1 asks
 * for, expressed as a camera target rather than as a separate animation.
 */
function CameraController({
  graph,
  selectedId,
  enabled,
  reduce,
}: {
  graph: EvidenceGraphModel;
  selectedId: string | null;
  enabled: boolean;
  reduce: boolean;
}) {
  const flow = useReactFlow();
  const lastTarget = useRef<string | null>(null);

  const atVerdict = graph.nodes.some((node) => node.kind === "verdict");
  const active = graph.nodes[graph.nodes.length - 1]?.id ?? null;

  const fit = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      void flow.fitView({
        nodes: ids.map((id) => ({ id })),
        padding: 0.35,
        duration: reduce ? 0 : 420,
        maxZoom: 1,
      });
    },
    [flow, reduce],
  );

  useEffect(() => {
    if (!enabled || selectedId !== null) return;
    if (atVerdict) {
      // Pull back to the proof: confirmed and deferred paths, plus the verdict.
      const proof = graph.nodes.filter((node) => node.onProofPath).map((node) => node.id);
      if (lastTarget.current !== "verdict") {
        lastTarget.current = "verdict";
        fit(proof.length > 1 ? proof : graph.nodes.map((node) => node.id));
      }
      return;
    }
    if (active && active !== lastTarget.current) {
      lastTarget.current = active;
      fit([active]);
    }
  }, [active, atVerdict, enabled, fit, graph.nodes, selectedId]);

  return null;
}
