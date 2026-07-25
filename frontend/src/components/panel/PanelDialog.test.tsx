/**
 * Component: the panel dialog adapter — PanelDialog.tsx.
 *
 * `ui/dialog.test.tsx` proves the primitive's focus management; repeating it one
 * wrapper deeper would test Radix twice. What is the ADAPTER's own contract, and
 * can break without a type noticing:
 *  P1  `ariaLabel` still becomes the accessible name. The three `features/**`
 *      dialogs pass it verbatim, so the name has to survive the mechanism the
 *      adapter chooses: Radix wires `aria-labelledby` from a real sr-only Title
 *      node rather than taking an `aria-label`.
 *  P2  both dismissal paths reach the caller's `onClose`. Radix reports dismissal
 *      as `onOpenChange`; translating that to the callers' signature is this
 *      file's job, and a caller whose `onClose` never fires leaves state stuck.
 *  P3  the adapter draws NO close button of its own — every caller renders one in
 *      its own header, and two offset X's is the visible symptom of an adapter
 *      that forgot its callers.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PanelDialog } from "./PanelDialog.tsx";

/** A caller shaped like the real ones: a trigger on the page, and a legacy body
 * inside the dialog with its own close button. */
function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose();
  };
  return (
    <>
          <button type="button" onClick={() => setOpen(true)}>
        Open snapshot
      </button>
      {open && (
        <PanelDialog ariaLabel="Public audit snapshot 12" onClose={close}>
          <div className="dialog__header">
            <h2 className="headline">acme/widget</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
              x
            </button>
          </div>
          <div className="dialog__body">
            <a href="#dep">left-pad@1.3.0</a>
          </div>
        </PanelDialog>
      )}
    </>
  );
}

function openDialog() {
  const trigger = screen.getByRole("button", { name: "Open snapshot" });
  fireEvent.click(trigger);
  return screen.findByRole("dialog");
}

describe("PanelDialog — P1/P3 the preserved signature", () => {
  it("P1: ariaLabel is the accessible name and the caller's body renders verbatim", async () => {
    render(<Harness />);
    const dialog = await openDialog();
    // The old shell passed this as `aria-label`; it is now an `sr-only` Title, so
    // Radix can wire `aria-labelledby` from a real node. Same name either way,
    // which is what makes the three untouched callers keep working.
    expect(dialog).toHaveAccessibleName("Public audit snapshot 12");
    expect(screen.getByText("acme/widget")).toBeInTheDocument();
    // The legacy body classes survive inside the new shell — the callers still
    // ship them and `base.css` still styles them.
    expect(dialog.querySelector(".dialog__header")).not.toBeNull();
    expect(dialog.querySelector(".dialog__body")).not.toBeNull();
  });

  it("P3: the adapter draws no close button of its own", async () => {
    render(<Harness />);
    await openDialog();
    // Exactly the caller's own. Radix's built-in would sit on top of it.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });
});

describe("PanelDialog — P2 the dismissal paths reach onClose", () => {
  it("P2: Escape closes", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = await openDialog();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("P2: a pointer-down outside closes", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await openDialog();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
