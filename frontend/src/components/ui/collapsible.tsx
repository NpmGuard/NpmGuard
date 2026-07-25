/** Collapsible — Radix `Collapsible`.
 *
 * The disclosure sections inside a `HypothesisCard` (claim, compiled experiment,
 * oracle output, judgment) and the phase substeps on the rail.
 *
 * Radix owns the `aria-expanded` / `aria-controls` pair and the `data-state` on
 * both trigger and content. That pairing is the whole accessibility surface of a
 * disclosure and it is trivially easy to get subtly wrong by hand — the common
 * failure being `aria-expanded` on the wrong node, which makes a screen reader
 * announce a collapsed section as expanded.
 *
 * Default-collapse anything over 6 items (§3.1). The height animation is
 * deliberately absent: §2.9 permits only `transform` and `opacity`, and Radix's
 * `--radix-collapsible-content-height` route animates `height`. The token layer
 * can add a grid-rows or clip-path variant later if it wants one. */

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleContent = CollapsiblePrimitive.Content;

export function CollapsibleTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  return (
    <CollapsiblePrimitive.Trigger
      className={cn(
        "group inline-flex items-center gap-1 rounded-sm text-sm text-text-2",
        "transition-colors duration-fast hover:text-text",
        "min-h-control-sm max-md:min-h-tap",
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      {/* Rotation, not a glyph swap: one element means one accessible name and no
          flash of the wrong icon. Driven off the trigger's own `data-state`. */}
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-text-3 transition-transform duration-fast ease-std",
          "group-data-[state=open]:rotate-90 motion-reduce:transition-none",
        )}
      />
      {children}
    </CollapsiblePrimitive.Trigger>
  );
}
