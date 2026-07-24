/**
 * AllowanceMeter — quota-state display class map.
 *
 * The meter renders a UsageBucket allowance as a mono `used / limit` label over
 * a fill bar. It must be an HONEST reporter of quota state:
 *   C1 unlimited (remaining === null): "∞" label + token (non-zero, non-full)
 *      fill; never a "0 left"-style dead-end and never the danger tone.
 *   C2 exhausted (remaining === 0, real limit): full meter (100% width) painted
 *      in the danger tone; the label shows used / limit, not a fabricated slot.
 *   C3 available, plural (remaining > 1): fractional fill = used/limit; label
 *      shows used / limit.
 *   C4 available, singular boundary (remaining === 1): still a fractional fill,
 *      still an honest used / limit label — the singular/plural boundary lives
 *      in copy helpers, not in this meter's own text.
 *   C5 over-cap guard (used > limit): fraction clamped to 100%, never > full.
 *
 * Blackbox: assert the visible label text, the progressbar aria-valuetext, and
 * the fill semantics (style width + danger class as a stable hook), never the
 * helper internals.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { renderRoute, resetPanelStore } from "../../test/render.tsx";
import { setupPanelServer } from "../../test/panel-server.ts";
import { makeBucket } from "../../test/panel-fixtures.ts";
import { AllowanceMeter } from "./AllowanceMeter.tsx";

setupPanelServer();
beforeEach(() => resetPanelStore());

function fillEl() {
  // The single meter fill lives inside the progressbar.
  const bar = screen.getByRole("progressbar");
  return bar.querySelector(".meter__fill") as HTMLElement;
}

describe("AllowanceMeter", () => {
  it("C1: unlimited (remaining null) shows the ∞ label with a token fill, never a danger dead-end", () => {
    renderRoute(
      <AllowanceMeter label="Monthly audits" bucket={makeBucket({ used: 7, remaining: null })} />,
    );
    // ∞ label, not "0 / …" and not a coerced number.
    expect(screen.getByText("7 / ∞")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuetext", "7 / ∞");
    const fill = fillEl();
    // token fill: present but neither empty nor full.
    expect(fill.style.width).toBe("5%");
    expect(fill.className).not.toContain("meter__fill--danger");
  });

  it("C2: exhausted (remaining 0, real limit) fills full in the danger tone", () => {
    renderRoute(
      <AllowanceMeter
        label="Protected repos"
        bucket={makeBucket({ used: 3, limit: 3, remaining: 0 })}
      />,
    );
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    const fill = fillEl();
    expect(fill.style.width).toBe("100%");
    // exhausted is the ONLY state that gets the danger hook.
    expect(fill.className).toContain("meter__fill--danger");
  });

  it("C3: available plural (remaining > 1) renders the fractional fill and honest fraction label", () => {
    renderRoute(
      <AllowanceMeter
        label="Public audits"
        bucket={makeBucket({ used: 1, limit: 4, remaining: 3 })}
      />,
    );
    expect(screen.getByText("1 / 4")).toBeInTheDocument();
    const fill = fillEl();
    expect(fill.style.width).toBe("25%");
    expect(fill.className).not.toContain("meter__fill--danger");
  });

  it("C4: available singular boundary (remaining === 1) is still a fractional non-danger fill", () => {
    renderRoute(
      <AllowanceMeter
        label="Public audits"
        bucket={makeBucket({ used: 3, limit: 4, remaining: 1 })}
      />,
    );
    expect(screen.getByText("3 / 4")).toBeInTheDocument();
    const fill = fillEl();
    // 3/4 = 75%, an honest partial — not coerced to full though only one slot remains.
    expect(fill.style.width).toBe("75%");
    expect(fill.className).not.toContain("meter__fill--danger");
  });

  it("C5: over-cap usage (used > limit) clamps the fill to 100%, never past full", () => {
    renderRoute(
      <AllowanceMeter
        label="Monthly audits"
        bucket={makeBucket({ used: 9, limit: 5, remaining: 0 })}
      />,
    );
    expect(screen.getByText("9 / 5")).toBeInTheDocument();
    const fill = fillEl();
    expect(fill.style.width).toBe("100%");
    // used > limit ⇒ remaining 0 ⇒ exhausted danger tone.
    expect(fill.className).toContain("meter__fill--danger");
  });

  it("C6: empty (used === 0, fresh limit) renders a 0% fill with an honest label, never danger", () => {
    // The zero-used boundary on the *used* axis: the fraction branch is 0/limit.
    // The meter must render an honest EMPTY bar — 0% width, "0 / limit" label —
    // and must NOT paint the danger tone (available, not exhausted). A fresh
    // allowance is the opposite of a dead end.
    renderRoute(
      <AllowanceMeter
        label="Public audits"
        bucket={makeBucket({ used: 0, limit: 3, remaining: 3 })}
      />,
    );
    expect(screen.getByText("0 / 3")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuetext", "0 / 3");
    const fill = fillEl();
    expect(fill.style.width).toBe("0%");
    expect(fill.className).not.toContain("meter__fill--danger");
  });
});
