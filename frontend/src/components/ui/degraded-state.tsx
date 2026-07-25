/** DegradedState — **a read that failed.** Three variants by blast radius,
 * per brief §3.4.
 *
 *   `field`   one value is missing        → em-dash + a `?` naming the failure
 *   `region`  a card or section failed    → frame and title survive, body hatched
 *   `surface` the page's primary fetch failed → full-region, request id, escape hatch
 *
 * Three invariants, all three enforced here rather than left to call sites:
 *
 * 1. **It names what failed.** `Failure.what` is a required field. There is no
 *    code path through this file that renders without it.
 * 2. **It is `error` violet, never `danger` red.** A failed fetch is not a
 *    security finding. Red is reserved for claims about packages (§0 rule 3), so
 *    the UI can never cry wolf about its own plumbing. `Button variant="danger"`
 *    must not appear in this file.
 * 3. **It is hatched, not blank.** A blank grey box *is* an empty state, and the
 *    whole point of §3.4 is that these two must be unmistakable. The hatch is
 *    the system's one "no signal" texture — see `hatch.ts`.
 *
 * All three variants also carry `data-state="degraded"`, which is what tests
 * assert on: a test that a failed read did not render as "no results" is only
 * meaningful if the two states are distinguishable from the outside. */

import { AlertOctagon, CircleSlash, RotateCw } from "lucide-react";
import { useId } from "react";
import { Button } from "./button.tsx";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";
import { HATCH_ERROR } from "./hatch.ts";
import type { Failure } from "./load-state.ts";

/** One line of provenance, shown wherever there is room for it. Kept out of the
 * variants so the three of them cannot drift in what they disclose. */
function FailureDetail({ failure }: { failure: Failure }) {
  const parts = [failure.detail, failure.requestId ? `request ${failure.requestId}` : null].filter(
    Boolean,
  );
  return (
    <>
      {parts.length > 0 ? (
        <p className="font-mono text-2xs text-text-3">{parts.join(" · ")}</p>
      ) : null}
      {failure.lastGoodAt ? (
        // Last-good matters more than it looks: it tells the reader whether what
        // they are looking at elsewhere on the page is trustworthy.
        <p className="text-2xs text-text-3">Last good data {failure.lastGoodAt}</p>
      ) : null}
    </>
  );
}

function RetryButton({ failure, size = "sm" }: { failure: Failure; size?: "sm" | "md" }) {
  if (!failure.retry) return null;
  return (
    <Button variant="outline" size={size} onClick={failure.retry}>
      <RotateCw aria-hidden="true" className="size-icon-sm" />
      Retry
    </Button>
  );
}

/* ── field ──────────────────────────────────────────────────────────────── */

/** One value could not be read. Renders an em-dash and a `?` disclosure that
 * names the failed fetch.
 *
 * Never `0`, never a blank cell, never "—" without the affordance: a bare dash
 * is indistinguishable from "this row genuinely has no value", which is the
 * field-scale version of the empty/degraded conflation. */
export function DegradedField({ failure, className }: { failure: Failure; className?: string }) {
  const id = useId();
  const detail = [failure.detail, failure.requestId ? `request ${failure.requestId}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      data-state="degraded"
      data-degraded="field"
      className={cn("inline-flex items-baseline gap-1 font-mono tabular-nums", className)}
    >
      <span aria-hidden="true" className="text-text-3">
        —
      </span>
      {/* `title` alone would be invisible to keyboard and touch. The accessible
          name carries the whole failure, so the information exists even if the
          tooltip never opens. */}
      <button
        type="button"
        aria-describedby={id}
        title={detail || undefined}
        className={cn(
          "inline-flex size-4 items-center justify-center rounded-xs",
          "border border-error-border bg-error-wash text-error-text",
          "text-2xs leading-none",
          FOCUS_RING,
        )}
      >
        <span aria-hidden="true">?</span>
        <span className="sr-only">{`${failure.what} could not be loaded`}</span>
      </button>
      <span id={id} className="sr-only">
        {detail}
      </span>
    </span>
  );
}

/* ── region ─────────────────────────────────────────────────────────────── */

export type DegradedRegionProps = {
  failure: Failure;
  /** The section's own title. Kept because the frame surviving is what tells the
   * reader *which* part of the page is missing. */
  title?: string;
  className?: string;
};

/** A card or section failed. The frame and title survive; the body becomes hatch. */
export function DegradedRegion({ failure, title, className }: DegradedRegionProps) {
  const titleId = useId();
  return (
    <section
      data-state="degraded"
      data-degraded="region"
      // `alert` is correct here and not on `field`: a section vanishing from
      // under the reader is worth interrupting for.
      role="alert"
      aria-labelledby={title ? titleId : undefined}
      className={cn("overflow-hidden rounded-lg border border-error-border", className)}
    >
      {title ? (
        <header className="border-b border-error-border bg-error-wash px-3 py-2">
          <h3 id={titleId} className="text-xs font-medium tracking-wide text-error-text uppercase">
            {title}
          </h3>
        </header>
      ) : null}
      <div style={HATCH_ERROR} className="flex flex-col items-start gap-2 px-3 py-4">
        <p className="flex items-center gap-1.5 text-sm font-medium text-error-text">
          <CircleSlash aria-hidden="true" className="size-icon shrink-0" />
          {`${failure.what} unavailable`}
        </p>
        <FailureDetail failure={failure} />
        <RetryButton failure={failure} />
      </div>
    </section>
  );
}

/* ── surface ────────────────────────────────────────────────────────────── */

export type DegradedSurfaceProps = {
  failure: Failure;
  /** A surface that still works. Offered because "retry" is not always the
   * user's best next move, and a dead end is what makes a failure feel total. */
  escape?: { label: string; href: string };
  className?: string;
};

/** The page's primary fetch failed. There is no partial page to salvage, so this
 * takes the whole region — but it still names the failure, still shows the
 * request id, and still offers a way out. */
export function DegradedSurface({ failure, escape, className }: DegradedSurfaceProps) {
  return (
    <div
      data-state="degraded"
      data-degraded="surface"
      role="alert"
      className={cn(
        "mx-auto flex max-w-[52ch] flex-col items-start gap-3 rounded-xl",
        "border border-error-border p-6",
        className,
      )}
      style={HATCH_ERROR}
    >
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-sm border border-error-border bg-error-wash text-error-text"
      >
        <AlertOctagon strokeWidth={1.5} className="size-icon-lg" />
      </span>
      <h2 className="text-xl font-semibold text-error-text">{`${failure.what} could not be loaded`}</h2>
      {/* Deliberately not "please try again later". The reader is told what we
          tried, so they can tell their own colleagues something true. */}
      <FailureDetail failure={failure} />
      <div className="mt-1 flex items-center gap-2">
        <RetryButton failure={failure} size="md" />
        {escape ? (
          // `asChild` so this stays a real anchor — an escape hatch the user
          // cannot middle-click is a poor escape hatch.
          <Button asChild variant="ghost">
            <a href={escape.href}>{escape.label}</a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
