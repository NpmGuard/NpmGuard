/** Tabs — Radix `Tabs`.
 *
 * `/audit` stream filters, `/package` report sections, `/benchmark` run views.
 * Radix supplies the roving-tabindex, the Arrow/Home/End navigation and the
 * `aria-controls`/`aria-labelledby` pairing between tab and panel.
 *
 * The one domain rule this file enforces (brief §3.1): **a tab whose count is 0
 * renders disabled, not hidden.** Hiding it destroys information — "Errors 0" is
 * a fact the reader wants, and a tab strip that changes shape as counts change
 * makes the surface feel unstable. `count === null` means the count is not known
 * yet and renders no chip at all, which is different again from zero.
 *
 * Radix skips disabled tabs during arrow navigation, so a zero-count tab does
 * not become a keyboard dead end. */

import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      // A hairline rule under the whole strip with the active tab overlapping it
      // is the "document tab" reading Direction A wants — no pill background, no
      // segmented-control tray.
      className={cn("flex items-stretch gap-1 border-b border-border", className)}
      {...props}
    />
  );
}

export type TabsTriggerProps = ComponentProps<typeof TabsPrimitive.Trigger> & {
  /** `number` renders a count chip. `0` also disables the tab. `null`/omitted
   * means "not known yet" and renders nothing — a missing count and a zero
   * count are different facts. */
  count?: number | null;
};

export function TabsTrigger({ className, children, count, disabled, ...props }: TabsTriggerProps) {
  const empty = count === 0;
  return (
    <TabsPrimitive.Trigger
      disabled={disabled ?? empty}
      className={cn(
        "-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2",
        "text-sm font-medium text-text-2 transition-colors duration-fast",
        "min-h-control max-md:min-h-tap",
        "hover:text-text",
        "data-[state=active]:border-accent data-[state=active]:text-text",
        "disabled:pointer-events-none disabled:text-text-3",
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      {children}
      {typeof count === "number" ? (
        <span
          className={cn(
            "rounded-sm bg-sunken px-1 font-mono text-2xs tabular-nums text-text-3",
            // No `rounded-full`: §2.8 keeps round shapes for avatars and nav
            // count dots. A tab count is metadata on a record.
            "border border-border-faint",
          )}
        >
          {count}
        </span>
      ) : null}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn("pt-4", FOCUS_RING, className)}
      {...props}
    />
  );
}
