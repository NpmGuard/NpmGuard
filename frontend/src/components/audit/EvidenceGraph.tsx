/**
 * The evidence graph canvas.
 *
 * React Flow is used as a NON-EDITABLE viewport: it owns pan, zoom, selection,
 * keyboard focus and the fit camera; the application owns every node and edge.
 * Dragging, connecting and deleting are all off, because a node a user could
 * move or remove would be a shape no event produced — and the whole claim this
 * surface makes is that everything on it came off the wire.
 *
 * ── Loose in feel, deterministic in fact ────────────────────────────────────
 *
 * It reads like a link graph — chips floating on a dotted field, curved links,
 * whitespace doing the grouping — but the positions are COMPUTED from the
 * projection's (column, row), not solved. A force simulation would give the same
 * audit a different picture on every load and a different one on every frame,
 * which breaks the property this surface rests on: two people watching one
 * replay are looking at the same thing, and a seek lands where the viewer
 * expects. The organic look is worth having; the instability that usually comes
 * with it is not.
 *
 * ── Camera ──────────────────────────────────────────────────────────────────
 *
 * Follows the active branch until the viewer touches it, then stops until they
 * ask for it back. Interruptible, and never during an inspection: a canvas that
 * re-frames while someone is reading a node has taken the page away from them.
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

/**
 * Column pitch and row pitch, in flow units.
 *
 * ROW_PITCH must clear the tallest chip plus breathing room — nodes that overlap
 * are not a cosmetic problem, they hide each other's outcome. It is a constant
 * rather than a measurement because a measured layout reflows as content loads,
 * and a graph that reflows under a replay is a graph you cannot point at.
 */
const COLUMN_PITCH = 300;
const ROW_PITCH = 112;

/**
 * How far a node may drift from its grid slot, in flow units.
 *
 * The drift is what makes the graph read as a field of linked things rather than
 * as a table with curves drawn on it — depth still runs left to right and
 * siblings still stack, but nothing lines up perfectly, so the eye follows the
 * LINKS instead of reading down a column.
 *
 * It is DETERMINISTIC: the offset is a hash of the node's id, so a node lands in
 * the same place on every load, on every machine, at every playback speed. A
 * force simulation would give the same organic feel and take the property this
 * surface is built on — that two people watching one replay see one picture, and
 * that a seek lands where the viewer left off.
 *
 * Bounded well under the pitch so drift can never reorder anything: a node that
 * wandered past its neighbour would be saying something about causality that the
 * events do not.
 */
const DRIFT_X = 34;
const DRIFT_Y = 22;

/** FNV-1a over the node id — a stable, well-spread number in [0, 1). */
function drift(id: string, salt: number): number {
  let hash = 0x811c9dc5 ^ salt;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

export interface EvidenceGraphProps {
  graph: EvidenceGraphModel;
  selectedId: string | null;
  onSelect: (nodeId: string | null) => void;
  cameraFollows: boolean;
  onUserTookCamera: () => void;
  /** true when the playhead advanced one frame — false after a seek */
  animateEntrance: boolean;
  /** clamps entrance duration at high speed */
  motionScale: number;
}

export function EvidenceGraphCanvas({
  graph,
  selectedId,
  onSelect,
  cameraFollows,
  onUserTookCamera,
  animateEntrance,
  motionScale,
}: EvidenceGraphProps) {
  const reduce = useReducedMotion();
  // Nodes already on screen do not re-animate. Without this every projection
  // change would replay the whole graph's entrance, and a seek would look like a
  // crash rather than a jump.
  const seen = useRef<Set<string>>(new Set());

  const nodes = useMemo<Node[]>(() => {
    const next = graph.nodes.map((node) => {
      const entering = animateEntrance && !seen.current.has(node.id);
      return {
        id: node.id,
        type: node.kind,
        position: {
          x: node.column * COLUMN_PITCH + (drift(node.id, 1) - 0.5) * 2 * DRIFT_X,
          y: node.row * ROW_PITCH + (drift(node.id, 2) - 0.5) * 2 * DRIFT_Y,
        },
        data: {
          ...node.data,
          onProofPath: node.onProofPath,
          contracted: node.contracted,
          selected: node.id === selectedId,
          entering,
          motionScale,
        },
        selected: node.id === selectedId,
        draggable: false,
        connectable: false,
        deletable: false,
        ariaLabel: node.id,
      };
    });
    seen.current = new Set(graph.nodes.map((node) => node.id));
    return next;
  }, [animateEntrance, graph.nodes, motionScale, selectedId]);

  // The proof path lights up only while the verdict — or something on it — is
  // SELECTED. A package with twelve confirmed hypotheses would otherwise render
  // every edge in danger red, and a graph where everything is alarming carries
  // no alarm at all.
  const proofLit = useMemo(() => {
    if (!selectedId) return false;
    return graph.nodes.some((node) => node.id === selectedId && node.onProofPath);
  }, [graph.nodes, selectedId]);

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const lit = proofLit && edge.onProofPath;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          // Curved: a link graph's connections are read as paths, and a right
          // angle reads as a wire in a diagram.
          type: "simplebezier",
          // The relation is on the edge itself, so a screen reader reading the
          // graph gets the causal statement rather than a line between two boxes.
          ariaLabel: `${edge.source} ${edge.relation} ${edge.target}`,
          animated: false,
          deletable: false,
          selectable: false,
          style: {
            opacity: edge.contracted ? 0.25 : lit ? 1 : 0.5,
            stroke: lit ? "var(--ng-danger)" : "var(--ng-border-strong)",
            strokeWidth: lit ? 1.75 : 1,
          },
        };
      }),
    [graph.edges, proofLit],
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
      minZoom={0.2}
      maxZoom={1.6}
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
      {/* A recessed field, so the chips on `surface` read as objects sitting on
          a plane. On `canvas` they were paper on paper. */}
      <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="var(--ng-border)" />
      <Controls showInteractive={false} position="bottom-left" />
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
  const framed = useRef(false);

  const atVerdict = graph.nodes.some((node) => node.kind === "verdict");
  const active = graph.nodes[graph.nodes.length - 1]?.id ?? null;

  const fit = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      void flow.fitView({
        nodes: ids.map((id) => ({ id })),
        padding: 0.4,
        duration: reduce ? 0 : 520,
        maxZoom: 1,
      });
    },
    [flow, reduce],
  );

  useEffect(() => {
    if (!enabled || selectedId !== null) return;
    // First paint: frame whatever exists, so the graph opens centred instead of
    // pinned in a corner while the first nodes arrive.
    if (!framed.current && graph.nodes.length > 0) {
      framed.current = true;
      fit(graph.nodes.map((node) => node.id));
      return;
    }
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
      // Frame the active node WITH its parent chain in view, so a new branch
      // arrives in context instead of the camera snapping to a lone chip.
      const incoming = graph.edges
        .filter((edge) => edge.target === active)
        .map((edge) => edge.source);
      fit([active, ...incoming]);
    }
  }, [active, atVerdict, enabled, fit, graph.edges, graph.nodes, selectedId]);

  return null;
}
