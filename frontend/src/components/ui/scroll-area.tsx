/** ScrollArea — Radix `ScrollArea`. Log pane, file tree, dep-table viewport.
 *
 * Radix keeps native scrolling (wheel, trackpad momentum, keyboard, find-in-page)
 * and only replaces the *scrollbar* rendering — which is why it is safe here and
 * why a JS-driven custom scroller would not be.
 *
 * **The trap this component invites** (brief §3.1): "Must not nest a second
 * scroll region inside the page scroll." A `ScrollArea` with no height cap does
 * not scroll — it grows, and the page scrolls instead, so the user gets two
 * scrollbars that fight. Every call site must set a height or a `max-h`. There is
 * no sensible default this file could supply, because the right cap is always
 * `calc(viewport - the chrome above it)`.
 *
 * The corollary from §3.2: content inside a scroll area is invisible to browser
 * find-in-page once virtualized, so any virtualized list needs its own search
 * input. That belongs to the table layer, not here. */

import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

export function ScrollArea({
  className,
  children,
  orientation = "vertical",
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  orientation?: "vertical" | "horizontal" | "both";
}) {
  return (
    <ScrollAreaPrimitive.Root className={cn("relative overflow-hidden", className)} {...props}>
      {/* `h-full w-full` on the viewport, not the root: the root is the clipping
          box and the viewport is what actually scrolls. */}
      <ScrollAreaPrimitive.Viewport className="h-full w-full">{children}</ScrollAreaPrimitive.Viewport>
      {orientation !== "horizontal" ? <ScrollBar orientation="vertical" /> : null}
      {orientation !== "vertical" ? <ScrollBar orientation="horizontal" /> : null}
      <ScrollAreaPrimitive.Corner className="bg-transparent" />
    </ScrollAreaPrimitive.Root>
  );
}

export function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: ComponentProps<typeof ScrollAreaPrimitive.Scrollbar>) {
  return (
    <ScrollAreaPrimitive.Scrollbar
      orientation={orientation}
      className={cn(
        "flex touch-none select-none p-0.5 transition-colors duration-fast",
        orientation === "vertical" ? "h-full w-2" : "h-2 w-full flex-col",
        className,
      )}
      {...props}
    >
      {/* `border-strong` and not `border`: a scrollbar thumb is a non-text UI
          mark and the decorative hairline (1.3:1) would be invisible on a
          sunken log pane. */}
      <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-xs bg-border-strong" />
    </ScrollAreaPrimitive.Scrollbar>
  );
}
