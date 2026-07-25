/** CopyButton — plain. Package name, audit id, install command, tx hash.
 *
 * "Everything in mono is copyable" (§3.1), and success is an **inline glyph swap,
 * not a toast** — a toast for a copy confirmation is a page-level interruption for
 * a control-level fact, and it appears somewhere the user is not looking.
 *
 * Three things here are not obvious:
 *
 * 1. The glyph swap is silent to a screen reader; the `aria-live` region carries
 *    the confirmation. Without it, a non-sighted user has no way to know the copy
 *    worked, and "did that work?" is the entire reason this control gives feedback.
 * 2. Clipboard writes fail for real — insecure origin, denied permission, no
 *    `navigator.clipboard` at all. That failure is surfaced inline in the `error`
 *    slot rather than swallowed. A copy button that silently does nothing is worse
 *    than one that is absent, because the user pastes stale content.
 * 3. The timer is cleared on unmount. A `setTimeout` calling `setState` on an
 *    unmounted row is a warning in dev and a leak in a virtualized table that
 *    mounts and unmounts hundreds of rows.
 *
 * `aria-label` is required: an icon-only button with no name is invisible to
 * assistive tech, and "Copy" alone is ambiguous on a page with six of them. Say
 * what is copied — "Copy audit id". */

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/cn.ts";
import { FOCUS_RING } from "./focus.ts";

export type CopyButtonProps = {
  /** The text placed on the clipboard. */
  value: string;
  /** Accessible name. Required — say what is copied, not just "Copy". */
  label: string;
  className?: string;
};

type CopyStatus = "idle" | "copied" | "failed";

export function CopyButton({ value, label, className }: CopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
    } catch {
      // Named, not swallowed — see note 2 in the file header.
      setStatus("failed");
    }
    timer.current = setTimeout(() => setStatus("idle"), 1600);
  }

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={copy}
        aria-label={label}
        data-status={status}
        className={cn(
          "inline-flex size-6 items-center justify-center rounded-sm text-text-3",
          "transition-colors duration-fast hover:bg-sunken hover:text-text",
          status === "copied" && "text-safe-text",
          status === "failed" && "text-error-text",
          FOCUS_RING,
          className,
        )}
      >
        {status === "copied" ? (
          <Check aria-hidden="true" className="size-3.5" strokeWidth={2} />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" strokeWidth={1.5} />
        )}
      </button>
      {/* Polite, so it never interrupts; always present, so the live region is
          already in the accessibility tree when the text arrives. A live region
          inserted at the same moment as its content is usually not announced. */}
      <span aria-live="polite" className="sr-only">
        {status === "copied" ? "Copied" : status === "failed" ? "Could not copy" : ""}
      </span>
      {status === "failed" ? (
        <span className="text-2xs text-error-text">Could not copy</span>
      ) : null}
    </span>
  );
}
