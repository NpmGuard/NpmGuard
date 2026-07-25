/** Tooltip — Radix `Tooltip`.
 *
 * Truncated package names, metric definitions, glyph legends.
 *
 * **Read this before reaching for it.** Radix Tooltip opens on hover and on
 * keyboard focus, but *not* on touch — that is correct behaviour, not a gap, and
 * it means a tooltip is unreachable for every touch user. So brief §3.1's rule
 * is a hard one: a tooltip is never the only place information exists. If the
 * content is required to operate the UI, use `Popover` (which opens on click and
 * therefore works on touch) or put the text on the page.
 *
 * Concretely: a tooltip explaining what `deferred` means is fine. A tooltip
 * holding the full package name of a truncated cell is fine *only* because the
 * full name is also in the row's drawer. A tooltip holding the reason a scan
 * failed is not fine — that is a `DegradedState`.
 *
 * `TooltipProvider` belongs once, high in the app tree, so the shared
 * open-delay/skip-delay timers behave as one group; per-tooltip providers make
 * every tooltip feel like the first one. */

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 max-w-[32ch] rounded-md border border-border bg-raised px-2 py-1",
          "text-xs text-text shadow-pop",
          "transition-opacity duration-base ease-out starting:opacity-0",
          "motion-reduce:transition-none",
          className,
        )}
        {...props}
      >
        {children}
        {/* Filled with the surface and stroked with the border so the arrow does
            not read as a solid tab hanging off a hairline box. */}
        <TooltipPrimitive.Arrow className="fill-raised stroke-border" width={10} height={5} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
