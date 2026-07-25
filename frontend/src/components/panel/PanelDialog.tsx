/** Modal shell for the panel cluster — an ADAPTER over the Radix-backed
 * `ui/dialog`, not a modal implementation.
 *
 * A hand-rolled scrim + Escape handler + body-scroll lock with
 * `role="dialog" aria-modal="true"` asserted over it is a claim, not a
 * mechanism: it traps no focus, restores none on close, and hides nothing from
 * assistive tech. Radix owns all three, and `ui/dialog.test.tsx` asserts the
 * BEHAVIOUR rather than the attribute. Note that Radix 1.1.x deliberately emits
 * no `aria-modal` — do not "restore" it; modality comes from the aria-hidden
 * treatment, and a second weaker mechanism beside a working one is worse than
 * none.
 *
 * ── WHY THE SIGNATURE IS `{ariaLabel, onClose, wide}` ───────────────────────
 *
 * Three callers in `features/**` (`UpgradeDialog`, `PublicAuditDialog`,
 * `PublicAuditReportDialog`) each render their own legacy
 * `.dialog__header/__body/__footer` body. Holding the seam here is what lets all
 * three inherit real focus management without being edited. Two consequences,
 * both lasting only until those callers are recomposed:
 *
 *   `showClose={false}` — every caller already renders its own visible close
 *   button inside its header. Radix's built-in one would be a second, offset X.
 *
 *   The body scrolls, rather than `layout="scroll"`'s pinned header/footer, which
 *   needs `DialogHeader`/`DialogBody`/`DialogFooter` as its three grid rows while
 *   the callers supply legacy divs. The long snapshot report is the surface that
 *   wants the pinned variant.
 *
 * Not rendered inside `<AnimatePresence>`: enter is a `@starting-style`
 * transition on the primitive and exit is instant. The pages mount these
 * conditionally. */

import { useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.tsx";

interface PanelDialogProps {
  /** The dialog's accessible name. Rendered as an `sr-only` `DialogTitle` —
   * Radix wires `aria-labelledby` from a real node, and warns (correctly) when
   * there is none. Callers also render a visible heading saying the same thing. */
  ariaLabel: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}

export function PanelDialog({ ariaLabel, onClose, wide = false, children }: PanelDialogProps) {
  /* ── focus restore: a SHIM that belongs in `ui/dialog.tsx` ─────────────────
   *
   * Radix's modal Content composes `onCloseAutoFocus` with
   * `event.preventDefault(); context.triggerRef.current?.focus()`, and
   * `triggerRef` is set only by a `<DialogTrigger>`. None of the panel's dialogs
   * have one — the paywall opens from the store, the snapshot report from page
   * state — so `triggerRef.current` is `null`, the `preventDefault()` also
   * cancels FocusScope's own restore, and focus is stranded on `<body>`.
   *
   * Parameterisation, not reimplementation: the trap, the portal, the ARIA and
   * the aria-hidden treatment all stay with Radix; only the restore TARGET, which
   * this call pattern cannot supply, is provided here. It belongs in
   * `ui/dialog.tsx` as a default (`onCloseAutoFocus` falling back to the
   * previously-focused element when there is no trigger), which would cover every
   * trigger-less caller and let this shim go.
   *
   * `useState`'s initialiser, not a `useEffect`: child effects run before parent
   * effects, so an effect here would read the answer after Radix's FocusScope has
   * already moved focus. */
  const [restoreTo] = useState<HTMLElement | null>(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

  return (
    // Always open: the caller controls presence by mounting. `onOpenChange`
    // covers Escape and pointer-outside alike, so both exits are one path.
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showClose={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          // `isConnected`, because the trigger is sometimes removed by the very
          // action that opened the dialog — focusing a detached node silently
          // moves focus to `<body>`, which is the bug this is fixing.
          if (restoreTo?.isConnected) restoreTo.focus();
        }}
        // 560 / 860px are the legacy widths, restated on the token scale:
        // `max-w-xl` is 576px and `max-w-4xl` is 896px.
        className={wide ? "max-h-[85vh] max-w-4xl overflow-y-auto" : "max-h-[85vh] max-w-xl overflow-y-auto"}
      >
        <DialogTitle className="sr-only">{ariaLabel}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
