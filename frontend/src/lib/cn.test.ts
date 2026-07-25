/**
 * Unit: the class merge — cn.ts.
 *
 * This is the contract that makes a component *extendable*. The old layer
 * expressed primitives as class names, so a caller who wanted different padding
 * had to out-specify a stylesheet. Here `className` is a prop, and it must win.
 *
 * Input classes:
 *  C1  conflict resolution — a caller's utility replaces the component's default
 *      in the same group, and a NON-conflicting one survives beside it. clsx and
 *      tailwind-merge own the mechanism; this pins the one property the component
 *      contract depends on.
 *  C5  ANTI-DRIFT, and the reason this file exists at all: every CUSTOM theme key
 *      in `styles/tokens.css` must be a recognised conflict group. tailwind-merge
 *      groups a class by validating its value, so a key it has not been told
 *      about (`h-control`, `ease-std`) silently gets no group and both classes
 *      survive — the caller loses to stylesheet order, invisibly. One assertion
 *      per namespace the token layer extends; a token added to the CSS and not to
 *      `cn.ts` fails here instead of degrading a layout in production.
 */

import { describe, expect, it } from "vitest";
import { cn } from "./cn.ts";

describe("cn", () => {
  it("C1: the caller's utility replaces the component default in the same group", () => {
    // The property every component contract here rests on. With template-string
    // concatenation both classes survive and the winner is whichever Tailwind
    // emitted last — so a caller asking for `p-6` on a `p-4` component gets `p-4`
    // about half the time. Non-conflicting utilities must NOT be collapsed, and
    // `text-` is the pair that would hurt: a size and a colour share the prefix,
    // so a greedy merge strips the colour off every sized element in the system.
    expect(cn("p-4", "p-6")).toBe("p-6");
    expect(cn("bg-surface text-text", "bg-sunken")).toBe("text-text bg-sunken");
    expect(cn("text-text-2", "text-md")).toBe("text-text-2 text-md");
    expect(cn("bg-surface", "hover:bg-sunken")).toBe("bg-surface hover:bg-sunken");
  });

  describe("C5 custom theme keys are recognised conflict groups", () => {
    it("C5: --spacing-* control and row sizes", () => {
      expect(cn("h-control", "h-control-lg")).toBe("h-control-lg");
      expect(cn("h-row-dense", "h-row-comfy")).toBe("h-row-comfy");
      expect(cn("min-h-control-sm", "min-h-tap")).toBe("min-h-tap");
      // The same keys reach every spacing-shaped utility, so the group has to
      // hold for padding and gap too, not just height.
      expect(cn("p-4", "p-row")).toBe("p-row");
      expect(cn("gap-2", "gap-icon")).toBe("gap-icon");
    });

    it("C5: --spacing-* icon sizes via `size-`", () => {
      expect(cn("size-icon", "size-icon-lg")).toBe("size-icon-lg");
      expect(cn("size-4", "size-icon-sm")).toBe("size-icon-sm");
    });

    it("C5: --text-figure", () => {
      // `2xs`…`5xl` parse as t-shirt sizes unaided; `figure` does not, and an
      // unreplaceable hero figure is exactly the silent failure C5 guards.
      expect(cn("text-figure", "text-sm")).toBe("text-sm");
      expect(cn("text-sm", "text-figure")).toBe("text-figure");
    });

    it("C5: --ease-std", () => {
      expect(cn("ease-std", "ease-out")).toBe("ease-out");
      expect(cn("ease-out", "ease-std")).toBe("ease-std");
    });

    it("C5: --shadow-* elevations", () => {
      expect(cn("shadow-card", "shadow-pop")).toBe("shadow-pop");
      expect(cn("shadow-modal", "shadow-sm")).toBe("shadow-sm");
    });

    it("C5: --duration-* named motion tokens", () => {
      expect(cn("duration-fast", "duration-enter")).toBe("duration-enter");
      // …and they must also displace a stock numeric duration, or a caller
      // reaching for `duration-0` to kill an animation would be ignored.
      expect(cn("duration-150", "duration-base")).toBe("duration-base");
      expect(cn("duration-base", "duration-0")).toBe("duration-0");
    });
  });
});
