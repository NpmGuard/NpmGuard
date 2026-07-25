/** Modal shell for the panel cluster — now an ADAPTER over the Radix-backed
 * `ui/dialog`, not a modal implementation.
 *
 * What this file used to be is the exact defect the design-system layer exists to
 * fix. It hand-rolled a scrim, an Escape handler and a body-scroll lock, and then
 * asserted `role="dialog" aria-modal="true"` over the result — which is a claim,
 * not a mechanism. What it did NOT do, in any version:
 *
 *   - trap focus. Tab walked straight out of the dialog onto the page behind it.
 *   - restore focus on close. Every close dumped a keyboard user at the top of
 *     the document.
 *   - hide the rest of the page from assistive tech, so a screen reader could
 *     walk out of the modal while sighted focus stayed inside it. That is what
 *     `aria-modal` was promising and nothing was delivering.
 *
 * Radix owns all six of those now, and `ui/dialog.test.tsx` asserts the
 * behaviour rather than the attribute. Note in particular that Radix 1.1.x
 * deliberately emits no `aria-modal` — do not "restore" it; modality comes from
 * the aria-hidden treatment, and a second weaker mechanism beside a working one
 * is worse than none.
 *
 * ── WHY THE SIGNATURE IS UNCHANGED ─────────────────────────────────────────
 *
 * `{ariaLabel, onClose, wide}` is kept verbatim. Three callers live in
 * `features/**` (`UpgradeDialog`, `PublicAuditDialog`, `PublicAuditReportDialog`)
 * and each renders its own legacy `.dialog__header/__body/__footer` body. Holding
 * the seam here is what lets all three inherit real focus management without
 * being edited — which is the whole point of a shared component, and the reason
 * this was worth doing before those three are recomposed.
 *
 * Two consequences of that seam, both temporary and both deliberate:
 *
 *   `showClose={false}` — every caller already renders its own visible close
 *   button inside its header. Radix's built-in one would be a second, offset X.
 *
 *   The body scrolls, rather than `layout="scroll"`'s pinned header/footer. That
 *   variant needs `DialogHeader`/`DialogBody`/`DialogFooter` as the three grid
 *   rows, and the callers supply legacy divs. `max-h`/`overflow-y-auto` on the
 *   content reproduces exactly what the legacy scrim did (it was the scroller,
 *   so the header scrolled away there too) — so this is behaviour preserved, not
 *   behaviour lost. Switch to `layout="scroll"` when the callers are recomposed;
 *   the long snapshot report is the surface that wants it.
 *
 * Rendering inside `<AnimatePresence>` is no longer needed or useful: enter is a
 * `@starting-style` transition on the primitive and exit is instant. The pages
 * mount these conditionally. */

import { useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog.tsx";

interface PanelDialogProps {
  /** The dialog's accessible name. Rendered as an `sr-only` `DialogTitle` —
   * Radix wires `aria-labelledby` from a real node, and warns (correctly) when
   * there is none. Callers also render a visible heading; the two agree because
   * this string is what the old `aria-label` already carried. */
  ariaLabel: string;
  onClose: () => void;
  wide?: boolean;
  children: ReactNode;
}

export function PanelDialog({ ariaLabel, onClose, wide = false, children }: PanelDialogProps) {
  /* ── focus restore: a SHIM, and it belongs in `ui/dialog.tsx` ──────────────
   *
   * Radix's modal Content composes `onCloseAutoFocus` with
   * `event.preventDefault(); context.triggerRef.current?.focus()`
   * (@radix-ui/react-dialog dist/index.mjs:154). `triggerRef` is set only by a
   * `<DialogTrigger>`. None of the panel's dialogs have one — the paywall opens
   * from the store, the snapshot report from page state — so `triggerRef.current`
   * is `null`, the `preventDefault()` also cancels FocusScope's own restore, and
   * focus is left stranded on `<body>`.
   *
   * That is not merely incomplete, it is a REGRESSION against the shell this
   * replaces: the old one never moved focus into the dialog at all, so focus was
   * still sitting on the trigger when it closed. So it is fixed here rather than
   * reported and left.
   *
   * This is parameterisation, not reimplementation — the trap, the portal, the
   * ARIA and the aria-hidden treatment all stay with Radix; only the restore
   * TARGET, which this call pattern cannot supply, is provided. It should move
   * into `ui/dialog.tsx` as a default (`onCloseAutoFocus` falling back to the
   * previously-focused element when there is no trigger), which would fix every
   * future trigger-less caller at once and let this shim be deleted.
   *
   * `useState`'s initialiser, not a `useEffect`: child effects run before parent
   * effects, so by the time an effect here fired, Radix's FocusScope would
   * already have moved focus and the answer would be wrong. */
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
