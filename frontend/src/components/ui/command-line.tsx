/** CommandLine — one copyable shell command in a sunken row.
 *
 * `/cli` had this inline and `/pay` had a near-copy of it built out of a `<kbd>`
 * and a mono span, which is how the same element ends up copyable on one surface
 * and not on the other. §3.1's rule is "everything in mono is copyable", so the
 * copy affordance belongs to the component rather than to whoever remembers it.
 *
 * The command scrolls inside its own box (§2.7): a long `npx …` must not widen
 * the page, and wrapping a shell command mid-token invites a mis-paste.
 *
 * `<kbd>` is deliberately NOT used for the `$`/`npx` prefix. A `kbd` element
 * means a keystroke — a screen reader treats its content as literal keys — and
 * `npx` is a program, not a key. The prompt glyph is `aria-hidden` decoration
 * and the command itself is the content. */

import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import { CopyButton } from "./copy-button.tsx";

export type CommandLineProps = {
  /** The command, verbatim. This exact string is what the copy button places on
   * the clipboard — never a prettified variant of what is shown. */
  command: string;
  /** Shown left of the command. `$` by convention; `aria-hidden`. */
  prompt?: string;
  /** One line beneath, explaining what the command does. */
  note?: ReactNode;
  className?: string;
};

export function CommandLine({ command, prompt = "$", note, className }: CommandLineProps) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-center gap-2.5 rounded-md border border-border bg-sunken py-2.5 pr-2 pl-3 shadow-card">
        <span aria-hidden="true" className="font-mono text-sm text-accent-text select-none">
          {prompt}
        </span>
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap text-text">
          {command}
        </code>
        <CopyButton value={command} label={`copy command ${command}`} className="shrink-0" />
      </div>
      {note ? <span className="text-2xs text-text-3">{note}</span> : null}
    </div>
  );
}
