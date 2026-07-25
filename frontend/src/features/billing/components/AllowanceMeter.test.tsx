/**
 * Component: the usage-bucket allowance — AllowanceMeter.tsx.
 *
 * The bar's magnitude is derived inside `ui/meter` from `(value, max)`, so the
 * load-bearing property — a bar that looks full when nothing is exhausted, or
 * empty when everything is, is a fabricated measurement — is pinned here against
 * the RENDERED meter rather than against a number this feature computes.
 *
 * Input classes (the three states a `UsageBucket` collapses to, plus the semantic
 * one that has no bucket dimension at all):
 *  M1  role — a quota is `role="meter"`, never `role="progressbar"`. §3.2 draws
 *      this distinction explicitly, and it is not cosmetic: `progressbar` tells a
 *      screen-reader user that "3 of 3 used" is 100% *done*, the opposite of what
 *      a spent allowance means. The regression is silent to the eye, which is
 *      exactly why it needs a test.
 *  M2  unlimited (`remaining === null`) — NO bar at all, and the `∞` label. A
 *      sliver would be a magnitude invented for a ceiling that does not exist.
 *  M3  exhausted (`remaining <= 0`) — `over-limit`, which is the `error` violet
 *      slot and never `danger` red (§0 rule 3: red is a claim about a package, and
 *      a spent quota is "we could not check").
 *  M4  available — a real `role="meter"` carrying honest `aria-value*`, and the
 *      visible and announced readings are the SAME string.
 *  M5  both themes, no hardcoded colour — one class serves light and dark, which
 *      is only true while every colour travels through a token.
 *
 * Blackbox: render with a hand-built bucket; assert on the accessibility tree and
 * the `data-meter-state` the primitive plants for exactly this purpose.
 */

import type { UsageBucket } from "@npmguard/shared";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { expectNoHardcodedColour } from "../../../components/panel/theme-probe.ts";
import { AllowanceMeter } from "./AllowanceMeter.tsx";

const bucket = (used: number, limit: number, remaining: number | null): UsageBucket => ({
  used,
  limit,
  remaining,
});

function meterState(container: HTMLElement): string | null {
  return container.querySelector("[data-meter-state]")?.getAttribute("data-meter-state") ?? null;
}

describe("AllowanceMeter — M1 a quota is a meter, not a progressbar", () => {
  it("M1: renders role=meter and never role=progressbar", () => {
    render(<AllowanceMeter label="Protected repositories" bucket={bucket(1, 3, 2)} />);
    expect(screen.getByRole("meter", { name: "Protected repositories" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("AllowanceMeter — M2 unlimited draws no bar", () => {
  it("M2: an unmetered bucket renders no bar, and says so in words", () => {
    const { container } = render(<AllowanceMeter label="Audits" bucket={bucket(9, 0, null)} />);
    expect(meterState(container)).toBe("unmetered");
    // The whole point: neither a full bar nor an empty one nor a 5% sliver.
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText("No limit on this plan")).toBeInTheDocument();
    // …and the ∞ reading survives the move.
    expect(screen.getByText("9 / ∞")).toBeInTheDocument();
  });
});

describe("AllowanceMeter — M3 exhausted is the error slot, not danger", () => {
  it("M3: a spent allowance is over-limit and wears the error hue", () => {
    const { container } = render(<AllowanceMeter label="Audits" bucket={bucket(3, 3, 0)} />);
    expect(meterState(container)).toBe("over-limit");

    // §0 rule 3, asserted from the outside: no `danger` token reaches this
    // component. The legacy fill was `meter__fill--danger`, and the whole reason
    // ERROR and UI degradation share one slot is so "we could not check" never
    // reads as "it's bad".
    expect(container.innerHTML).not.toMatch(/danger/);
    expect(container.innerHTML).toMatch(/error/);
  });

  it("M3: negative remaining is still exhausted, never available", () => {
    const { container } = render(<AllowanceMeter label="Audits" bucket={bucket(4, 3, -1)} />);
    expect(meterState(container)).toBe("over-limit");
  });
});

describe("AllowanceMeter — M4 an available bucket announces what it shows", () => {
  it("M4: aria values are honest and the announced text matches the visible text", () => {
    render(<AllowanceMeter label="Audits" bucket={bucket(1, 4, 3)} />);
    const meter = screen.getByRole("meter", { name: "Audits" });
    expect(meter).toHaveAttribute("aria-valuenow", "1");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "4");
    // One string, both channels — a bare percentage would be a second projection.
    expect(meter).toHaveAttribute("aria-valuetext", "1 / 4");
    expect(screen.getByText("1 / 4")).toBeInTheDocument();
  });
});

describe("AllowanceMeter — M5 both themes", () => {
  afterEach(() => document.documentElement.classList.remove("dark", "light"));

  for (const theme of ["light", "dark"] as const) {
    it(`M5: every bucket state renders under an explicit .${theme} stamp`, () => {
      document.documentElement.classList.add(theme);
      render(
        <>
          <AllowanceMeter label="Available" bucket={bucket(1, 4, 3)} />
          <AllowanceMeter label="Near limit" bucket={bucket(9, 10, 1)} />
          <AllowanceMeter label="Exhausted" bucket={bucket(3, 3, 0)} />
          <AllowanceMeter label="Unlimited" bucket={bucket(9, 0, null)} />
        </>,
      );
      expect(screen.getAllByRole("meter")).toHaveLength(3); // unlimited draws none
      expectNoHardcodedColour();
    });
  }
});
