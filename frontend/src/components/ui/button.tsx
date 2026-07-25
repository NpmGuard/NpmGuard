/** Button.
 *
 * Not in the brief's §3.1 inventory — an omission, since §2.2 specifies
 * `--color-border-control` for "unfilled buttons" and §2.8 specifies
 * `--h-control-*` heights, and `EmptyState`, `DegradedState`, `Dialog` and
 * `AlertDialog` all require one. Built here so those components do not each
 * invent their own.
 *
 * Radix has no button primitive and does not need one: `<button>` is already
 * accessible. What this adds is the token styling, the one focus ring, and the
 * ≥44px touch target below the `md` breakpoint (§2.8) that a raw `<button>`
 * cannot carry.
 *
 * `asChild` renders the child element with these classes instead of a `<button>`.
 * Use it for navigation — `<Button asChild><Link to="…">` keeps the `<a>` an
 * `<a>`, which matters: middle-click, "open in new tab" and the screen-reader
 * announcement all come from the element, not from the styling. A `<button>` that
 * navigates is the most common a11y regression in a design system, and this is
 * the escape hatch that prevents it. {@link buttonClasses} is the same thing for
 * call sites that would rather not nest.
 *
 * `variant="danger"` exists for destructive confirmations. Note that per brief
 * §0 rule 3 the danger hue means "we are making a claim about a package" *or*
 * "this action destroys something" — it never means "a fetch failed". A retry
 * button on a `DegradedState` is `variant="outline"`, not `danger`. */

import { Slot } from "@radix-ui/react-slot";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export type ButtonVariant = "primary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-on border border-accent hover:bg-accent-text hover:border-accent-text",
  // `border-border-control` and not `border-border`: the decorative hairline
  // measures 1.3:1, which fails WCAG 1.4.11 for a control whose boundary is its
  // only affordance. §2.2 added the control step precisely for this.
  outline: "bg-surface text-text border border-border-control hover:bg-sunken",
  ghost: "bg-transparent text-text-2 border border-transparent hover:bg-sunken hover:text-text",
  danger: "bg-danger text-danger-on border border-danger hover:bg-danger-text hover:border-danger-text",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-control-sm px-2 text-xs gap-1",
  md: "h-control px-3 text-sm gap-1.5",
  lg: "h-control-lg px-4 text-base gap-2",
};

export function buttonClasses(
  { variant = "primary", size = "md" }: { variant?: ButtonVariant; size?: ButtonSize } = {},
): string {
  return cn(
    "relative inline-flex select-none items-center justify-center rounded-md font-sans font-medium",
    "transition-colors duration-fast ease-std",
    "disabled:pointer-events-none disabled:opacity-50",
    // The hit area, not the visual box, grows to --tap-min below `md` (§2.8).
    // A pseudo-element does this without changing layout, which is why the
    // element is `relative`.
    "max-md:before:absolute max-md:before:left-1/2 max-md:before:top-1/2",
    "max-md:before:h-[max(100%,var(--ng-tap-min))] max-md:before:w-[max(100%,var(--ng-tap-min))]",
    "max-md:before:-translate-x-1/2 max-md:before:-translate-y-1/2 max-md:before:content-['']",
    FOCUS_RING,
    VARIANTS[variant],
    SIZES[size],
  );
}

export type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
};

/** No `forwardRef` anywhere in this directory: React 19 passes `ref` through as
 * an ordinary prop, so spreading `...props` forwards it. Do not reintroduce
 * `forwardRef` — it is dead weight on this React version. */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  type,
  ...props
}: ButtonProps) {
  const classes = cn(buttonClasses({ variant, size }), className);
  if (asChild) {
    // No `type` when rendering someone else's element: `type="button"` on an
    // `<a>` is an invalid attribute that some validators flag and no browser uses.
    return <Slot className={classes} {...props} />;
  }
  return <button type={type ?? "button"} className={classes} {...props} />;
}
