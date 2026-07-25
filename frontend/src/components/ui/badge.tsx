/** Badge — plain. Provenance and metadata chips: `direct`, `transitive`, `dev`,
 * `cached 3d ago`, `watch-audited`, `replay`, `deferred`.
 *
 * **Neutral by default, and that is the design** (§3.2): chips are metadata and
 * almost never coloured. A row with four coloured chips has no hierarchy left for
 * the one thing on it that is a verdict. The coloured tones exist for the rare
 * chip that genuinely is an outcome — and if you are reaching for `danger` here,
 * the thing you want is probably `VerdictStamp`, not a badge.
 *
 * `rounded-sm`, never `rounded-full`: §2.8 makes the stamp-not-pill shape the
 * strongest carrier of the "record, not a consumer app" reading, and a round
 * metadata chip next to a rectangular verdict stamp reads as the more important
 * of the two. */

import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

export type BadgeTone = "neutral" | "safe" | "danger" | "error" | "accent";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-border bg-sunken text-text-2",
  safe: "border-safe-border bg-safe-wash text-safe-text",
  danger: "border-danger-border bg-danger-wash text-danger-text",
  error: "border-error-border bg-error-wash text-error-text",
  accent: "border-accent-border bg-accent-wash text-accent-text",
};

export type BadgeProps = ComponentProps<"span"> & {
  tone?: BadgeTone;
  /** Machine-authored facts (`3d ago`, `depth 2`, a sha) go in mono per §2.7's
   * one rule; words about the record (`dev`, `replay`) stay in sans. */
  mono?: boolean;
};

export function Badge({ className, tone = "neutral", mono = false, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs leading-none",
        mono ? "font-mono tabular-nums" : "font-sans font-medium",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
