/** Switch — Radix `Switch`. Protect, per repo.
 *
 * Two domain states beyond on/off, both from brief §3.1, and both are about
 * telling the truth while the server catches up:
 *
 *   `pending`  F-D1 says the toggle responds immediately while the first scan
 *              runs behind it. So the thumb moves at once (optimistic) and the
 *              track shimmers to say "not settled yet". Also sets `aria-busy`,
 *              because a sighted user sees the shimmer and a screen-reader user
 *              must not be told the change has landed when it has not.
 *
 *   `blockedReason`  quota exhausted, or the install lacks permission. Disables
 *              the control *and renders the reason*, wired via
 *              `aria-describedby`. A disabled switch with no explanation is the
 *              worst version of this state: the user retries, it does nothing,
 *              and they conclude the product is broken.
 *
 * The thumb translates on `transform` only (§2.9). The track is `accent` when on
 * — a Protect toggle is a system control, not a verdict, so no outcome hue
 * appears here. */

import * as SwitchPrimitive from "@radix-ui/react-switch";
import { type ComponentProps, useId } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export type SwitchProps = Omit<ComponentProps<typeof SwitchPrimitive.Root>, "children"> & {
  /** Optimistic on-state: change accepted locally, not yet confirmed. */
  pending?: boolean;
  /** Why the control cannot be used. Presence implies `disabled`. */
  blockedReason?: string;
};

export function Switch({
  className,
  pending = false,
  blockedReason,
  disabled,
  "aria-describedby": describedBy,
  ...props
}: SwitchProps) {
  const reasonId = useId();
  const blocked = blockedReason !== undefined;
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <SwitchPrimitive.Root
        disabled={disabled ?? blocked}
        aria-busy={pending || undefined}
        aria-describedby={cn(describedBy, blocked ? reasonId : undefined) || undefined}
        data-pending={pending || undefined}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-sm border p-0.5",
          "transition-colors duration-base ease-std",
          "border-border-control bg-progress-track",
          "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
          "disabled:pointer-events-none disabled:opacity-50",
          // The shimmer is the only thing distinguishing optimistic-on from
          // confirmed-on, so it must survive reduced motion as *something*:
          // `animate-pulse` is opacity-only and `motion-reduce` swaps it for a
          // permanent dimming rather than removing the signal.
          pending ? "animate-pulse motion-reduce:animate-none motion-reduce:opacity-70" : "",
          FOCUS_RING,
          className,
        )}
        {...props}
      >
        <SwitchPrimitive.Thumb
          className={cn(
            "pointer-events-none block size-3.5 rounded-xs bg-surface shadow-sm",
            "transition-transform duration-base ease-std motion-reduce:transition-none",
            "data-[state=checked]:translate-x-4",
          )}
        />
      </SwitchPrimitive.Root>
      {blocked ? (
        // `error` violet, not `danger` red: a quota ceiling is "we cannot check",
        // which shares the §0 rule-3 slot with a failed read. Red would claim
        // something about a package.
        <span id={reasonId} className="text-2xs text-error-text">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}
