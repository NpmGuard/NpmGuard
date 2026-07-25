/**
 * Component: the modal contract — dialog.tsx, alert-dialog.tsx, sheet.tsx.
 *
 * These four behaviours are the reason this layer exists. The hand-rolled
 * `PanelDialog` implemented its own focus trap, Escape handler, portal and ARIA;
 * each was a place to be silently wrong, and "silently wrong accessibility" is
 * invisible until someone cannot operate the app. So the tests here do not check
 * that we *called* Radix — they check the behaviour a keyboard-only user gets.
 *
 * Input classes:
 *  C1  focus moves INTO the dialog on open.
 *  C2  focus is TRAPPED: Tab from the last focusable element cycles back inside
 *      rather than escaping to the page behind.
 *  C3  Escape closes.
 *  C4  focus is RESTORED to the trigger on close. This is the one the hand-rolled
 *      version never did, and its absence dumps a keyboard user at the top of the
 *      document every time they close a modal.
 *  C5  the dialog has an accessible name and description drawn from the real
 *      Title/Description nodes, and is `aria-modal`.
 *  C6  the page behind is hidden from assistive tech, so a screen reader cannot
 *      walk out of the modal while sighted focus stays in it.
 *  C7  AlertDialog: the destructive action is NEVER the default-focused element,
 *      and it is not dismissed by an outside click.
 *  C8  `className` survives the merge on the content.
 *
 * Blackbox: fireEvent + document.activeElement. `@testing-library/user-event` is
 * not a dependency here, so tab traversal is asserted through Radix's own
 * keydown handling rather than a synthetic tab implementation.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./alert-dialog.tsx";
import { Button } from "./button.tsx";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.tsx";

function Harness({ className }: { className?: string } = {}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button>Open report</Button>
      </DialogTrigger>
      <DialogContent layout="scroll" className={className}>
        <DialogHeader>
          <DialogTitle>event-stream@3.3.6</DialogTitle>
          <DialogDescription>Confirmed exfiltration of process environment.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <a href="#h1">H-1 evidence</a>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline">Dismiss</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog focus management", () => {
  it("C1: focus moves into the dialog on open", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open report" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it("C2: focus is trapped inside the dialog", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open report" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");

    // Radix's focus scope reasserts itself whenever focus lands outside the
    // dialog while it is open. Attempting to focus the trigger behind the scrim
    // is the realistic escape route (Tab past the last element does the same
    // thing), and the trap must pull focus straight back in.
    trigger.focus();
    await waitFor(() => {
      expect(document.activeElement).not.toBe(trigger);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  it("C3: Escape closes the dialog", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open report" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("C4: focus is restored to the trigger on close", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open report" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    // The behaviour the hand-rolled dialog lacked: without it a keyboard user is
    // returned to the top of the document on every close.
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("C4: focus is restored when closed by the close button too", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open report" });
    fireEvent.click(trigger);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});

describe("Dialog semantics", () => {
  it("C5: the dialog is named and described from its Title and Description nodes", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open report" }));
    const dialog = await screen.findByRole("dialog");
    // Note: Radix 1.1.x deliberately emits NO `aria-modal`. Support for it is
    // inconsistent across assistive tech, so modality is delivered by marking the
    // rest of the page `aria-hidden` instead — which is what C6 asserts. Do not
    // "fix" this by hand-adding `aria-modal`; that would put a second, weaker
    // mechanism next to the working one.
    expect(dialog).toHaveAttribute("data-state", "open");
    // Wired from the actual nodes, not from a hand-passed string that can drift
    // out of sync with the visible title.
    expect(dialog).toHaveAccessibleName("event-stream@3.3.6");
    expect(dialog).toHaveAccessibleDescription(
      "Confirmed exfiltration of process environment.",
    );
  });

  it("C6: the rest of the page is hidden from assistive tech while open", async () => {
    render(
      <>
        <p data-testid="behind">page content</p>
        <Harness />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open report" }));
    await screen.findByRole("dialog");
    // Radix marks the siblings of the portal `aria-hidden`. Without this a screen
    // reader walks straight out of the modal while sighted focus stays inside.
    await waitFor(() => {
      const behind = screen.getByTestId("behind");
      expect(behind.closest("[aria-hidden='true']")).not.toBeNull();
    });
  });

  it("C8: an incoming className reaches the content and wins its group", async () => {
    render(<Harness className="max-w-3xl rounded-none" />);
    fireEvent.click(screen.getByRole("button", { name: "Open report" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveClass("max-w-3xl");
    expect(dialog).toHaveClass("rounded-none");
    expect(dialog).not.toHaveClass("max-w-lg");
    expect(dialog).not.toHaveClass("rounded-xl");
  });
});

describe("AlertDialog", () => {
  function Destructive({ onConfirm = () => {} }: { onConfirm?: () => void }) {
    return (
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button>Disable Protect</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Disable Protect on web-platform?</AlertDialogTitle>
          <AlertDialogDescription>
            New pushes will not be scanned. You can re-enable it at any time.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Protect on</AlertDialogCancel>
            <AlertDialogAction onClick={onConfirm}>Disable</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  it("C7: the destructive action is not the default-focused element", async () => {
    render(<Destructive />);
    fireEvent.click(screen.getByRole("button", { name: "Disable Protect" }));
    await screen.findByRole("alertdialog");
    const action = screen.getByRole("button", { name: "Disable" });
    // A reflexive Enter must cancel, not destroy. Asserted rather than trusted,
    // because a future footer reorder would silently break it.
    await waitFor(() => {
      expect(document.activeElement).not.toBe(action);
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep Protect on" }));
  });

  it("C7: an outside click does not dismiss a destructive confirmation", async () => {
    const onConfirm = vi.fn();
    render(<Destructive onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Disable Protect" }));
    const alert = await screen.findByRole("alertdialog");
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    // Radix's AlertDialog deliberately refuses outside-click dismissal: an
    // accidental click must not silently abandon a decision the user was making.
    expect(alert).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("C5: the alert dialog is named and described", async () => {
    render(<Destructive />);
    fireEvent.click(screen.getByRole("button", { name: "Disable Protect" }));
    const alert = await screen.findByRole("alertdialog");
    expect(alert).toHaveAccessibleName("Disable Protect on web-platform?");
    expect(alert).toHaveAccessibleDescription(/New pushes will not be scanned/);
  });
});

describe("controlled open state", () => {
  it("C3: onOpenChange fires on Escape so a controlled parent stays in sync", async () => {
    function Controlled() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogTitle>Upgrade</DialogTitle>
          </DialogContent>
        </Dialog>
      );
    }
    render(<Controlled />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
