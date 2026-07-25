/** EmptyState — **a successful read that returned nothing.**
 *
 * Fully achromatic by construction (brief §3.4): ringed neutral glyph, one
 * sentence naming what would appear here, at most one primary action. No hue
 * appears anywhere in this component, which is what makes it visually
 * un-confusable with `DegradedState` (hatched, violet). If you find yourself
 * wanting a colour here, the state you actually have is degraded.
 *
 * The `read` prop is the enforcement, not decoration: a `ReadSucceeded` token is
 * obtainable only from `loaded(data)`, so this component cannot be rendered on a
 * failure path. See `load-state.ts` for why that is a type and not a convention.
 *
 * `message` is required and is checked for specificity by review, not by types:
 * "No dependencies audited yet" tells the reader where they are; "No data" does
 * not. Keep the chrome around this (table header, tab counts) — per the GitHub
 * reference in §3.4, preserving the frame preserves the reader's sense of
 * *where* the emptiness is. */

import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";
import type { ReadSucceeded } from "./load-state.ts";

export type EmptyStateProps = {
  /** Proof the read succeeded. From `loaded(data)`; cannot be forged. */
  read: ReadSucceeded;
  /** What would appear here, specifically. Never "No data". */
  message: string;
  /** Optional second line: how to make something appear here. */
  hint?: string;
  /** At most one action. Two actions in an empty state means the copy is
   * doing the work of a decision the page should have already made. */
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
};

export function EmptyState({
  read,
  message,
  hint,
  action,
  icon: Icon = Inbox,
  className,
}: EmptyStateProps) {
  void read; // consumed by the type system, not at runtime
  return (
    <div
      // `status`, not `alert`: an empty result is not urgent and must not
      // interrupt a screen reader mid-sentence.
      role="status"
      data-state="empty"
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-10 items-center justify-center rounded-full",
          // The one ring in the system that IS round: §2.8 reserves
          // `rounded-full` for avatars and count dots, and this glyph ring is
          // neither a status element nor a stamp.
          "border border-border-strong text-text-3",
        )}
      >
        <Icon strokeWidth={1.5} className="size-icon" />
      </span>
      <p className="max-w-[46ch] text-sm text-text-2">{message}</p>
      {hint ? <p className="max-w-[46ch] text-xs text-text-3">{hint}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
