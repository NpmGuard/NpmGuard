/**
 * Component: the panel dialog adapter — PanelDialog.tsx.
 *
 * `ui/dialog.test.tsx` already proves the primitive's focus management. What this
 * file proves is that the three `features/**` dialogs — which were NOT edited —
 * actually inherit it through the adapter. That is the whole claim of the change:
 * the hand-rolled shell asserted `aria-modal="true"` while trapping no focus,
 * restoring no focus, and hiding nothing from assistive tech, and the fix had to
 * reach three untouched call sites through a preserved signature.
 *
 * Input classes:
 *  P1  the signature still holds — `ariaLabel` becomes the accessible name,
 *      children render verbatim (the callers' legacy `.dialog__*` bodies), and
 *      `wide` widens rather than changing anything else.
 *  P2  Escape calls `onClose`.
 *  P3  a pointer-down outside calls `onClose` — via Radix's dismissable-layer
 *      rather than a backdrop element, with the same observable contract.
 *  P4  focus moves INTO the dialog, and the page behind is hidden from assistive
 *      tech. Neither was true before, and P4 is the reason the file changed.
 *  P5  focus is RESTORED to whatever had it, rather than dumping a keyboard user
 *      at the top of the document on every close.
 *  P6  the adapter renders NO close button of its own — every caller draws one in
 *      its own header, and two offset X's is the visible symptom of an adapter
 *      that forgot its callers.
 *
 * Blackbox: fireEvent + document.activeElement, as in `ui/dialog.test.tsx`.
 * `@testing-library/user-event` is not a dependency here.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PanelDialog } from "./PanelDialog.tsx";

/** A caller shaped like the real ones: a trigger on the page, and a legacy body
 * inside the dialog with its own close button. */
function Harness({
  onClose = () => {},
  wide = false,
}: {
  onClose?: () => void;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = () => {
    setOpen(false);
    onClose();
  };
  return (
    <>
      <p data-testid="behind">page content</p>
      <button type="button" onClick={() => setOpen(true)}>
        Open snapshot
      </button>
      {open && (
        <PanelDialog ariaLabel="Public audit snapshot 12" onClose={close} wide={wide}>
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
  // `focus()` before `click()` deliberately. A real browser focuses a button when
  // you click it; `fireEvent.click` does not, and jsdom therefore leaves
  // `document.activeElement` on `<body>`. That difference is not cosmetic here:
  // the adapter takes no `DialogTrigger` (its callers own their own triggers), so
  // focus restore comes from Radix's FocusScope returning focus to whatever was
  // focused when the scope mounted — which is the browser's behaviour, and which
  // an unfocused synthetic click would silently make untestable.
  trigger.focus();
  fireEvent.click(trigger);
  return screen.findByRole("dialog");
}

describe("PanelDialog — P1 the preserved signature", () => {
  it("P1: ariaLabel is the accessible name and the caller's body renders verbatim", async () => {
    render(<Harness />);
    const dialog = await openDialog();
    // Carried as an `sr-only` `DialogTitle` rather than an `aria-label`, so
    // Radix can wire `aria-labelledby` from a real node. Same name either way,
    // which is what makes the three untouched callers keep working.
    expect(dialog).toHaveAccessibleName("Public audit snapshot 12");
    expect(screen.getByText("acme/widget")).toBeInTheDocument();
    // The legacy body classes survive inside the new shell — the callers still
    // ship them and `base.css` still styles them.
    expect(dialog.querySelector(".dialog__header")).not.toBeNull();
    expect(dialog.querySelector(".dialog__body")).not.toBeNull();
  });

  it("P1: `wide` changes the width and nothing else", async () => {
    const { unmount } = render(<Harness />);
    expect((await openDialog()).className).toMatch(/max-w-xl/);
    unmount();

    render(<Harness wide />);
    const wide = await openDialog();
    expect(wide.className).toMatch(/max-w-4xl/);
    // Still scrollable, which is what reproduces the legacy scrim's behaviour for
    // the long snapshot report rather than clipping it.
    expect(wide.className).toMatch(/overflow-y-auto/);
  });

  it("P6: the adapter draws no close button of its own", async () => {
    render(<Harness />);
    await openDialog();
    // Exactly the caller's own. Radix's built-in would sit on top of it.
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });
});

describe("PanelDialog — P2/P3 the dismissal paths reach onClose", () => {
  it("P2: Escape closes", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = await openDialog();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("P3: a pointer-down outside closes", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await openDialog();
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});

describe("PanelDialog — P4/P5 what the hand-rolled shell never did", () => {
  it("P4: focus moves into the dialog", async () => {
    render(<Harness />);
    const dialog = await openDialog();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  });

  it("P4: focus cannot escape back to the page behind", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open snapshot" });
    const dialog = await openDialog();
    // The realistic escape route a hand-rolled scrim allows outright:
    // it had no focus scope at all, so Tab walked straight onto the page.
    trigger.focus();
    await waitFor(() => {
      expect(document.activeElement).not.toBe(trigger);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it("P4: the page behind is hidden from assistive tech", async () => {
    render(<Harness />);
    await openDialog();
    // This is what a hand-asserted `aria-modal="true"` merely CLAIMS while
    // nothing delivered it: a screen reader could walk out of the modal while
    // sighted focus stayed inside.
    await waitFor(() => {
      expect(screen.getByTestId("behind").closest("[aria-hidden='true']")).not.toBeNull();
    });
  });

  it("P5: focus is restored to the trigger on close", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open snapshot" });
    const dialog = await openDialog();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
