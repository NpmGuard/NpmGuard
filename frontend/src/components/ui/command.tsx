/** Command — `cmdk`. `⌘K` navigation, and the combobox behind the version picker.
 *
 * Keyboard-first navigation is what Direction A keeps from Direction C (§1), so
 * this is not a nice-to-have: it is the one place the "Proof Terminal" instinct
 * survives into the record aesthetic.
 *
 * `cmdk` and not Radix: Radix has no combobox primitive (`Select` is a listbox
 * over a fixed set — see `select.tsx`), and the version picker needs a *filtered*
 * list because packages have hundreds of versions. `cmdk` supplies the
 * `role="combobox"`/`role="listbox"`/`aria-activedescendant` wiring, the fuzzy
 * scoring, and the arrow/Enter handling.
 *
 * `CommandDialog` composes our `Dialog`, so the palette inherits the same real
 * focus trap and focus restore as every other modal rather than having its own.
 *
 * One thing to be careful with: `CommandEmpty` is cmdk's "nothing matched your
 * filter" state, which is **not** the §3.4 `EmptyState` — the reader typed
 * something that matched nothing, a fact about their query, not about the data.
 * It is also not `DegradedState`. Do not substitute either. */

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { Dialog, DialogContent, DialogTitle } from "./dialog.tsx";
import { HIGHLIGHT_ROW } from "./focus.ts";

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn("flex w-full flex-col overflow-hidden rounded-lg bg-raised text-text", className)}
      {...props}
    />
  );
}

export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3">
      <Search aria-hidden="true" className="size-3.5 shrink-0 text-text-3" />
      <CommandPrimitive.Input
        className={cn(
          "h-control-lg w-full bg-transparent font-mono text-text outline-none",
          // 16px on mobile, or iOS Safari zooms the viewport on focus (§2.7).
          "text-sm placeholder:text-text-3 max-md:text-md",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn("max-h-[min(24rem,60vh)] overflow-y-auto overflow-x-hidden p-1", className)}
      {...props}
    />
  );
}

/** "Nothing matched your filter" — see the caveat in the file header. */
export function CommandEmpty({ className, ...props }: ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className={cn("px-3 py-6 text-center text-sm text-text-3", className)}
      {...props}
    />
  );
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "overflow-hidden p-1 text-text",
        "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5",
        "[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium",
        "[&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text-3",
        "[&_[cmdk-group-heading]]:uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 text-sm",
        "min-h-control-sm max-md:min-h-tap",
        "outline-none transition-colors duration-fast",
        // cmdk marks the active row with `data-selected`, Radix menus use
        // `data-highlighted`. Both are here so a reader moving between the two
        // files does not conclude one of them is broken.
        "data-[selected=true]:bg-accent-wash data-[selected=true]:text-accent-text",
        HIGHLIGHT_ROW,
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-border-faint", className)} {...props} />
  );
}

export type CommandDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name for the modal. Visually hidden — the input's placeholder is
   * the visible affordance — but a modal with no name is unidentifiable to a
   * screen reader, so this is required rather than defaulted. */
  title: string;
  children: ReactNode;
};

export function CommandDialog({ open, onOpenChange, title, children }: CommandDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false} className="max-w-xl p-0">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <Command>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}
