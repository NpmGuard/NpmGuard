/** Skeleton — loading placeholder.
 *
 * `className` is **required**, and that is the whole design of this component.
 * Brief §3.1: a skeleton is legitimate "only where the final layout's dimensions
 * are known — otherwise it causes the layout shift it exists to prevent." A
 * skeleton with no size collapses to zero height and then shoves the page when
 * content lands, which is strictly worse than showing nothing. Making the
 * dimension-carrying prop non-optional turns that rule into a compile error.
 *
 * Always `aria-hidden`: the *region* announces the wait via `aria-busy`
 * (`DataRegion` does this), and a screen reader reading out a row of grey boxes
 * is noise. Never put text inside one.
 *
 * Achromatic — a skeleton is on the progress axis (§2.2), so no hue. */

import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

export type SkeletonProps = Omit<ComponentProps<"div">, "children" | "className"> & {
  /** Required: must carry the final element's dimensions, e.g. `"h-4 w-32"`. */
  className: string;
};

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      data-state="loading"
      // `animate-pulse` is a Tailwind built-in, so this needs nothing from the
      // token layer, and it is opacity-only — which satisfies §2.9's
      // transform/opacity-only rule and is what `prefers-reduced-motion`
      // tolerates best. `motion-reduce:animate-none` stops it entirely.
      className={cn("animate-pulse rounded-sm bg-progress-track motion-reduce:animate-none", className)}
      {...props}
    />
  );
}
