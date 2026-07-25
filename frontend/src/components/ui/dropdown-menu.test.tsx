/**
 * Component: dropdown-menu.tsx — the parts that are OURS.
 *
 * Radix owns the keyboard model, and re-asserting it here would test the library.
 * Two things are this repo's decisions and can be wrong without any type
 * complaining:
 *  C1  the menu still opens from the keyboard at all — the one way our styling
 *      wrapper can break Radix is by adding a competing handler on the trigger.
 *  C2  the stateful item types carry the roles the control's meaning requires:
 *      `menuitemcheckbox` for column visibility, `menuitemradio` for density.
 *      Rendering density as three checkboxes tells a screen-reader user they can
 *      pick two, which is a lie about the control. Both directions asserted —
 *      the role AND that a change reports the new value.
 *
 * Harness facts that look like component bugs and are not: a mouse opens the menu
 * on `pointerdown`, not `click`; and the trigger is unqueryable once the modal
 * menu is up, because everything outside the portal goes `aria-hidden`.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
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

function Harness() {
  const [columns, setColumns] = useState({ depth: true, audited: false });
  const [density, setDensity] = useState("dense");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost">Row actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Re-audit</DropdownMenuItem>
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

async function openByPointer() {
  fireEvent.pointerDown(triggerNode(), { button: 0, ctrlKey: false });
  return screen.findByRole("menu");
}

it("C1: the menu is reachable from the keyboard, and says it is a menu button", async () => {
  render(<Harness />);
  expect(triggerNode()).toHaveAttribute("aria-haspopup", "menu");
  const trigger = triggerNode();
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
  expect(await screen.findByRole("menu")).toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-expanded", "true");
});

describe("C2 stateful items carry the role their meaning requires", () => {
  it("C2: column toggles are checkboxes, and toggling one reports the new value", async () => {
    render(<Harness />);
    await openByPointer();
    expect(screen.getByRole("menuitemcheckbox", { name: "Depth" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Audited" }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    await openByPointer();
    await waitFor(() => {
      expect(screen.getByRole("menuitemcheckbox", { name: "Audited" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
  });

  it("C2: density is a radio set with exactly one checked, and choosing moves it", async () => {
    render(<Harness />);
    await openByPointer();
    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(3);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Comfortable" }));
    await waitFor(() => expect(screen.getByTestId("density")).toHaveTextContent("comfortable"));
  });
});
