/** Select — Radix `Select`.
 *
 * Org picker, dataset picker, density in a form context. Radix gives the
 * listbox semantics, typeahead, and — importantly — a real `<select>`-equivalent
 * for form submission via its hidden native input.
 *
 * **Not for the version picker.** Brief §3.1 is explicit: packages have hundreds
 * of versions, so that control is a combobox with a text filter, built on `cmdk`.
 * A `Select` with 400 items is a scroll-hunt. See the report for `cmdk`'s status.
 *
 * `--radix-select-trigger-width` on the content is what keeps the open list the
 * same width as the closed trigger; without it the list sizes to its longest
 * item and the control appears to jump. */

import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING, HIGHLIGHT_ROW } from "./focus.ts";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export function SelectTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "inline-flex items-center justify-between gap-2 rounded-sm border border-border-control",
        "bg-surface px-2 text-text",
        // 16px (`text-md`) below `md`: anything smaller makes iOS Safari zoom the
        // viewport on focus, which is the single most common mobile-form defect
        // (§2.7).
        "h-control text-sm max-md:h-tap max-md:text-md",
        "data-[placeholder]:text-text-3 disabled:pointer-events-none disabled:opacity-50",
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-text-3" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        className={cn(
          "z-50 max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)]",
          "overflow-hidden rounded-lg border border-border bg-raised text-sm text-text shadow-pop",
          "transition-opacity duration-base ease-out starting:opacity-0",
          "motion-reduce:transition-none",
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex h-5 items-center justify-center text-text-3">
          <ChevronUp aria-hidden="true" className="size-3.5" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex h-5 items-center justify-center text-text-3">
          <ChevronDown aria-hidden="true" className="size-3.5" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("px-2 py-1.5 text-2xs font-medium tracking-wide text-text-3 uppercase", className)}
      {...props}
    />
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center rounded-md py-1 pl-7 pr-2 outline-none",
        "min-h-control-sm max-md:min-h-tap",
        "transition-colors duration-fast",
        HIGHLIGHT_ROW,
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="size-3.5" strokeWidth={2} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border-faint", className)} {...props} />
  );
}
