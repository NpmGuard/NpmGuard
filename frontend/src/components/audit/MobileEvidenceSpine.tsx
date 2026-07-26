/**
 * The mobile projection of the evidence graph: one vertical causal spine.
 *
 * NOT a scaled-down canvas. A pannable graph on a phone is a graph nobody can
 * read — every node is either too small to parse or off-screen, and pinch-zoom
 * fights the page scroll. So the same projection is rendered as the thing it
 * already is underneath: an ordered, nested causal chain.
 *
 * It is the SAME model, so the same facts are present in the same order and a
 * link shared from a phone shows the same investigation. Only the geometry is
 * dropped, because geometry is the part a small screen cannot carry.
 */

import { ChevronRight } from "lucide-react";
import type { EvidenceGraph } from "../../lib/evidence-graph.ts";
import { cn } from "../../lib/cn.ts";

export interface MobileEvidenceSpineProps {
  graph: EvidenceGraph;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
}

export function MobileEvidenceSpine({ graph, selectedId, onSelect }: MobileEvidenceSpineProps) {
  return (
    <ol aria-label="Evidence graph" className="grid gap-1.5 px-3 py-3">
      {graph.outline.map((item) => {
        const node = graph.nodes.find((candidate) => candidate.id === item.id);
        const proof = node?.onProofPath ?? false;
        return (
          <li key={item.id} style={{ paddingInlineStart: `${item.depth * 12}px` }}>
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              aria-current={item.id === selectedId ? "true" : undefined}
              className={cn(
                "flex min-h-[--ng-tap-min] w-full items-center gap-2 rounded border px-2.5 py-2 text-left",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--ng-focus-ring]",
                item.id === selectedId ? "border-accent-border bg-accent-wash" : "border-border",
                node?.contracted && "opacity-60",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "inline-block size-1.5 shrink-0 rounded-full",
                  proof ? "bg-danger" : "bg-progress-idle",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-text">{item.label}</span>
                {item.detail ? (
                  <span className="block truncate font-mono text-2xs text-text-3">
                    {item.detail}
                  </span>
                ) : null}
              </span>
              {item.state ? (
                <span className="shrink-0 font-mono text-2xs text-text-3">{item.state}</span>
              ) : null}
              <ChevronRight aria-hidden="true" className="size-icon-sm shrink-0 text-text-3" />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
