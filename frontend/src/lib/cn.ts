/** Class-name merge for the whole app — the single `cn`.
 *
 * `clsx` flattens conditionals and arrays; `tailwind-merge` resolves *conflicts*
 * by keeping the last utility in a group. The second half is why every component
 * funnels `className` through `cn()` instead of template-stringing it: a caller
 * passing `p-6` to a component whose default is `p-4` must win, and with plain
 * concatenation both classes survive and CSS source order decides — a coin flip
 * the caller cannot see. That coin flip is what made the old
 * class-name-as-component layer unextendable without `!important`.
 *
 * ── WHY THE THEME EXTENSION BELOW IS NOT OPTIONAL ──────────────────────────
 *
 * `tailwind-merge` groups a class by *validating its value*, not by reading this
 * project's CSS. So it recognises `h-4`, `h-full` and `h-[3px]`, but a custom
 * `--spacing-*` key like `h-control` looks like nothing it knows — and an
 * unrecognised class is passed through with no conflict group at all. The
 * observable failure is silent and exactly backwards from the component's
 * intent:
 *
 *     cn("h-control", "h-control-lg")   // → "h-control h-control-lg"
 *
 * Both land in the stylesheet and the *stylesheet's* order wins, not the
 * caller's. Every override this helper exists to guarantee would quietly stop
 * working for the tokens the design system actually uses.
 *
 * `text-figure` is the sharpest case, because there the class does not merely
 * fail to merge — it merges into the WRONG group. It is a FONT SIZE (§2.7, the
 * /benchmark hero figure), but `figure` is not a t-shirt size, so stock
 * `twMerge` files it under `text-color`: `cn("text-figure", "text-danger-text")`
 * would drop the font size instead of the colour, silently, on the one screen
 * that uses it.
 *
 * The names below therefore mirror the token layer's `@theme inline` mapping,
 * and they are the one place that has to be kept in step with it. Adding a
 * `--spacing-*`, `--text-*`, `--ease-*` or `--shadow-*` key to
 * `styles/tokens.css` means adding it here too; `cn.test.ts` pins each namespace,
 * so a forgotten entry fails a test rather than degrading a layout.
 *
 * Colours and radii deliberately need no entry: `bg-*`/`text-*`/`border-*`
 * colour groups accept any value, and the §2.8 radii reuse Tailwind's own
 * `xs…xl` names.
 *
 * Lives in `lib/` rather than under `components/ui/` (shadcn's default would be
 * `lib/utils.ts`) because pages and feature modules need it too, and importing a
 * general helper out of the vendored primitive directory gets the dependency
 * arrow backwards. There is no `@/` path alias in this project, so imports are
 * relative.
 */

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({
  extend: {
    theme: {
      // §2.8 control and row sizes, which the token layer maps into the
      // `--spacing-*` namespace so one token yields `h-control`, `min-h-tap`,
      // `size-icon`, `gap-icon`, `p-row`. Extending the THEME rather than
      // listing class groups is what makes all five of those work from one
      // entry — a per-group list covers `h-*` and misses `gap-*`/`p-*`.
      spacing: [
        "control-sm",
        "control",
        "control-lg",
        "row-dense",
        "row",
        "row-comfy",
        "topbar",
        "icon-sm",
        "icon",
        "icon-lg",
        "tap",
      ],
      // §2.7's scale. `2xs`…`5xl` already parse as t-shirt sizes; `figure` does
      // not, and without this `text-figure` would be misgrouped as a colour.
      text: ["figure"],
      // §2.9 names three eases, not four. `out`/`in` are Tailwind's own.
      ease: ["std"],
      // §2.6's elevations.
      shadow: ["card", "pop", "modal"],
    },
    // `--duration-*` is not one of tailwind-merge's theme keys, so the named
    // §2.9 durations have to join the group directly. They are the intended API:
    // `duration-enter` over `duration-[var(--ng-dur-enter)]`, and it is also the
    // form that drops to 0ms under reduced motion for free, because the token
    // layer zeroes `--ng-dur-*` under `prefers-reduced-motion`.
    classGroups: {
      duration: [
        "duration-press",
        "duration-fast",
        "duration-base",
        "duration-enter",
        "duration-exit",
        "duration-reveal",
        "duration-crossfade",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
