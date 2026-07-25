/** Sheet — Radix `Dialog`, edge-anchored. Mobile nav; the dep-row detail drawer.
 *
 * Same primitive as `Dialog` and therefore the same focus trap, focus restore,
 * Escape handling and page `aria-hidden`. Separate file because the *layout* is
 * different enough that folding it into `Dialog` as a prop would make both
 * harder to read, and because §4.2's row drawer is a distinct interaction: it
 * exists so a row click does not destroy the table's scroll position and filter
 * state, which are expensive to rebuild.
 *
 * A sheet is modal. That is right for mobile nav and defensible for the row
 * drawer, but note the cost: while it is open the table behind cannot be
 * scrolled, so a user cannot compare two rows by opening one and glancing at
 * another. If that comparison turns out to matter, the drawer wants to be
 * non-modal (`Dialog` with `modal={false}`) rather than a different component. */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export type SheetSide = "top" | "right" | "bottom" | "left";

const SIDE: Record<SheetSide, string> = {
  top: "inset-x-0 top-0 max-h-[85vh] w-full border-b starting:-translate-y-4",
  right: "inset-y-0 right-0 h-full w-[min(26rem,calc(100vw-2rem))] border-l starting:translate-x-4",
  bottom: "inset-x-0 bottom-0 max-h-[85vh] w-full border-t starting:translate-y-4",
  left: "inset-y-0 left-0 h-full w-[min(20rem,calc(100vw-3rem))] border-r starting:-translate-x-4",
};

export type SheetContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  side?: SheetSide;
};

export function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-50 bg-scrim",
          "transition-opacity duration-enter ease-out starting:opacity-0",
          "motion-reduce:transition-none",
        )}
      />
      <DialogPrimitive.Content
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col border-border bg-raised text-text shadow-modal",
          // The body is the only scroller, same reasoning as `Dialog`
          // layout="scroll": a whole-sheet scroll takes the title and the close
          // button off screen exactly when the content is longest.
          "grid grid-rows-[auto_minmax(0,1fr)]",
          "transition-[opacity,transform] duration-enter ease-out",
          "starting:opacity-0 motion-reduce:transition-none",
          SIDE[side],
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          className={cn(
            "absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md",
            "text-text-3 transition-colors duration-fast hover:bg-sunken hover:text-text",
            FOCUS_RING,
          )}
        >
          <X aria-hidden="true" className="size-icon" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cn("flex flex-col gap-1 border-b border-border px-4 py-3 pr-12", className)}
      {...props}
    />
  );
}

export function SheetBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      tabIndex={0}
      className={cn("overflow-y-auto px-4 py-3 text-sm", FOCUS_RING, className)}
      {...props}
    />
  );
}
