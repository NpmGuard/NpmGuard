/**
 * Test scaffolding for the "renders in both themes" class. Not a test file
 * (vitest collects only `*.test.*`) and not imported by app code, so it never
 * reaches a bundle — same arrangement as `lib/test-harness.tsx`.
 *
 * It lives here rather than in `lib/` because it is the panel cluster's check and
 * both panel page tests need it; duplicating it in two files is how the two
 * copies eventually disagree about what counts as a hardcoded colour.
 *
 * WHY THIS IS THE ASSERTION. jsdom loads no Tailwind, so "render it dark and
 * compare the pixels" is not available and would be the wrong test anyway. The
 * token layer's actual claim (§2.1) is narrower and fully checkable: `@theme
 * inline` makes every utility reference `var(--ng-…)` instead of copying a value,
 * so ONE class serves both themes and a `.dark` stamped on a subtree works too.
 * That claim holds exactly as long as no colour reaches the DOM by another route
 * — which in practice means an inline `style`, the one place a component can put
 * a literal past the token layer without Tailwind noticing. Design brief §6's
 * first checklist item is "no raw hex outside the token block"; this is that item
 * as a build outcome instead of a review habit.
 */

import { expect } from "vitest";

/** `#abc`, `#aabbcc`, `#aabbccdd`, `rgb(…)`, `rgba(…)`, `hsl(…)`, `oklch(…)`. */
const LITERAL_COLOUR = /(#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|color-mix)\s*\()/i;

/**
 * Fails if any element currently in the document carries a literal colour in its
 * inline `style`.
 *
 * The legitimate inline styles in this system are geometry (`flex-basis`,
 * `min-width`, `transform`) and the 45° hatch — and the hatch is built from
 * `var(--ng-error-border)` / `var(--ng-progress-hatch)` precisely so it flips with
 * the theme. A literal here means a component decided a colour at author time,
 * which is a component that renders correctly in exactly one theme.
 */
export function expectNoHardcodedColour(): void {
  const offenders = [...document.querySelectorAll<HTMLElement>("[style]")]
    .map((node) => ({ node, style: node.getAttribute("style") ?? "" }))
    .filter(({ style }) => LITERAL_COLOUR.test(style));

  expect(
    offenders.map(({ node, style }) => `<${node.tagName.toLowerCase()}> style="${style}"`),
    "inline styles must carry no literal colour — every colour goes through a token",
  ).toStrictEqual([]);
}
