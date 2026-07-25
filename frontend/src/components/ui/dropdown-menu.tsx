/** DropdownMenu — Radix `DropdownMenu`.
 *
 * Row actions, column visibility, density, org switcher. The column-visibility
 * and density cases are why `CheckboxItem` and `RadioItem` are vendored here and
 * not left to the call site: those are the two item types that carry state, and
 * `role="menuitemcheckbox"` / `role="menuitemradio"` plus `aria-checked` are
 * exactly the wiring a hand-rolled menu forgets.
 *
 * Keyboard behaviour is Radix's, in full and unmodified: Enter/Space to open,
 * Arrow keys to move (with typeahead), Home/End, Escape to close and restore
 * focus to the trigger, Tab to close and move on. Do not add key handlers here —
 * every one of those behaviours already exists, and a competing handler is how
 * you get a menu that swallows Escape.
 *
 * Item highlight uses `data-[highlighted]`, not `:focus-visible`. See
 * `focus.ts`: DOM focus stays on the menu content while the highlight moves, so
 * a focus ring on an item would never render. */

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";
import { HIGHLIGHT_ROW } from "./focus.ts";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;

const SURFACE = cn(
  "z-50 min-w-[10rem] overflow-hidden rounded-lg border border-border bg-raised p-1",
  "text-sm text-text shadow-pop",
  "transition-opacity duration-base ease-out starting:opacity-0 motion-reduce:transition-none",
);

/** Rows are `--h-control-sm` tall on pointer devices and relax to the 44px tap
 * minimum below `md` (§2.8). Unlike `Button` this grows the visual box rather
 * than a pseudo-element, because menu rows are full-width and their hit area is
 * their box — there is nothing to overflow into. */
const ITEM = cn(
  "relative flex cursor-default select-none items-center gap-2 rounded-md px-2",
  "min-h-control-sm max-md:min-h-tap",
  "outline-none transition-colors duration-fast",
  HIGHLIGHT_ROW,
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
);

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        // Radix measures the trigger and available space and exposes them as CSS
        // vars; capping the height here is what keeps a long org list from
        // running off-screen with no way to reach the bottom items.
        className={cn(SURFACE, "max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return <DropdownMenuPrimitive.Item className={cn(ITEM, className)} {...props} />;
}

/** Column-visibility toggles. `onCheckedChange` is the state channel; the
 * indicator is presentational and `aria-checked` comes from Radix. */
export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem className={cn(ITEM, "pl-7", className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="size-3.5" strokeWidth={2} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

/** Density choice. Radio semantics matter: "Dense / Regular / Comfortable" is a
 * single-choice set, and rendering it as three checkboxes tells a screen-reader
 * user they can pick two. */
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem className={cn(ITEM, "pl-7", className)} {...props}>
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle aria-hidden="true" className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn("px-2 py-1.5 text-2xs font-medium tracking-wide text-text-3 uppercase", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border-faint", className)}
      {...props}
    />
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(ITEM, "data-[state=open]:bg-accent-wash", className)}
      {...props}
    >
      {children}
      <ChevronRight aria-hidden="true" className="ml-auto size-3.5 text-text-3" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent className={cn(SURFACE, className)} {...props} />
    </DropdownMenuPrimitive.Portal>
  );
}

/** Shortcut hint on a menu row. `aria-hidden` because the row's accessible name
 * should be the action, not "Copy id Ctrl K" — the shortcut is affordance, and
 * screen-reader users get it from the application's shortcut help. */
export function DropdownMenuShortcut({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn("ml-auto font-mono text-2xs tracking-widest text-text-3", className)}
      {...props}
    />
  );
}
