/** Dialog — Radix `Dialog`.
 *
 * Replaces the hand-rolled `PanelDialog`, which owned its own focus trap,
 * Escape handler, body-scroll lock, portal and ARIA wiring. Each of those is a
 * place to be silently wrong, and "silently wrong accessibility" is the failure
 * mode nobody notices until someone cannot operate the app. Radix owns all five
 * now; this file owns markup and tokens, nothing else.
 *
 * What Radix gives us that the hand-rolled version did not:
 *   - focus is moved in on open and **restored to the trigger on close**
 *   - focus is trapped for real, including against programmatic focus moves
 *   - `aria-modal`, `aria-labelledby`, `aria-describedby` wired from the actual
 *     Title/Description nodes rather than a hand-passed `ariaLabel` string
 *   - the rest of the page gets `aria-hidden`, so a screen reader cannot walk
 *     out of the dialog while sighted focus stays in it
 *   - pointer-outside vs. focus-outside dismissal are distinguished
 *
 * MOTION: enter is a `@starting-style` transition (Tailwind's `starting:`
 * variant), not a CSS animation. That is deliberate. Radix waits for
 * `animationend` before unmounting whenever the computed `animation-name` is not
 * `none` — so referencing keyframes that the token layer has not defined yet
 * would leave the dialog mounted forever. A transition has no such coupling: if
 * `starting:` is unavailable the dialog simply appears, which is a degradation
 * in polish and not in function. The §2.9 exit choreography needs `@keyframes`
 * and therefore belongs in the styles layer; the `data-[state]` hooks it would
 * target are already on these elements. */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export function DialogOverlay({ className, ...props }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-scrim",
        "transition-opacity duration-enter ease-out starting:opacity-0",
        "motion-reduce:transition-none",
        className,
      )}
      {...props}
    />
  );
}

export type DialogContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  /** `fit` sizes to content (default). `scroll` pins header and footer and
   * scrolls only `DialogBody` — the variant §3.1 asks for, for long evidence.
   * A dialog whose whole box scrolls loses its title and its close button
   * exactly when the content is longest. */
  layout?: "fit" | "scroll";
  /** Set false when the only correct exits are the footer buttons. Escape and
   * outside-click still work; suppress those with `onEscapeKeyDown` /
   * `onPointerDownOutside` on a case-by-case basis, never globally. */
  showClose?: boolean;
};

export function DialogContent({
  className,
  children,
  layout = "fit",
  showClose = true,
  ...props
}: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-layout={layout}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
          "rounded-xl border border-border bg-raised text-text shadow-modal",
          // `grid` + `minmax(0,1fr)` on the body row is what lets the body be
          // the only scroller; with `flex` the body refuses to shrink.
          layout === "scroll" ? "grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]" : "",
          "transition-[opacity,transform] duration-enter ease-out",
          "starting:opacity-0 starting:translate-y-[calc(-50%+8px)]",
          "motion-reduce:transition-none",
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
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
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      className={cn("flex flex-col gap-1 border-b border-border px-5 py-4 pr-12", className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    // Always render a Title. Radix warns without one, and the warning is right:
    // a modal with no accessible name is a modal a screen-reader user cannot
    // identify. Use `sr-only` on it before you consider omitting it.
    <DialogPrimitive.Title className={cn("text-xl font-semibold text-text", className)} {...props} />
  );
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description className={cn("text-sm text-text-2", className)} {...props} />
  );
}

/** The scrollable region of a `layout="scroll"` dialog. `tabIndex={0}` is not
 * decoration: a scroll container that is not focusable cannot be scrolled by
 * keyboard alone, which strands keyboard users in long evidence. */
export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      tabIndex={0}
      className={cn("overflow-y-auto px-5 py-4 text-sm text-text", FOCUS_RING, className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      className={cn(
        "flex flex-col-reverse gap-2 border-t border-border px-5 py-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}
