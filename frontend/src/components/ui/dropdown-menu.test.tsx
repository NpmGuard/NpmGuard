/**
 * Component: keyboard operability — dropdown-menu.tsx.
 *
 * A row-actions menu that only opens on click is a menu half the users cannot
 * reach. Radix supplies the whole keyboard model; these tests pin that we did not
 * break it by adding a competing handler, and that the two *stateful* item types
 * carry the right roles — `menuitemcheckbox` for column visibility,
 * `menuitemradio` for density. Rendering density as three checkboxes tells a
 * screen-reader user they can pick two, which is a lie about the control.
 *
 * Input classes:
 *  C1  the trigger opens on Enter, Space and ArrowDown (not click-only) and
 *      exposes `aria-expanded` / `aria-haspopup`.
 *  C2  arrow keys move the highlight; the first item is highlighted on
 *      keyboard-open so there is somewhere to go.
 *  C3  Escape closes and returns focus to the trigger.
 *  C4  checkbox items are `menuitemcheckbox` with `aria-checked`, and toggling one
 *      reports the new value.
 *  C5  radio items are `menuitemradio`, with exactly one checked.
 *  C6  Enter on the highlighted item invokes it and closes the menu.
 *  C7  `className` survives the merge on content and item.
 *
 * Blackbox: fireEvent against real nodes, asserting on roles and
 * `data-highlighted` — the attribute Radix moves as the highlight travels, which
 * is why menu rows are the one exception to the focus-ring rule.
 *
 * Three harness facts that each look like a component bug and are not; see the
 * helpers below for the detail. The trigger becomes unqueryable once the modal
 * menu is open (everything outside the portal goes `aria-hidden`), so it is
 * captured before opening. A mouse opens the menu on `pointerdown`, not `click`.
 * And navigation keys must be dispatched at the focused *item*, because that is
 * where the roving-focus handler lives.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu.tsx";

function Harness({
  onReaudit = () => {},
  contentClassName,
  itemClassName,
}: {
  onReaudit?: () => void;
  contentClassName?: string;
  itemClassName?: string;
}) {
  const [columns, setColumns] = useState({ depth: true, audited: false });
  const [density, setDensity] = useState("dense");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost">Row actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className={contentClassName}>
          <DropdownMenuItem className={itemClassName} onSelect={onReaudit}>
            Re-audit
          </DropdownMenuItem>
          <DropdownMenuItem>Open report</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Columns</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={columns.depth}
            onCheckedChange={(next) => setColumns((prev) => ({ ...prev, depth: next === true }))}
          >
            Depth
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={columns.audited}
            onCheckedChange={(next) => setColumns((prev) => ({ ...prev, audited: next === true }))}
          >
            Audited
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Density</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={density} onValueChange={setDensity}>
            <DropdownMenuRadioItem value="dense">Dense</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="regular">Regular</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="comfortable">Comfortable</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span data-testid="density">{density}</span>
    </>
  );
}

const triggerNode = () => screen.getByRole("button", { name: "Row actions" });

/** Open by keyboard and return both nodes, since the trigger is unqueryable once
 * the modal menu is up. */
async function openByKey(key: string) {
  const trigger = triggerNode();
  trigger.focus();
  fireEvent.keyDown(trigger, { key });
  const menu = await screen.findByRole("menu");
  return { trigger, menu };
}

/** Open the way a mouse does. Radix's trigger fires on `pointerdown`, not
 * `click` — deliberately, so the menu is up before the button release. A `click`
 * alone does nothing, which is worth knowing before concluding the menu is
 * broken. */
async function openByPointer() {
  const trigger = triggerNode();
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  const menu = await screen.findByRole("menu");
  return { trigger, menu };
}

/** Radix moves DOM focus across the items (roving tabindex), and the key handler
 * lives on the focused ITEM, not on the menu container — an event fired at the
 * container never reaches it. So navigation keys go to whatever is focused, which
 * is also exactly what a real keyboard does. */
function pressOnFocused(key: string) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
}

const highlighted = (name: string) =>
  waitFor(() => {
    expect(screen.getByRole("menuitem", { name })).toHaveAttribute("data-highlighted");
  });

describe("opening", () => {
  it("C1: the trigger advertises itself as a menu button", () => {
    render(<Harness />);
    expect(triggerNode()).toHaveAttribute("aria-haspopup", "menu");
    expect(triggerNode()).toHaveAttribute("aria-expanded", "false");
  });

  it("C1: Enter opens the menu", async () => {
    render(<Harness />);
    const { trigger, menu } = await openByKey("Enter");
    expect(menu).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("C1: Space opens the menu", async () => {
    render(<Harness />);
    const { menu } = await openByKey(" ");
    expect(menu).toBeInTheDocument();
  });

  it("C1: ArrowDown opens the menu — the keyboard-first path", async () => {
    render(<Harness />);
    const { menu } = await openByKey("ArrowDown");
    expect(menu).toBeInTheDocument();
  });
});

describe("navigating", () => {
  it("C2: opening by keyboard highlights the first item", async () => {
    render(<Harness />);
    await openByKey("Enter");
    await highlighted("Re-audit");
  });

  it("C2: ArrowDown moves the highlight to the next item", async () => {
    render(<Harness />);
    await openByKey("Enter");
    await highlighted("Re-audit");
    pressOnFocused("ArrowDown");
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Open report" })).toHaveAttribute(
        "data-highlighted",
      );
    });
    expect(screen.getByRole("menuitem", { name: "Re-audit" })).not.toHaveAttribute(
      "data-highlighted",
    );
  });

  it("C6: Enter on the highlighted item invokes it and closes the menu", async () => {
    const onReaudit = vi.fn();
    render(<Harness onReaudit={onReaudit} />);
    await openByKey("Enter");
    await highlighted("Re-audit");
    pressOnFocused("Enter");
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(onReaudit).toHaveBeenCalledOnce();
  });

  it("C3: Escape closes and returns focus to the trigger", async () => {
    render(<Harness />);
    const { trigger } = await openByKey("Enter");
    pressOnFocused("Escape");
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    // Focus restoration is the half a hand-rolled menu forgets: without it a
    // keyboard user is dumped at the top of the document on every dismissal.
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});

describe("stateful items", () => {
  it("C4: column toggles are menuitemcheckbox with aria-checked", async () => {
    render(<Harness />);
    await openByPointer();
    expect(screen.getByRole("menuitemcheckbox", { name: "Depth" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemcheckbox", { name: "Audited" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("C4: toggling a column item reports the new value", async () => {
    render(<Harness />);
    await openByPointer();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Audited" }));
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    await openByPointer();
    await waitFor(() => {
      expect(screen.getByRole("menuitemcheckbox", { name: "Audited" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
  });

  it("C5: density is a radio set with exactly one checked", async () => {
    render(<Harness />);
    await openByPointer();
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(3);
    expect(radios.filter((item) => item.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(screen.getByRole("menuitemradio", { name: "Dense" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("C5: choosing another density moves the single checked item", async () => {
    render(<Harness />);
    await openByPointer();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Comfortable" }));
    await waitFor(() => {
      expect(screen.getByTestId("density")).toHaveTextContent("comfortable");
    });
  });
});

describe("className merge", () => {
  it("C7: content and item classNames arrive and win their groups", async () => {
    render(<Harness contentClassName="min-w-[24rem] rounded-none" itemClassName="px-6" />);
    const { menu } = await openByPointer();
    expect(menu).toHaveClass("min-w-[24rem]", "rounded-none");
    expect(menu).not.toHaveClass("rounded-lg");
    expect(menu).not.toHaveClass("min-w-[10rem]");
    const item = screen.getByRole("menuitem", { name: "Re-audit" });
    expect(item).toHaveClass("px-6");
    expect(item).not.toHaveClass("px-2");
  });
});
