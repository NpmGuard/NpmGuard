/** Shared outcome/status tone mapping for the panel cluster — the single
 * outcome→tone chokepoint, plus the dep sort rank that depends on it.
 *
 * The domain is the panel `Outcome` (SAFE | ERROR | DANGEROUS, null until
 * concluded) from the generated contract, NOT the audit-core verdict. The two
 * axes stay separate here too: `outcomeTone` maps what we KNOW, and the dep
 * helpers below fold in progress (`jobState`) only where the UI shows progress.
 *
 * The param is typed `Outcome`, never widened to `string`: a widened param
 * silently accepts values the map has no arm for.
 *
 * ── WHY THIS FILE HAS TWO STYLING SUBSTRATES ────────────────────────────────
 *
 * The renderers below (`OutcomePill`, `ProgressPill`) are on the v3 token layer.
 * The two class/var *helpers* (`toneAccent`, `toneDotClass`) are on the legacy
 * `base.css` names, deliberately: their only callers are
 * `features/repos/components/{RepoCard,PortfolioPosture}.tsx`, which are still
 * whole-hog legacy. Handing a legacy card a token-coloured mark puts two palettes
 * inside one 18px-padded warm-paper box, which reads worse than either. They die
 * with those two components; a stamp is self-contained, so the renderers did not
 * have to wait. */

import type { AuditSet, AuditSetItem, Outcome } from "@npmguard/shared";
import type { LucideIcon } from "lucide-react";
import { Circle, CircleCheck, CircleDashed, CircleSlash, LoaderCircle, OctagonAlert } from "lucide-react";
import { cn } from "../../lib/cn.ts";

export type Tone = "safe" | "danger" | "error" | "running" | "unknown";

/** `unknown` is the absence of information (nothing concluded, no scan yet) —
 * never a conclusion. An audit that FAILED is `error`, which is a conclusion. */
export function outcomeTone(outcome: Outcome | null): Tone {
  switch (outcome) {
    case "SAFE":
      return "safe";
    case "DANGEROUS":
      return "danger";
    case "ERROR":
      return "error";
    default:
      return "unknown";
  }
}

/** LEGACY. `--accent` value for `base.css`'s `.card--accent` severity bars.
 * Sole surviving caller is `features/repos/components/RepoCard.tsx`; see the
 * file header for why it was not migrated with the renderers. A v3 surface uses
 * `<Card severity="danger" | "error">` instead, which carries the §2.8 3px rule
 * and deliberately has no `safe` arm. */
export function toneAccent(tone: Tone): string {
  switch (tone) {
    case "safe":
      return "var(--safe)";
    case "danger":
      return "var(--danger)";
    case "error":
      return "var(--error)";
    case "running":
      return "var(--running)";
    default:
      return "var(--tone-paper-accent)";
  }
}

/** Card accent for a repo's last audit set: set progress first (still running),
 * then the outcome over its own items.
 *
 * There is no `failed` arm: the set status domain is `running | done`. Every way
 * a set can go wrong resolves into its rollup, where ERROR is a real, countable
 * outcome. */
export function scanTone(set: AuditSet | null): Tone {
  if (!set) return "unknown";
  if (set.status === "running") return "running";
  return outcomeTone(set.rollup.outcome);
}

/** LEGACY. Status-dot class for a tone; plain paper dot for unknown/pending.
 * Sole surviving caller is `features/repos/components/PortfolioPosture.tsx`,
 * whose legend sits beside a legacy `.rail` in the same card — see the file
 * header. A v3 surface does not use a colour-only mark at all: §2.4 requires
 * glyph + word + colour, in that order of priority, so the state travels on
 * `OutcomePill` / `ProgressPill` and severity reaches a row as a 3px rule. */
export function toneDotClass(tone: Tone): string {
  return tone === "unknown" ? "dot" : `dot dot--${tone}`;
}

/** Severity-first sort rank over the two axes: concluded severity first
 * (DANGEROUS > ERROR), then live progress (running before queued), then SAFE.
 * ERROR outranks a running audit because it needs a human; a running one
 * resolves itself. */
export function depPriority(dep: AuditSetItem): number {
  if (dep.outcome === "DANGEROUS") return 0;
  if (dep.outcome === "ERROR") return 1;
  if (dep.outcome === null) return dep.jobState === "running" ? 2 : 3;
  return 4; // SAFE
}

/** Tone for one dep: its outcome, except that a still-running attempt shows as
 * running rather than as absent information. */
export function depTone(dep: AuditSetItem): Tone {
  if (dep.outcome === null && dep.jobState === "running") return "running";
  return outcomeTone(dep.outcome);
}

/** The 3px left rule a row or card wears for this tone, or `undefined`.
 * `Card`/`TableRow` accept `"danger" | "error"` and nothing else — §0 rule 1
 * makes SAFE the quietest state in the system, and 313 green-ruled rows would
 * drown the three that matter. Centralised here so the two call sites cannot
 * disagree about which tones earn a rule. */
export function toneSeverity(tone: Tone): "danger" | "error" | undefined {
  return tone === "danger" || tone === "error" ? tone : undefined;
}

/* ── stamps ─────────────────────────────────────────────────────────────────
 *
 * Brief §3.3 inventories this as `VerdictStamp` and puts it in the design-system
 * layer. It is NOT in `components/ui/` yet, and this is the panel's local
 * instance rather than a second implementation of a thing that exists — reported
 * as a genuine gap. `Badge` is deliberately not used: its own docblock says a
 * verdict is not a metadata chip, and a coloured badge beside three neutral ones
 * reads as the least important thing on the row rather than the most.
 *
 * Two brief rules are structural here rather than remembered:
 *
 *   §2.4  glyph + word + colour, in that order of priority. Remove all colour
 *         and every state is still readable — that is the stated test, and it is
 *         why the glyph is a required part of the component and not something a
 *         call site adds. Silhouettes are chosen distinct: filled-ish octagon
 *         (the only polygon), closed circle+check, circle+slash ("no signal").
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
 * so the DOM keeps the contract's own casing. */
export function OutcomePill({ outcome, className }: { outcome: Outcome; className?: string }) {
  const Glyph = OUTCOME_GLYPH[outcome];
  return (
    <span data-outcome={outcome} className={cn(STAMP, OUTCOME_SKIN[outcome], className)}>
      <Glyph aria-hidden="true" strokeWidth={1.5} className="size-icon-sm shrink-0" />
      {outcome}
    </span>
  );
}

/** Where a dep sits on the PROGRESS axis, for the cases that have no outcome
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

export function ProgressPill({
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
