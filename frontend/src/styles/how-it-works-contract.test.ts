/**
 * Contract: the page and its one page-scoped sheet describe the same elements.
 *
 * ── THE BUG THIS EXISTS FOR ────────────────────────────────────────────────
 *
 * `how-it-works.css` is the single surface-owned stylesheet in the app, which
 * means it is also the only place where a class can be *renamed out from under*
 * its rules with nothing to notice. That happened: a commit that meant to delete
 * three re-derived component families (`.hiw-btn`, `.hiw-stamp`, `.hiw-chip`)
 * took the hero and the exhibit with them — 22 layout rules — and `/how-it-works`
 * shipped with its whole above-the-fold rendering as unstyled stacked text.
 *
 * Nothing caught it, and nothing structurally *could*: the classes still existed
 * in the markup, the sheet still loaded, the bundle still contained 144 `hiw-`
 * rules, `tsc` has no opinion about a string, and jsdom computes no layout — so
 * every existing tier stayed green. The defect was visible only to an eye on a
 * rendered page.
 *
 * A text contract closes it, the same technique `base-layer.test.ts` and
 * `token-contract.test.ts` use. Both directions are asserted, because each
 * catches a different half:
 *
 *   used-but-undefined  → a rule was deleted or renamed; the page renders bare.
 *   defined-but-unused  → markup moved on; the sheet is carrying dead weight,
 *                         which is how the sheet drifted far enough for a
 *                         deletion to hit the wrong block in the first place.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(resolve(process.cwd(), "src/styles/how-it-works.css"), "utf8");
const TSX = readFileSync(resolve(process.cwd(), "src/pages/HowItWorks.tsx"), "utf8");

/** Comments are prose about classes, not definitions of them — the header names
 * `.hiw-btn` precisely to record that it is gone. */
const rulesOnly = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

const defined = new Set(
  [...rulesOnly.matchAll(/\.(hiw-[a-zA-Z0-9_-]+)/g)].map((m) => m[1]),
);

/** Class names the component actually puts on an element.
 *
 * Read from every string literal rather than from `className=` alone, because
 * three real spellings are not attribute-shaped: a ternary
 * (`className={hot ? "hiw-codeline hiw-codeline--hot" : "hiw-codeline"}`), a
 * template literal, and GSAP's `linesClass: "hiw-splitline"`. An extractor that
 * only understood the plain attribute called seven live rules dead.
 *
 * Two non-class spellings are removed first: `id="hiw-verdict"` and the
 * `href="#hiw-verdict"` that targets it need no rule. */
const markup = TSX.replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\bid="[^"]*"/g, "")
  .replace(/href="#[^"]*"/g, "");

// Every remaining `hiw-…` token is a class: the name is hyphenated, so it cannot
// be a JS identifier, and the two non-class spellings are already gone.
const used = new Set(
  [...markup.matchAll(/\bhiw-[a-zA-Z0-9_-]+/g)]
    .map((m) => m[0])
    // `hiw-exit--${tone}`: the stem is what the literal contains; C3 covers the
    // variants it can produce.
    .filter((token) => !token.endsWith("--")),
);

/** Variants only reachable through an interpolated class, with the values the
 * component can pass. `Outcome` is the contract enum; ERROR has no exit card. */
const INTERPOLATED = ["hiw-exit--danger", "hiw-exit--safe"];

describe("/how-it-works: page markup and its sheet agree", () => {
  it("C1: the extractors found something — a broken regex must fail loudly", () => {
    expect(used.size).toBeGreaterThan(50);
    expect(defined.size).toBeGreaterThan(50);
  });

  it("C2: every class the page renders has a rule", () => {
    const orphans = [...used].filter((c) => !defined.has(c)).sort();
    expect(orphans, "these render unstyled — a rule was deleted or renamed").toEqual([]);
  });

  it("C3: every interpolated variant has a rule", () => {
    const orphans = INTERPOLATED.filter((c) => !defined.has(c));
    expect(orphans).toEqual([]);
  });

  it("C4: the sheet carries no rule the page stopped using", () => {
    const dead = [...defined]
      .filter((c) => !used.has(c) && !INTERPOLATED.includes(c))
      .sort();
    expect(dead, "dead rules — delete them, or the markup lost a class").toEqual([]);
  });
});
