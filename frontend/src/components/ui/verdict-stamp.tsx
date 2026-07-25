/** The stamps — every "what did we conclude" mark in the system. Brief §3.3.
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

import type { HypothesisCounts, HypothesisState, Outcome } from "@npmguard/shared";
import type { LucideIcon } from "lucide-react";
import {
  Circle,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  LoaderCircle,
  OctagonAlert,
} from "lucide-react";
import type { ReactNode } from "react";
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

/* ── hypothesis state ───────────────────────────────────────────────────────
 *
 * The same stamp shell, over the investigation's own vocabulary. Kept beside
 * `VerdictStamp` rather than in `components/report/` because the LIVE stream
 * (`audit/HypothesisList`) and the DURABLE report (`report/HypothesisCard`)
 * both render it, and a hypothesis that looked like a threat live and like a
 * non-threat in the report is the specific inconsistency `report-helpers.ts`
 * exists to prevent. One implementation, one meaning.
 *
 * The tone comes from `hypothesisTone` — STATE decides, severity only
 * modulates — so this component holds the glyphs and nothing else. */

const HYP_GLYPH: Record<HypothesisState, LucideIcon> = {
  CONFIRMED: OctagonAlert,
  // The same slashed circle audit ERROR and `DegradedState` use, because
  // DEFERRED means the same thing they do: we could not decide.
  DEFERRED: CircleSlash,
  REFUTED: CircleCheck,
  IN_PROGRESS: LoaderCircle,
  OPEN: Circle,
};

const HYP_SKIN: Record<string, string> = {
  danger: "border-danger-border bg-danger-wash text-danger-text",
  error: "border-error-border bg-error-wash text-error-text",
  safe: "border-safe-border bg-safe-wash text-safe-text",
  progress: "border-border bg-sunken text-progress-ink",
};

export function HypothesisStateStamp({
  state,
  tone,
  label,
  className,
}: {
  state: HypothesisState;
  /** From `hypothesisTone(state)`. Passed rather than derived so the colour rule
   * lives in exactly one module and this component cannot drift from it. */
  tone: "danger" | "error" | "safe" | "progress";
  label: string;
  className?: string;
}) {
  const Glyph = HYP_GLYPH[state];
  return (
    <span data-hyp-state={state} className={cn(STAMP, HYP_SKIN[tone], className)}>
      <Glyph
        aria-hidden="true"
        strokeWidth={1.5}
        className={cn(
          "size-icon-sm shrink-0",
          state === "IN_PROGRESS" && "animate-spin text-progress-mark motion-reduce:animate-none",
        )}
      />
      {label}
    </span>
  );
}

/* ── the headline verdict ───────────────────────────────────────────────────
 *
 * ★ THIS IS WHERE §0 IS ENFORCED STRUCTURALLY RATHER THAN BY DISCIPLINE.
 *
 * Brief §3.3: "The `lg` variant ALWAYS renders a caveat line beneath it — SAFE
 * reads 'No confirmed threat found. Not a proof of absence.' plus coverage
 * counts ... The caveat is part of the component, not something a page
 * remembers to add."
 *
 * That last clause is the whole design. A security tool fails in two directions
 * and they are not symmetric: missing a threat is a product failure, but
 * OVERSTATING A CLEAN RESULT is a credibility failure, and credibility is the
 * product. `SAFE` does not mean "this package is safe" — it means "this audit
 * found nothing it could confirm". A page that renders a big green SAFE and
 * forgets the caveat has told a lie the product cannot afford, and "remember to
 * add the caveat" is not a mechanism.
 *
 * So `counts` is REQUIRED. There is no way to render a headline verdict without
 * handing over the coverage it was drawn from, and no way to render SAFE
 * without the caveat appearing. */

export type VerdictHeadlineProps = {
  outcome: Outcome;
  /** Coverage. Required — a verdict with no denominator is the thing §0 forbids. */
  counts: HypothesisCounts;
  /** ERROR only: what went wrong, in the engine's own words. */
  detail?: string;
  /** ERROR only: rendered beside the caveat when a retry is meaningful. */
  action?: ReactNode;
  className?: string;
};

/** The coverage sentence. Always the counts we actually hold — never a
 * fabricated zero, and never a percentage over an unknown denominator. */
function coverage(counts: HypothesisCounts): string {
  if (counts.total === 0) return "No hypotheses were raised for this package.";
  const parts = [
    `${counts.total} hypothes${counts.total === 1 ? "is" : "es"} tested`,
    counts.confirmed > 0 ? `${counts.confirmed} confirmed` : null,
    counts.refuted > 0 ? `${counts.refuted} refuted` : null,
    counts.deferred > 0 ? `${counts.deferred} could not be decided` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

const CAVEAT: Record<Outcome, (counts: HypothesisCounts) => string> = {
  // The §0 sentence, verbatim and unconditional.
  SAFE: () => "No confirmed threat found. Not a proof of absence.",
  DANGEROUS: (counts) =>
    counts.confirmed > 0
      ? `${counts.confirmed} confirmed threat${counts.confirmed === 1 ? "" : "s"}, backed by reproducible evidence.`
      : "Confirmed malicious behaviour, backed by reproducible evidence.",
  // ERROR is a first-class outcome and must never read as "not checked yet".
  ERROR: () => "This audit could not reach a conclusion. Not safe, not dangerous — unknown.",
};

export function VerdictHeadline({
  outcome,
  counts,
  detail,
  action,
  className,
}: VerdictHeadlineProps) {
  const Glyph = OUTCOME_GLYPH[outcome];
  return (
    <div data-verdict-headline={outcome} className={cn("flex flex-col items-start gap-2", className)}>
      {/* `data-verdict` sits on the STAMP, not the wrapper: it is the hook e2e
          asserts the verdict word on, and a wrapper carrying it would match the
          caveat and coverage text too. */}
      <span
        data-verdict={outcome}
        className={cn(
          "inline-flex items-center gap-2 rounded-sm border px-2.5 py-1.5",
          "font-mono text-lg font-medium tracking-wide uppercase",
          OUTCOME_SKIN[outcome],
        )}
      >
        <Glyph aria-hidden="true" strokeWidth={1.5} className="size-icon-lg shrink-0" />
        {outcome}
      </span>
      <p className="text-sm text-text-2">{CAVEAT[outcome](counts)}</p>
      {/* Coverage rides with the verdict on EVERY outcome, not only SAFE: a
          DANGEROUS verdict drawn from two hypotheses is a different claim from
          one drawn from forty, and the reader deserves the denominator either
          way. */}
      <p className="font-mono text-2xs tabular-nums text-text-3">{coverage(counts)}</p>
      {detail ? <p className="font-mono text-2xs text-text-3">{detail}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
