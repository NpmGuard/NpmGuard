/** The one focus treatment, per design brief §2.8: "One ring, everywhere, no
 * exceptions."
 *
 * `--ng-focus-ring` is a two-layer box-shadow (2px canvas + 2px accent) so the
 * ring stays legible when the focused element sits on a wash or on a filled
 * mark. It is applied as an arbitrary *property* (`[box-shadow:…]`) rather than
 * `shadow-[…]` because a bare `var()` is ambiguous to Tailwind's shadow parser —
 * it may be read as a shadow *color* — and `[box-shadow:…]` has no ambiguity.
 * (Raw `var()` reads the `--ng-` primitive, never the `--color-*`/`@theme
 * inline` key: those are substituted into utilities at build time and are
 * deliberately never emitted as custom properties.)
 *
 * The styles layer also applies this ring globally at `:focus-visible`. Carrying
 * it here as well is not redundancy for its own sake — a Tailwind `shadow-*`
 * utility sets `box-shadow` and would otherwise silently defeat the global rule
 * depending on layer order, and Radix portals content outside the `.ng-root`
 * subtree the higher-specificity half of that rule scopes to. Where a component
 * needs BOTH its own elevation and the ring, compose them explicitly rather than
 * letting one win by accident (see `Card`).
 *
 * `:focus-visible` only: mouse users never see it, keyboard users always do.
 * The `forced-colors` outline is the fallback for Windows high-contrast mode,
 * where author box-shadows are dropped and a focus ring would otherwise vanish.
 *
 * Never remove this from a control. If a control looks wrong with a ring, the
 * control's padding is wrong, not the ring. */
export const FOCUS_RING =
  "outline-none focus-visible:[box-shadow:var(--ng-focus-ring)] forced-colors:focus-visible:outline-2";

/** Menu/listbox rows are the exception, and not by choice: Radix keeps DOM
 * focus on the collection root and moves a `data-highlighted` attribute across
 * the items (that is how `aria-activedescendant`-style navigation works), so
 * `:focus-visible` never fires on the row. The row therefore gets a wash, and
 * the *ring* stays on the trigger. Do not "fix" a menu item by adding
 * FOCUS_RING to it — it will simply never appear. */
export const HIGHLIGHT_ROW =
  "data-[highlighted]:bg-accent-wash data-[highlighted]:text-accent-text";
