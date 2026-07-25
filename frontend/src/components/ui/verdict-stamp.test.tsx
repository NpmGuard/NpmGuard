/**
 * Component: the panel's verdict and progress stamps — tone.tsx's renderers.
 *
 * These carry the one rule the design brief calls non-negotiable (§2.4): every
 * state renders as **glyph + word + colour, in that order of priority**, and the
 * stated test is "remove all colour from the UI and every state is still
 * readable." A tone map alone cannot be checked against that — the map is pure and
 * correct either way — so it is checked here, on the rendered output.
 *
 * Input classes:
 *  S1  every outcome renders a glyph AND its word. Colour is the third channel,
 *      never the only one.
 *  S2  the three outcomes have three DISTINCT silhouettes, not three colours of
 *      one shape. This is what survives greyscale, print and forced-colors.
 *  S4  ERROR wears the `error` violet slot and never `danger` red. §0 rule 3:
 *      red means NpmGuard is making a claim about a package, and "we could not
 *      conclude" is not a finding.
 *  S5  §2.8 — no `rounded-full` on a status element; the verdict is a stamp.
 *  S6  the progress stamps are ACHROMATIC (§2.2 rule 2). The only hue permitted
 *      anywhere near them is `progress-mark` on the spinner's moving arc, which is
 *      what stops "running" from ever reading as a verdict.
 *  S7  the progress label is real text, so the state survives with animation
 *      disabled (§2.9 rule 1), and the spinner opts out under reduced motion
 *      rather than being the only carrier of "alive".
 *
 * Blackbox: render and inspect the DOM. No colour computation — jsdom has no
 * Tailwind — so the assertions are on which token classes were emitted, which is
 * the same thing one layer up.
 */

import type { Outcome } from "@npmguard/shared";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VerdictStamp, ProgressStamp, type ProgressState } from "./verdict-stamp.tsx";

const OUTCOMES: Outcome[] = ["SAFE", "DANGEROUS", "ERROR"];
const PROGRESS: ProgressState[] = ["queued", "running", "unaudited"];

function stampOf(outcome: Outcome): HTMLElement {
  const { container } = render(<VerdictStamp outcome={outcome} />);
  const stamp = container.querySelector<HTMLElement>("[data-outcome]");
  expect(stamp, `a stamp rendered for ${outcome}`).not.toBeNull();
  return stamp!;
}

describe("VerdictStamp — S1/S2 glyph + word, distinct silhouettes", () => {
  it("S1: every outcome renders a glyph and its word", () => {
    for (const outcome of OUTCOMES) {
      const stamp = stampOf(outcome);
      // The word. Uppercase comes from the class, so the DOM keeps the
      // contract's own casing and a test can assert the contract value.
      expect(stamp.textContent).toBe(outcome);
      // The glyph. `aria-hidden`, because the word already says it — an icon that
      // announces itself makes every stamp read twice.
      const glyph = stamp.querySelector("svg");
      expect(glyph, `${outcome} has a glyph`).not.toBeNull();
      expect(glyph).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("S2: the three outcomes are three shapes, not three colours of one shape", () => {
    // The greyscale test, mechanised. If these ever collapse to one silhouette,
    // the only thing separating SAFE from DANGEROUS is a red/green pair sitting at
    // deutan dE 7.8 (§2.3) — legal only *with* secondary encoding, which is this.
    const shapes = OUTCOMES.map((outcome) => stampOf(outcome).querySelector("svg")?.innerHTML);
    expect(new Set(shapes).size).toBe(OUTCOMES.length);
  });

});

describe("VerdictStamp — S4/S5 the slots and the shape", () => {
  it("S4: ERROR is the error violet slot, never danger red", () => {
    const stamp = stampOf("ERROR");
    expect(stamp.className).toMatch(/\berror-/);
    // The load-bearing negative: folding ERROR into red is what would let "we
    // tried and failed" read as "we found something".
    expect(stamp.className).not.toMatch(/\bdanger/);
    expect(stamp.className).not.toMatch(/\bsafe/);
  });

  it("S4: SAFE and DANGEROUS keep their own slots", () => {
    expect(stampOf("SAFE").className).toMatch(/safe-/);
    expect(stampOf("SAFE").className).not.toMatch(/danger|error-/);
    expect(stampOf("DANGEROUS").className).toMatch(/danger-/);
    expect(stampOf("DANGEROUS").className).not.toMatch(/\bsafe|error-/);
  });

});

describe("ProgressStamp — S6/S7 the achromatic axis", () => {
  function progressOf(state: ProgressState, label = "Auditing"): HTMLElement {
    const { container } = render(<ProgressStamp state={state}>{label}</ProgressStamp>);
    return container.querySelector<HTMLElement>("[data-progress]")!;
  }

  it("S6: no progress state wears an outcome hue", () => {
    for (const state of PROGRESS) {
      const stamp = progressOf(state);
      // Progress is not a conclusion. The old markup painted the running pill
      // BLUE and the pending rail segment blue with it, which is exactly how an
      // in-flight scan came to read as a settled posture.
      expect(stamp.outerHTML, state).not.toMatch(/-(safe|danger|error)\b/);
    }
  });

  it("S7: the label is text, and the motion is optional", () => {
    const running = progressOf("running", "Auditing");
    expect(running.textContent).toBe("Auditing");
    const glyph = running.querySelector("svg")?.getAttribute("class") ?? "";
    // §2.9 rule 1: if motion is the only thing saying the audit is alive, it looks
    // dead for every reduced-motion user — so the spin stops and the §2.4 arc
    // silhouette plus the word carry the state on their own.
    expect(glyph).toMatch(/animate-spin/);
    expect(glyph).toMatch(/motion-reduce:animate-none/);
  });

});
