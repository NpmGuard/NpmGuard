/** Progress — Radix `Progress`. Scan progress: "12 of 340 concluded".
 *
 * Two hard rules from the brief, both enforced by the prop shape rather than by
 * discipline:
 *
 * 1. **No fabricated progress** (§2.9 rule 2). `value: number | null` — `null` is
 *    the indeterminate variant, and there is no way to express "roughly 90%".
 *    A bar that creeps to 90% and waits is N-3 expressed in motion.
 * 2. **Motion never carries information that isn't also in text** (§2.9 rule 1).
 *    `label` is required. If the animation is the only thing saying the scan is
 *    alive, the scan looks dead the moment animation is disabled — and it *is*
 *    disabled for every `prefers-reduced-motion` user.
 *
 * Achromatic track, accent fill: the fill is the moving part, which §2.2 permits
 * as the single status-adjacent use of accent. The label beside it stays neutral
 * ink so "running" can never read as a verdict.
 *
 * The indeterminate variant renders the 45° hatch — the system's one "no signal"
 * texture, which is honest here: an indeterminate bar knows nothing about
 * magnitude. §2.9 specifies the same hatch as the reduced-motion form of the
 * "marching hairline", so this is a designed state rather than a stub.
 *
 * The *marching* version is deliberately not implemented here. It needs
 * `@keyframes`, which belong to the styles layer, and a class referencing an
 * `--animate-*` token that does not exist would be dead markup with no signal
 * that it is dead. When the token lands, add the class here. (Note that this is
 * safe precisely because a Progress is always mounted — on a Radix
 * mount-controlled element, referencing undefined keyframes leaves
 * `animation-name` set, so Radix waits forever for an `animationend` and the
 * element never unmounts. That is why the dialogs use transitions, not
 * animations.) */

import * as ProgressPrimitive from "@radix-ui/react-progress";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { HATCH_NEUTRAL } from "./hatch.ts";

export type ProgressProps = Omit<
  ComponentProps<typeof ProgressPrimitive.Root>,
  "value" | "max" | "children"
> & {
  /** `null` = indeterminate. Never synthesise a number to fill this. */
  value: number | null;
  max: number;
  /** The same information the bar carries, in words. Required — see rule 2. */
  label: string;
};

export function Progress({ className, value, max, label, ...props }: ProgressProps) {
  const indeterminate = value === null;
  return (
    <div className="flex flex-col gap-1">
      <ProgressPrimitive.Root
        value={value}
        max={max}
        // Radix omits `aria-valuenow` when value is null, which is exactly the
        // ARIA contract for an indeterminate progressbar. `aria-valuetext` gives
        // the screen reader the sentence rather than "45 percent".
        aria-valuetext={label}
        className={cn(
          "relative h-1.5 w-full overflow-hidden rounded-xs bg-progress-track",
          className,
        )}
        {...props}
      >
        {indeterminate ? (
          <div
            aria-hidden="true"
            style={HATCH_NEUTRAL}
            className="absolute inset-0"
          />
        ) : (
          <ProgressPrimitive.Indicator
            className={cn(
              "size-full bg-progress-mark transition-transform duration-base ease-std",
              "motion-reduce:transition-none",
            )}
            // `translateX` on a full-width bar rather than animating `width`:
            // §2.9 permits transform and opacity only. `max <= 0` is a caller bug
            // rather than a state to render, so it clamps to empty instead of
            // producing NaN and a silently invisible bar.
            style={{ transform: `translateX(-${max > 0 ? 100 - (100 * value) / max : 100}%)` }}
          />
        )}
      </ProgressPrimitive.Root>
      <p className="font-mono text-2xs tabular-nums text-progress-ink">{label}</p>
    </div>
  );
}
