/** RadioGroup — Radix `RadioGroup`. Density choice, and any other one-of-N.
 *
 * The reason not to hand-roll: a radio group is a *single* tab stop with arrow
 * keys moving the selection inside it (roving tabindex). Native radios get this
 * from the browser only when they share a `name` and live in the same form;
 * div-based ones get it from nowhere. Radix implements it properly, including
 * wrap-around and skipping disabled items. */

import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { Circle } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export function RadioGroup({ className, ...props }: ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn("flex flex-col gap-2", className)} {...props} />;
}

export function RadioGroupItem({
  className,
  ...props
}: ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        // The one place `rounded-full` is right on a control: a radio that is not
        // round is a checkbox, and the shape *is* the affordance. §2.8's
        // no-round rule is about status elements, not form controls.
        "relative inline-flex size-4 shrink-0 items-center justify-center rounded-full border",
        "border-border-control bg-surface text-accent",
        "transition-colors duration-fast",
        "data-[state=checked]:border-accent",
        "disabled:pointer-events-none disabled:opacity-50",
        "max-md:before:absolute max-md:before:left-1/2 max-md:before:top-1/2",
        "max-md:before:size-tap max-md:before:-translate-x-1/2 max-md:before:-translate-y-1/2",
        "max-md:before:content-['']",
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
        <Circle aria-hidden="true" className="size-2 fill-current" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}
