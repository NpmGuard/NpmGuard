/**
 * Component: form controls and table semantics — switch.tsx, checkbox.tsx,
 * table.tsx, copy-button.tsx, skeleton.tsx, button.tsx.
 *
 * Input classes:
 *  C1  Switch: the `pending` state is announced (`aria-busy`) and not only drawn.
 *      A shimmer a screen-reader user cannot perceive means they are told the
 *      change landed when it has not.
 *  C2  Switch: `blockedReason` disables the control AND renders the reason, wired
 *      via `aria-describedby`. A disabled control with no explanation makes the
 *      user conclude the product is broken.
 *  C3  Checkbox: the mixed state is `aria-checked="mixed"`, not unchecked — the
 *      select-all header over a partial selection is genuinely mixed.
 *  C4  Table: `aria-sort` appears on sortable headers only, is `none` when
 *      unsorted, and exactly one column claims a direction.
 *  C5  Table: severity is a left rule; unruled rows keep a transparent rule so the
 *      columns do not shift, and no row is filled by `severity`.
 *  C6  Table: it has an accessible name.
 *  C7  CopyButton: has a specific accessible name, writes the value, announces
 *      success politely, and surfaces a clipboard FAILURE rather than swallowing it.
 *  C8  Skeleton: is hidden from assistive tech, and its dimensions are a required
 *      prop (compile-time).
 *  C9  Button: `asChild` renders a real anchor, not a button — middle-click and
 *      "open in new tab" come from the element.
 *  C10 `className` survives the merge on a control.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button.tsx";
import { Checkbox } from "./checkbox.tsx";
import { CopyButton } from "./copy-button.tsx";
import { Skeleton } from "./skeleton.tsx";
import { Switch } from "./switch.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./table.tsx";

describe("Switch", () => {
  it("C1: a pending toggle is announced as busy, not only shimmered", () => {
    render(<Switch checked pending aria-label="Protect" />);
    const control = screen.getByRole("switch", { name: "Protect" });
    expect(control).toBeChecked();
    // F-D1: the toggle responds immediately while the first scan runs behind it.
    // The optimistic state must be legible to assistive tech too.
    expect(control).toHaveAttribute("aria-busy", "true");
    expect(control).toHaveAttribute("data-pending", "true");
  });

  it("C1: a settled toggle is not busy", () => {
    render(<Switch checked aria-label="Protect" />);
    expect(screen.getByRole("switch")).not.toHaveAttribute("aria-busy");
  });

  it("C2: a blocked toggle is disabled and says why", () => {
    render(<Switch aria-label="Protect" blockedReason="Scan quota reached for this month" />);
    const control = screen.getByRole("switch", { name: "Protect" });
    expect(control).toBeDisabled();
    expect(screen.getByText("Scan quota reached for this month")).toBeInTheDocument();
    // Wired, not merely adjacent: the reason is part of the control's
    // accessible description.
    expect(control).toHaveAccessibleDescription("Scan quota reached for this month");
  });

  it("C2: a blocked toggle does not change state on click", () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch aria-label="Protect" blockedReason="Quota reached" onCheckedChange={onCheckedChange} />,
    );
    fireEvent.click(screen.getByRole("switch"));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});

describe("Checkbox", () => {
  it("C3: the mixed state announces as mixed, not unchecked", () => {
    render(<Checkbox checked="indeterminate" aria-label="Select all rows" />);
    // A hand-rolled version almost always renders this as unchecked, telling the
    // user nothing is selected while rows are.
    expect(screen.getByRole("checkbox", { name: "Select all rows" })).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
  });

  it("C3: toggling reports the new value", () => {
    function Harness() {
      const [checked, setChecked] = useState(false);
      return (
        <Checkbox
          checked={checked}
          onCheckedChange={(next) => setChecked(next === true)}
          aria-label="Select row"
        />
      );
    }
    render(<Harness />);
    const box = screen.getByRole("checkbox");
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(box).toBeChecked();
  });
});

describe("Table", () => {
  function DepTable({ sorted = "ascending" as const }) {
    return (
      <Table label="Dependencies" density="dense">
        <TableHeader sticky>
          <TableRow>
            <TableHead sortable sortDirection={sorted} onSort={() => {}}>
              package
            </TableHead>
            <TableHead sortable sortDirection={null} onSort={() => {}}>
              audited
            </TableHead>
            <TableHead>outcome</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow severity="danger">
            <TableCell>event-stream@3.3.6</TableCell>
            <TableCell>2h ago</TableCell>
            <TableCell>DANGEROUS</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>left-pad@1.3.0</TableCell>
            <TableCell>1d ago</TableCell>
            <TableCell>SAFE</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
  }

  it("C4: aria-sort is on sortable headers only, and exactly one claims a direction", () => {
    render(<DepTable />);
    expect(screen.getByRole("columnheader", { name: /package/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    // Sortable but unsorted is `none`, which is a different statement from absent.
    expect(screen.getByRole("columnheader", { name: /audited/ })).toHaveAttribute(
      "aria-sort",
      "none",
    );
    // An unsortable column must not claim to be unsorted.
    expect(screen.getByRole("columnheader", { name: "outcome" })).not.toHaveAttribute("aria-sort");
    const claiming = screen
      .getAllByRole("columnheader")
      .filter((th) => ["ascending", "descending"].includes(th.getAttribute("aria-sort") ?? ""));
    expect(claiming).toHaveLength(1);
  });

  it("C5: severity is a left rule, and unruled rows keep the gutter", () => {
    render(<DepTable />);
    const dangerous = screen.getByText("event-stream@3.3.6").closest("tr");
    const safe = screen.getByText("left-pad@1.3.0").closest("tr");
    expect(dangerous).toHaveAttribute("data-severity", "danger");
    expect(dangerous?.className).toMatch(/border-l-danger/);
    // Whole-row wash is reserved for log/evidence panes; on 340 dep rows it turns
    // the table into wallpaper.
    expect(dangerous?.className).not.toMatch(/bg-danger-wash/);
    // The transparent rule keeps the columns aligned across ruled and unruled rows.
    expect(safe?.className).toMatch(/border-l-transparent/);
    expect(safe).not.toHaveAttribute("data-severity");
  });

  it("C6: the table has an accessible name", () => {
    render(<DepTable />);
    expect(screen.getByRole("table")).toHaveAccessibleName("Dependencies");
  });

  it("C5: density reaches the rows through context, not per-row props", () => {
    render(<DepTable />);
    expect(screen.getByRole("table")).toHaveAttribute("data-density", "dense");
    const row = screen.getByText("left-pad@1.3.0").closest("tr");
    expect(row?.className).toMatch(/\bh-row-dense\b/);
    // …and relaxes below `md`, because a 32px row cannot hold a 44px tap target.
    expect(row?.className).toMatch(/\bmax-md:h-row-comfy\b/);
  });
});

describe("CopyButton", () => {
  it("C7: has a specific name, writes the value, and announces success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<CopyButton value="audit_01JQ7bK" label="Copy audit id" />);
    // "Copy" alone is ambiguous on a page with six of them.
    const button = screen.getByRole("button", { name: "Copy audit id" });
    fireEvent.click(button);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("audit_01JQ7bK");
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });
    vi.unstubAllGlobals();
  });

  it("C7: a clipboard failure is surfaced, not swallowed", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<CopyButton value="audit_01JQ7bK" label="Copy audit id" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy audit id" }));
    // A copy button that silently does nothing is worse than one that is absent,
    // because the user then pastes stale content.
    await waitFor(() => {
      expect(screen.getAllByText("Could not copy").length).toBeGreaterThan(0);
    });
    vi.unstubAllGlobals();
  });
});

describe("Skeleton", () => {
  it("C8: is hidden from assistive tech", () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.firstElementChild).toHaveClass("h-4", "w-32");
  });

  it("C8: dimensions are a required prop", () => {
    // @ts-expect-error a skeleton with no size collapses to zero height and then
    // shoves the page when content lands — the layout shift it exists to prevent.
    const sizeless = <Skeleton />;
    expect(sizeless).toBeDefined();
  });
});

describe("Button", () => {
  it("C9: asChild renders a real anchor, not a button", () => {
    render(
      <Button asChild variant="outline">
        <a href="/replays">Replays</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Replays" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/replays");
    // `type="button"` on an `<a>` is an invalid attribute no browser uses.
    expect(link).not.toHaveAttribute("type");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("C9: a plain Button defaults to type=button", () => {
    render(<Button>Scan now</Button>);
    // Without this, a button inside a form submits it — the classic accidental
    // full-page reload.
    expect(screen.getByRole("button", { name: "Scan now" })).toHaveAttribute("type", "button");
  });

  it("C10: an incoming className wins its conflict group", () => {
    render(<Button className="rounded-none px-8">Scan now</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("rounded-none", "px-8");
    expect(button).not.toHaveClass("rounded-md");
    expect(button).not.toHaveClass("px-3");
  });
});
