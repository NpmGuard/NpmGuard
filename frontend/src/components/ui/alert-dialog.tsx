/** AlertDialog — Radix `AlertDialog`.
 *
 * For destructive confirmations only: disable Protect, revoke an install,
 * force-install a DANGEROUS package. If the action is reversible, use `Dialog`;
 * an alert dialog that cries wolf trains people to click through it.
 *
 * Why this is a different primitive from `Dialog` rather than a variant: Radix's
 * AlertDialog is deliberately *harder to dismiss* — no close button, no
 * outside-click dismissal, and `role="alertdialog"` so a screen reader announces
 * the description immediately instead of waiting to be read. Those are semantics,
 * not styling, which is why they cannot be a `Dialog` prop.
 *
 * **The action button is never the default-focused element.** `AlertDialogCancel`
 * comes first in DOM order and Radix focuses the first tabbable node, so a
 * reflexive Enter cancels rather than destroys. `alert-dialog.test.tsx` asserts
 * this rather than trusting it, because a future footer reorder would silently
 * break it. */

import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import type { ComponentProps } from "react";
import { buttonClasses } from "./button.tsx";
import { cn } from "../../lib/cn.ts";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

export function AlertDialogContent({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Content>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-50 bg-scrim",
          "transition-opacity duration-enter ease-out starting:opacity-0",
          "motion-reduce:transition-none",
        )}
      />
      <AlertDialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2",
          "flex flex-col gap-3 rounded-xl border border-border bg-raised p-5 text-text shadow-modal",
          "transition-[opacity,transform] duration-enter ease-out",
          "starting:opacity-0 starting:translate-y-[calc(-50%+8px)] motion-reduce:transition-none",
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("text-xl font-semibold text-text", className)}
      {...props}
    />
  );
}

/** Required, not optional: `role="alertdialog"` promises the assistive
 * technology a description, and Radix logs when there is none. Say what will be
 * destroyed and whether it can be undone. */
export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-sm text-text-2", className)}
      {...props}
    />
  );
}

/** Cancel is authored first so it is the first tabbable node — see the file
 * header. `sm:flex-row` keeps Cancel on the left visually, matching DOM order,
 * so the reading order and the tab order agree. */
export function AlertDialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return (
    <footer
      className={cn("mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export function AlertDialogCancel({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
  return (
    <AlertDialogPrimitive.Cancel
      className={cn(buttonClasses({ variant: "outline" }), className)}
      {...props}
    />
  );
}

/** Wears `danger` because this button destroys something — one of the two
 * licensed uses of red (§0 rule 3, the other being a claim about a package).
 * A failed *fetch* never gets this treatment; that is `DegradedState`, in violet. */
export function AlertDialogAction({
  className,
  ...props
}: ComponentProps<typeof AlertDialogPrimitive.Action>) {
  return (
    <AlertDialogPrimitive.Action
      className={cn(buttonClasses({ variant: "danger" }), className)}
      {...props}
    />
  );
}
