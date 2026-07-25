/** Accordion — Radix `Accordion`. File summaries, evidence sections.
 *
 * The difference from `Collapsible` is not cosmetic and decides which to use: an
 * Accordion is a *set* whose items know about each other. It provides
 * `type="single"` mutual exclusion, roving arrow-key navigation between headers,
 * and the `<h3><button>` header structure that lets a screen reader jump between
 * sections. A row of independent Collapsibles has none of that.
 *
 * So: independent disclosures inside one card → `Collapsible`. A list of peer
 * sections the reader navigates → `Accordion`.
 *
 * `type` is intentionally not defaulted. `single` hides content the reader may
 * want side by side; `multiple` lets a 128-file list expand into an unusable
 * page. That is a per-surface call and a default would make it silently. */

import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export const Accordion = AccordionPrimitive.Root;

export function AccordionItem({ className, ...props }: ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      className={cn("border-b border-border-faint last:border-b-0", className)}
      {...props}
    />
  );
}

export function AccordionTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    // Radix wraps the button in an `<h3>` via `AccordionPrimitive.Header`. Do not
    // drop the Header: without it the buttons are not headings and the section
    // list disappears from a screen reader's document outline.
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        className={cn(
          "group flex flex-1 items-center gap-2 py-2 text-left text-sm font-medium text-text",
          "min-h-row-dense max-md:min-h-tap",
          "transition-colors duration-fast hover:text-accent-text",
          FOCUS_RING,
          className,
        )}
        {...props}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-text-3 transition-transform duration-fast ease-std",
            "group-data-[state=open]:rotate-90 motion-reduce:transition-none",
          )}
        />
        {children}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export function AccordionContent({
  className,
  ...props
}: ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content className={cn("pb-3 pl-5 text-sm text-text-2", className)} {...props} />
  );
}
