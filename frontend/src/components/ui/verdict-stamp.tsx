/** VerdictStamp — the verdict, everywhere. Brief §3.3.
 *
 * This lived in `components/panel/tone.tsx` and its own docblock reported the
 * placement as a gap: the brief inventories it in the design-system layer, and
 * `pages/Replays.tsx` carried a comment apologising for reaching into the panel
 * cluster to render a verdict on a surface that is not the panel. `/packages`
 * would have been the third such call site and `/scan` the fourth. Moved here;
 * `tone.tsx` keeps the tone/rank *logic*, which genuinely is panel domain.
 *
 * `Badge` is deliberately not used: its own docblock says a verdict is not a
 * metadata chip, and a coloured badge beside three neutral ones reads as the
 * least important thing on the row rather than the most.
 *
 * Two brief rules are structural here rather than remembered:
 *
 *   §2.4  glyph + word + colour, in that order of priority. Remove all colour
 *         and every state is still readable — that is the stated test, and it is
 *         why the glyph is a required part of the component and not something a
 *         call site adds. Silhouettes are chosen distinct: octagon (the only
 *         polygon), closed circle+check, circle+slash ("no signal").
 *   §2.8  `rounded-sm`, never `rounded-full`. The verdict is a stamp, not a
 *         pill; §2.8 calls that the single strongest carrier of the "record, not
 *         a consumer app" read, and forbids round shapes on status elements.
 *
 * DECISION the brief left open (§2.4 says the verdict glyphs "are custom SVGs
 * because Lucide has no filled-octagon or slashed-circle at the silhouette
 * distinctness this needs"): Lucide's `OctagonAlert` / `CircleCheck` /
 * `CircleSlash` are used instead. Lucide *does* ship a slashed circle — that
 * half of the claim is simply wrong, and `degraded-state.tsx` already uses it —
 * and the octagon's distinctness comes from being the only non-circular
 * silhouette in the set, which the outline carries as well as a fill would.
 * Commissioning three custom SVGs to gain a fill is not worth a third asset
 * pipeline; revisit only if the octagon tests badly at 14px.
 *
 * The outcome word is the stamp's ONLY text node — the glyph is an `<svg>` and
 * contributes none. Keep it that way: wrapping the word in its own `<span>`
 * makes `getByText("DANGEROUS")` match both the wrapper and the shell, and the
 * alerts-banner test counts those matches. */

import type { Outcome } from "@npmguard/shared";
import type { LucideIcon } from "lucide-react";
import { Circle, CircleCheck, CircleDashed, CircleSlash, LoaderCircle, OctagonAlert } from "lucide-react";
import { cn } from "../../lib/cn.ts";

/** Shared shell. `tabular-nums` because a stamp sometimes carries a count, and a
 * column of stamps must not jitter as digits change. */
const STAMP = cn(
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
  "font-mono text-2xs font-medium tracking-wide leading-none uppercase",
  "whitespace-nowrap tabular-nums",
);

const OUTCOME_GLYPH: Record<Outcome, LucideIcon> = {
  SAFE: CircleCheck,
  DANGEROUS: OctagonAlert,
  ERROR: CircleSlash,
};

const OUTCOME_SKIN: Record<Outcome, string> = {
  SAFE: "border-safe-border bg-safe-wash text-safe-text",
  DANGEROUS: "border-danger-border bg-danger-wash text-danger-text",
  // ERROR is the `error` violet slot, shared with UI degradation: both mean *we
  // don't know*, and §0 rule 3 reserves red for claims about a package. An audit
  // that could not conclude is not a finding.
  ERROR: "border-error-border bg-error-wash text-error-text",
};

/** The verdict stamp. Uppercase rendering comes from the class, not the string,
 * so the DOM keeps the contract's own casing.
 *
 * The param is the panel `Outcome` (SAFE | ERROR | DANGEROUS), which is the
 * WIDER of the two verdict domains — audit `VerdictEnum` is `{SAFE, DANGEROUS}`
 * because a failed audit emits an `audit_error` event instead. A `VerdictEnum`
 * is therefore accepted here without a cast, and the two domains stay separate
 * in the contract where they belong. */
export function VerdictStamp({ outcome, className }: { outcome: Outcome; className?: string }) {
  const Glyph = OUTCOME_GLYPH[outcome];
  return (
    <span data-outcome={outcome} className={cn(STAMP, OUTCOME_SKIN[outcome], className)}>
      <Glyph aria-hidden="true" strokeWidth={1.5} className="size-icon-sm shrink-0" />
      {outcome}
    </span>
  );
}

/** Where a subject sits on the PROGRESS axis, for the cases that have no outcome
 * yet. Achromatic by construction (§2.2 rule 2): the label is neutral ink and
 * the only hue in the whole component is `progress-mark` on the spinner's
 * moving arc, which is the one status-adjacent use of accent the brief permits.
 * That confinement is what keeps "running" from ever reading as a verdict. */
export type ProgressState = "queued" | "running" | "unaudited";

const PROGRESS_GLYPH: Record<ProgressState, LucideIcon> = {
  // §2.4's silhouettes: hollow = nothing yet, arc = the only moving glyph,
  // dashed hollow = not attempted.
  queued: Circle,
  running: LoaderCircle,
  unaudited: CircleDashed,
};

export function ProgressStamp({
  state,
  children,
  className,
}: {
  state: ProgressState;
  /** The label. Required, and never conveyed by the glyph alone: §2.9 rule 1 —
   * if motion is the only thing saying an audit is alive, it looks dead the
   * moment animation is disabled, which it is for every reduced-motion user. */
  children: string;
  className?: string;
}) {
  const Glyph = PROGRESS_GLYPH[state];
  return (
    <span
      data-progress={state}
      className={cn(
        STAMP,
        "border-border bg-sunken",
        state === "unaudited" ? "text-progress-idle" : "text-progress-ink",
        className,
      )}
    >
      <Glyph
        aria-hidden="true"
        strokeWidth={1.5}
        className={cn(
          "size-icon-sm shrink-0",
          // Reduced motion turns this into a static arc glyph rather than
          // removing it — the glyph is still the §2.4 silhouette for `running`.
          state === "running" && "animate-spin text-progress-mark motion-reduce:animate-none",
        )}
      />
      {children}
    </span>
  );
}
