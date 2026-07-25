/** Checkbox — Radix `Checkbox`. Bulk row selection.
 *
 * Radix carries the tri-state (`checked | unchecked | "indeterminate"`) with the
 * correct `aria-checked="mixed"`, which is the reason to use it: a
 * select-all-header checkbox over a partially selected table is genuinely mixed,
 * and a hand-rolled version almost always renders that as unchecked — telling
 * the user nothing is selected while rows are.
 *
 * `border-border-control` and not `border-border`: an unchecked box's boundary is
 * its only affordance, so it needs the 3:1 control step (§2.2). */

import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export function Checkbox({ className, ...props }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer relative inline-flex size-4 shrink-0 items-center justify-center rounded-xs border",
        "border-border-control bg-surface text-accent-on",
        "transition-colors duration-fast",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
        "disabled:pointer-events-none disabled:opacity-50",
        // 44px hit area below `md` (§3.1) without changing the 16px visual box.
        "max-md:before:absolute max-md:before:left-1/2 max-md:before:top-1/2",
        "max-md:before:size-tap max-md:before:-translate-x-1/2 max-md:before:-translate-y-1/2",
        "max-md:before:content-['']",
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {props.checked === "indeterminate" ? (
          <Minus aria-hidden="true" className="size-3" strokeWidth={3} />
        ) : (
          <Check aria-hidden="true" className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
