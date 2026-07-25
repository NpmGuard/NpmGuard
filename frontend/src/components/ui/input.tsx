/** Input — plain. The text field, and the search field that wraps it.
 *
 * Not in the brief's §3.1 inventory, and that omission had already cost
 * something: `Dashboard`, `RepoDetail` and `Registry` each carried their own
 * copy of the same six utility classes, one of them hoisted into a
 * module-level `SEARCH_INPUT` const and two of them inline. Three copies of a
 * control's boundary is how a design system starts re-deriving itself — the
 * same failure at component scale that R-6 named at sheet scale.
 *
 * `border-border-control`, not `border-border`: §2.2 added the 3:1 control step
 * precisely because an input's boundary is its only affordance, and the
 * decorative hairline measures 1.3:1, which fails WCAG 1.4.11.
 *
 * The `max-md:text-md` is not a nicety. Any input under 16px makes iOS Safari
 * zoom the viewport on focus (§2.7/§2.8) — on `/scan` that means the user's
 * first interaction with the product visibly breaks the layout. `base.css`
 * carries this in its base layer today; it is repeated here so the control is
 * still correct once that sheet is gone. */

import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

export type InputProps = ComponentProps<"input"> & {
  /** Mono for machine-authored content — a package name, a version, a hash.
   * §2.7's one rule: mono means "this is a fact, not prose". */
  mono?: boolean;
};

export function inputClasses({ mono = false }: { mono?: boolean } = {}): string {
  return cn(
    "h-control w-full rounded-md border border-border-control bg-surface",
    "px-2.5 text-sm text-text placeholder:text-text-3",
    "max-md:h-tap max-md:text-md",
    "transition-colors duration-fast ease-std hover:border-border-strong",
    "disabled:pointer-events-none disabled:opacity-50",
    mono && "font-mono",
  );
}

export function Input({ className, mono, type, ...props }: InputProps) {
  return <input type={type ?? "text"} className={cn(inputClasses({ mono }), className)} {...props} />;
}

/** A search field with its magnifier. The glyph is `pointer-events-none` so the
 * whole control stays one click target, and `aria-hidden` because the field's
 * own accessible name already says what it searches — a screen reader
 * announcing "search, search repositories" is the icon leaking into the label.
 *
 * `type="search"` is deliberate: it gives the platform clear-button and the
 * mobile keyboard's Search key for free.
 *
 * `label` is **required**. A bare search box on a page with two of them is
 * unnavigable, and every existing call site already passed one — making it
 * non-optional costs nothing and closes the hole. */
export type SearchInputProps = Omit<ComponentProps<"input">, "type" | "aria-label"> & {
  label: string;
  /** Trailing slot — a count, a clear button, a `Kbd` hint. */
  adornment?: ReactNode;
  wrapperClassName?: string;
};

export function SearchInput({
  className,
  label,
  adornment,
  wrapperClassName,
  ...props
}: SearchInputProps) {
  return (
    <div className={cn("relative min-w-56 flex-1 text-text-3", wrapperClassName)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-icon-sm -translate-y-1/2"
      />
      <input
        type="search"
        aria-label={label}
        className={cn(inputClasses(), "pl-8", adornment ? "pr-16" : "pr-2.5", className)}
        {...props}
      />
      {adornment ? (
        <span className="absolute top-1/2 right-2.5 -translate-y-1/2">{adornment}</span>
      ) : null}
    </div>
  );
}
