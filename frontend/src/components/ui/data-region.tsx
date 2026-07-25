/** DataRegion — the one place a remote read turns into pixels.
 *
 * This is not a convenience wrapper. It is the chokepoint that makes the four
 * states of a read (`loading` / `failed` / `ok+empty` / `ok+data`) mutually
 * exclusive at runtime, matching the way `LoadState` makes them mutually
 * exclusive at compile time. Route every dynamic region through it and the
 * dashboard's known bug class — confident-looking UI over partial data — has no
 * code path left to travel on.
 *
 * The exhaustive switch is the point. `children` is a function of the *narrowed*
 * data, so a caller cannot render the success branch while holding a failure:
 * there is no `data` in scope on that path.
 *
 * Why `failed` is checked before emptiness rather than after: order is the
 * historical bug. `catch { setItems([]) }` then `items.length === 0 ? <Empty/>`
 * is precisely the sequence that turned "this code cannot read this engine's
 * reports" into "no runs yet". Here `failed` cannot reach the empty branch,
 * because the empty branch is inside `case "ok"`. */

import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { DegradedRegion, DegradedSurface } from "./degraded-state.tsx";
import { EmptyState } from "./empty-state.tsx";
import { isEmptyValue, type LoadState } from "./load-state.ts";

export type DataRegionProps<T> = {
  state: LoadState<T>;
  /** Section title. Survives into the degraded state, so the reader can tell
   * *which* region is missing (brief §3.4, the GitHub reference in §3.1). */
  title?: string;
  /** `region` (default) keeps the page around the failure; `surface` is for a
   * page's primary fetch, where there is no partial page worth salvaging. */
  blastRadius?: "region" | "surface";
  /** Shown while loading. A skeleton belongs here only when the final
   * dimensions are known; otherwise pass nothing and get an `aria-busy` region
   * with no visual placeholder, which is honest. */
  loading?: ReactNode;
  /** Copy for the empty case. Required, because "what would appear here" is
   * always knowable at the call site and never knowable here. */
  empty: { message: string; hint?: string; action?: ReactNode };
  /** Defaults to arrays-by-length / maps-by-size / nullish. Override for shapes
   * where emptiness means something domain-specific. */
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
  className?: string;
};

export function DataRegion<T>({
  state,
  title,
  blastRadius = "region",
  loading,
  empty,
  isEmpty = isEmptyValue,
  children,
  className,
}: DataRegionProps<T>) {
  switch (state.status) {
    case "loading":
      return (
        <div aria-busy="true" data-state="loading" className={cn(className)}>
          {/* `sr-only` text rather than `role="status"` on the skeleton itself:
              the wait must be announced once, not re-announced per placeholder. */}
          <span className="sr-only">{title ? `Loading ${title}` : "Loading"}</span>
          {loading}
        </div>
      );

    case "failed":
      return blastRadius === "surface" ? (
        <DegradedSurface failure={state.failure} className={className} />
      ) : (
        <DegradedRegion failure={state.failure} title={title} className={className} />
      );

    case "ok":
      return isEmpty(state.data) ? (
        <EmptyState
          // The success token comes from the narrowed state — it is literally
          // impossible to reach this line without one.
          read={state.read}
          message={empty.message}
          hint={empty.hint}
          action={empty.action}
          className={className}
        />
      ) : (
        <div data-state="ok" className={cn(className)}>
          {children(state.data)}
        </div>
      );
  }
}
