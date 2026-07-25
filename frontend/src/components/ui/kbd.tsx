/** Kbd — plain. Shortcut hints.
 *
 * Mono, `--text-2xs`, sunken surface (§3.1). Real `<kbd>` element, because that
 * is what it is and because a screen reader treats it as literal text rather than
 * prose — "Ctrl" is not a word.
 *
 * The `keys` form renders a chord with separators that are `aria-hidden`, so the
 * accessible text is "Ctrl K" rather than "Ctrl plus K". */

import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.ts";

const KEY_CAP =
  "inline-flex min-w-[1.25rem] items-center justify-center rounded-xs border border-border " +
  "bg-sunken px-1 py-0.5 font-mono text-2xs leading-none text-text-2";

export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return <kbd className={cn(KEY_CAP, className)} {...props} />;
}

/** A chord: `<KbdChord keys={["⌘", "K"]} />`. */
export function KbdChord({ keys, className }: { keys: readonly string[]; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)}>
      {keys.map((key, index) => (
        <span key={`${key}-${index}`} className="inline-flex items-center gap-0.5">
          {index > 0 ? (
            <span aria-hidden="true" className="text-2xs text-text-3">
              +
            </span>
          ) : null}
          <Kbd>{key}</Kbd>
        </span>
      ))}
    </span>
  );
}
