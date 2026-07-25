/** Meter — plain, `role="meter"`. Plan/usage, coverage.
 *
 * **Not `Progress`, and the distinction is semantic, not cosmetic** (§3.2). A
 * progressbar measures a task advancing toward completion; a meter measures a
 * value inside a known range. A quota is a meter — it does not "finish", and
 * `role="progressbar"` would tell a screen-reader user that 48 of 50 scans used
 * is 96% *done*, which is the opposite of what it means.
 *
 * The state machine is derived, not passed, so no call site can render a state
 * its numbers do not support — that is the same failure as a synthesized score.
 * See {@link meterState}.
 *
 *   `unknown`    `value === null` — the number could not be read. Hatched, and
 *                deliberately neither empty nor full: an empty bar reads as
 *                "nothing used" and a full one as "exhausted", and both are
 *                confident claims about a number we do not have. This is the
 *                meter's version of §3.4's rule against fabricated zeros.
 *   `unmetered`  `max === null` — no ceiling exists, so no bar is drawn. A
 *                full-looking bar for an unlimited plan is a lie in the other
 *                direction.
 *   `over-limit` uses the `error` violet, not `danger` red. Per §0 rule 3 red is
 *                reserved for claims NpmGuard makes about a package; an exhausted
 *                quota is "we could not check", which is the same *we don't know*
 *                slot as audit ERROR and a failed fetch. Overrule this
 *                deliberately if the product decides a blocked scan is an alarm,
 *                but do not do it by accident.
 *   `near-limit` keeps the accent fill and moves the emphasis to the text, because
 *                the palette has no fourth status hue and inventing one fails the
 *                §2.3 CVD separation check. */

import { cn } from "../../lib/cn.ts";
import { HATCH_NEUTRAL } from "./hatch.ts";

export type MeterState = "normal" | "near-limit" | "over-limit" | "unmetered" | "unknown";

export function meterState(
  value: number | null,
  max: number | null,
  nearLimitAt: number,
): MeterState {
  if (value === null) return "unknown";
  if (max === null) return "unmetered";
  if (max <= 0 || value >= max) return "over-limit";
  return value / max >= nearLimitAt ? "near-limit" : "normal";
}

export type MeterProps = {
  label: string;
  /** `null` = the number could not be read. Never pass `0` to mean "unknown". */
  value: number | null;
  /** `null` = unmetered. Never pass a large sentinel to fake a ceiling. */
  max: number | null;
  /** Fraction of `max` at which `near-limit` begins. */
  nearLimitAt?: number;
  /** The Vanta pattern from §3.2: `"48 of 50 scans used"`. Read out verbatim as
   * the meter's `aria-valuetext`, so the assistive-tech reading matches the
   * visible one instead of being a bare percentage. */
  valueText?: string;
  className?: string;
};

const FILL: Record<MeterState, string> = {
  normal: "bg-accent",
  "near-limit": "bg-accent",
  "over-limit": "bg-error",
  unmetered: "",
  unknown: "",
};

export function Meter({
  label,
  value,
  max,
  nearLimitAt = 0.8,
  valueText,
  className,
}: MeterProps) {
  const state = meterState(value, max, nearLimitAt);
  const fraction =
    value !== null && max !== null && max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;

  return (
    <div data-meter-state={state} className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-text-2">{label}</span>
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            state === "over-limit" ? "text-error-text" : "text-text",
            state === "near-limit" && "text-text",
          )}
        >
          {/* An em-dash, never `0`, when the number is unavailable. */}
          {valueText ?? (value === null ? "—" : max === null ? `${value}` : `${value} / ${max}`)}
        </span>
      </div>

      {state === "unknown" ? (
        // No `role="meter"`: the role's contract requires `aria-valuenow`, and
        // there is no honest value to put there. The bar becomes decoration and
        // the text above carries the fact.
        <div
          aria-hidden="true"
          style={HATCH_NEUTRAL}
          className="h-1.5 w-full rounded-xs border border-border-faint"
        />
      ) : state === "unmetered" ? (
        <p className="text-2xs text-text-3">No limit on this plan</p>
      ) : (
        <div
          role="meter"
          aria-label={label}
          aria-valuenow={value ?? undefined}
          aria-valuemin={0}
          aria-valuemax={max ?? undefined}
          aria-valuetext={valueText}
          className="h-1.5 w-full overflow-hidden rounded-xs bg-progress-track"
        >
          <div
            aria-hidden="true"
            className={cn("h-full origin-left", FILL[state])}
            // `scaleX` rather than `width`: transform-only, per §2.9.
            style={{ transform: `scaleX(${fraction})` }}
          />
        </div>
      )}
    </div>
  );
}
