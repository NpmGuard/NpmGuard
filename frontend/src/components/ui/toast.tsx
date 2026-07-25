/** Toast — `sonner`. Scan started, Protect toggled, SSE reconnected.
 *
 * **Errors do not use toasts.** That is the rule from brief §3.1 and it is the
 * only reason this file has an opinion at all: a toast vanishes, and once it has
 * vanished the page looks confidently complete. A failure that mattered is then
 * invisible — which is `panelStore.refresh()`'s silent-fallback bug wearing a
 * nicer coat. Failures go to a `DegradedState`, which persists, names itself, and
 * offers a retry.
 *
 * So `notify` deliberately exposes no `error` channel. If you find yourself
 * wanting one, the thing you want is a `DegradedState` in the region that failed.
 * The exception is the *reversible* action: an undo affordance is legitimately
 * transient, because after the moment passes there is nothing left to undo.
 *
 * Copy confirmations are also **not** toasts — see `copy-button.tsx`, which swaps
 * a glyph inline. A page-level interruption for a control-level fact appears
 * somewhere the user is not looking.
 *
 * Accessibility comes from sonner: the region is `aria-live="polite"` and never
 * steals focus, so a toast cannot interrupt what someone is typing. */

import { Toaster as SonnerToaster, toast } from "sonner";
import type { ComponentProps } from "react";

/** Mount once, high in the app tree. Styling is passed through sonner's
 * `classNames` slots because its own CSS variables assume a hex palette; ours are
 * per-theme custom properties, so the utilities have to reach the elements. */
export function Toaster({ className, ...props }: ComponentProps<typeof SonnerToaster>) {
  return (
    <SonnerToaster
      // 4s per §3.1. Long enough to read one sentence, short enough not to sit
      // over the content.
      duration={4000}
      position="bottom-right"
      // No theme prop: theming comes from the tokens, which already respond to
      // `prefers-color-scheme` and the `.dark` class. Passing sonner's own theme
      // would give us a second, competing source of truth.
      toastOptions={{
        classNames: {
          toast: "!rounded-lg !border !border-border !bg-raised !text-text !shadow-pop !font-sans",
          title: "!text-sm !font-medium",
          description: "!text-xs !text-text-2",
          actionButton: "!rounded-md !bg-accent !text-accent-on !text-xs",
          cancelButton: "!rounded-md !bg-sunken !text-text-2 !text-xs",
        },
      }}
      className={className}
      {...props}
    />
  );
}

/** The permitted surface. Note the absence of `error` — see the file header. */
export const notify = {
  /** A thing happened. Neutral by design: a confirmation is not an outcome. */
  info: (message: string, description?: string) => toast(message, { description }),
  /** An action succeeded. Still quiet — §0 rule 1 keeps celebration out of the
   * system, and a green toast for "Protect enabled" trains people to read green
   * as "you are safe". */
  done: (message: string, description?: string) => toast(message, { description }),
  /** Reversible action. The undo affordance is the whole justification for this
   * being transient rather than a persistent notice. */
  undoable: (message: string, undo: { label: string; onUndo: () => void }) =>
    toast(message, { action: { label: undo.label, onClick: undo.onUndo } }),
};
