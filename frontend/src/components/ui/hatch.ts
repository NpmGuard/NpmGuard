/** The 45° hatch — one texture, one meaning: **there is no signal here.**
 *
 * Design brief §3.4 rule 3 makes this the system's single visual signature for
 * absent information, shared by:
 *   - `DegradedState` (a read that failed)          → `HATCH_ERROR`
 *   - `Meter` in its `unknown` state                → `HATCH_NEUTRAL`
 *   - the pending segment of `SeverityRibbon`       → `HATCH_NEUTRAL`
 *   - an indeterminate `Progress` under reduced motion → `HATCH_NEUTRAL`
 *
 * Why a gradient and not an SVG pattern or an image: it survives greyscale and
 * print (colours differ, texture does not), and `background-image` is one of
 * the few paint channels `forced-colors` does *not* override — so the "no
 * signal" reading holds in Windows high-contrast mode, where a colour-only
 * encoding would collapse into the forced palette.
 *
 * Returned as a style object rather than a utility class because the stroke
 * colour is a token that varies per call site, and a Tailwind arbitrary value
 * containing a `repeating-linear-gradient` is unreadable. */

import type { CSSProperties } from "react";

function hatch(stroke: string, background: string): CSSProperties {
  return {
    backgroundColor: background,
    // Geometry is a token, not a literal: the styles layer owns the stroke and
    // the pitch (§3.4 leaves the geometry open, and 1px on a 6px pitch reads as
    // texture rather than as stripes at the band heights these components use).
    // Tuning it in one place keeps the meter, the ribbon and the degraded body
    // wearing the SAME texture — which is the entire premise of "one texture,
    // one meaning".
    backgroundImage:
      `repeating-linear-gradient(45deg, ${stroke} 0 var(--ng-hatch-stroke), ` +
      `transparent var(--ng-hatch-stroke) var(--ng-hatch-pitch))`,
    // Without this, print stylesheets drop the gradient and a degraded region
    // prints as an empty box — i.e. as an *empty* state. That is the exact
    // confusion §3.4 exists to prevent.
    printColorAdjust: "exact",
    WebkitPrintColorAdjust: "exact",
  } as CSSProperties;
}

/** "We could not conclude" / "this read failed" — the `error` violet slot. */
export const HATCH_ERROR: CSSProperties = hatch(
  "var(--ng-error-border)",
  "var(--ng-error-wash)",
);

/** "Not yet known" on the achromatic progress axis (§2.2). Deliberately not
 * `HATCH_ERROR`: a pending scan has not failed, and giving it the error hue
 * would re-introduce the pending/failed conflation. */
export const HATCH_NEUTRAL: CSSProperties = hatch(
  "var(--ng-progress-hatch)",
  "var(--ng-progress-track)",
);
