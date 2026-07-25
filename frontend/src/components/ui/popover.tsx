/** Popover — Radix `Popover`.
 *
 * Filter builders, the CI explainer, "why this verdict". Click-triggered and
 * focus-managed, which is what makes it the touch-reachable counterpart to
 * `Tooltip` — see the note in `tooltip.tsx`.
 *
 * Radix moves focus into the content on open and returns it to the trigger on
 * close, and it is *non-modal*: the page behind stays interactive and scrollable.
 * That is right for a filter builder and wrong for a confirmation — if the user
 * must answer before continuing, that is a `Dialog`. */

import * as PopoverPrimitive from "@radix-ui/react-popover";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className,
  sideOffset = 6,
  align = "start",
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-72 rounded-lg border border-border bg-raised p-3 text-sm text-text shadow-pop",
          "max-h-[var(--radix-popover-content-available-height)] overflow-y-auto",
          "transition-opacity duration-base ease-out starting:opacity-0",
          "motion-reduce:transition-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
