/** StatTile — plain. Bench metrics, cost/latency, usage.
 *
 * Hairline-divided strip; value in mono tabular, label in sans, **and a one-line
 * definition of what the metric means** (§3.2, the Cohere reference). The
 * definition is a required prop, not an optional one, and that is the point of
 * the component: an unexplained number in a security product is an invitation to
 * misread it, and "Accuracy: 94%" means nothing without "correct predictions
 * across all predictions made".
 *
 * The two no-data channels are separate types, which is the §3.4 distinction at
 * field scale:
 *
 *   `value: null`   the read succeeded and there is genuinely nothing to show —
 *                   renders an em-dash. **Never `0`.** A fabricated zero is a
 *                   measurement that was never taken, presented as one that was.
 *   `failure: {…}`  the read failed — renders `DegradedField`, which shows the
 *                   dash *plus* an affordance naming the failed fetch.
 *
 * They are mutually exclusive in the prop type (`failure?: never` on one arm), so
 * a tile cannot claim both, and a caller holding a `Failure` cannot pass it as a
 * value. */

import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { DegradedField } from "./degraded-state.tsx";
import type { Failure } from "./load-state.ts";

type StatTileBase = {
  label: string;
  /** One line, plain language: what this number counts. Required. */
  definition: string;
  /** Rendered after the value in `text-2` — `%`, `ms`, `req/s`. */
  unit?: string;
  className?: string;
};

export type StatTileProps = StatTileBase &
  (
    | { value: string | number | null; failure?: never }
    | { value?: never; failure: Failure }
  );

export function StatTile({ label, definition, unit, value, failure, className }: StatTileProps) {
  return (
    <div className={cn("flex flex-col gap-1 bg-surface px-4 py-3", className)}>
      <span className="text-xs font-medium text-text-2">{label}</span>
      <span className="flex items-baseline gap-1">
        {failure ? (
          <DegradedField failure={failure} className="text-2xl" />
        ) : (
          <>
            <span className="font-mono text-2xl tabular-nums leading-none text-text">
              {value === null || value === undefined ? "—" : value}
            </span>
            {unit && value !== null && value !== undefined ? (
              <span className="font-mono text-sm text-text-2">{unit}</span>
            ) : null}
          </>
        )}
      </span>
      <span className="text-2xs leading-snug text-text-3">{definition}</span>
    </div>
  );
}

/** The strip. Hairline dividers between tiles rather than boxes around them — the
 * n8n pattern from §3.2, and the reason the tiles themselves have no border. */
export function StatTileStrip({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        // The hairlines are the container's background showing through a 1px grid
        // gap, not borders on the tiles. Deliberate: `divide-x`/`divide-y` are
        // ordered by child index, not by grid position, so on a wrapping 2-column
        // grid they draw rules in the wrong places. A gap reveals exactly the
        // grid lines that exist, at every breakpoint, with no trailing rule.
        "grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border-faint",
        "sm:grid-cols-2 lg:grid-cols-4",
        className,
      )}
      {...props}
    />
  );
}
