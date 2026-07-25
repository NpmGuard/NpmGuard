/**
 * Contract: no bare-element rule in `base.css` may sit outside a layer.
 *
 * ── WHY THIS SURVIVED THE MIGRATION IT WAS WRITTEN FOR ─────────────────────
 *
 * It was written to pin a two-substrate rule: legacy CLASS rules stay unlayered
 * (so legacy pages keep winning), legacy ELEMENT rules go into `@layer base` (so
 * the design system stops being overruled). The legacy substrate is now gone and
 * half of that is moot — but the half that remains is not a migration detail, it
 * is a permanent property of the cascade, and it guards a bug that took months
 * to notice:
 *
 *   An unlayered `button { background: none; border: 0; padding: 0 }` beats
 *   `.bg-accent`, `.border` and `.px-3` in `@layer utilities`, no matter what
 *   their specificity is, because unlayered always wins over layered.
 *
 * That single rule left EVERY `<Button>` in `components/ui/` rendering as
 * unstyled text on every recomposed surface, and `a { color: inherit }` ate
 * every link-colour utility beside it. Nothing caught it: jsdom does not
 * implement `@layer`, so no rendering test can see this class of bug, and the
 * failure looks like "the design got worse" rather than like a defect.
 *
 * So the invariant is enforced as a text contract, the same technique
 * `token-contract.test.ts` uses, and it applies to whatever `base.css` grows
 * next — the next person to add `input { … }` or `table { … }` at the top level
 * of this file gets a failing test rather than a silently neutered component.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(resolve(process.cwd(), "src/styles/base.css"), "utf8");
const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** Brace-matched spans of every `@layer <name> { … }` block. */
function layerSpans(css: string): [number, number][] {
  const spans: [number, number][] = [];
  const re = /@layer\s+[\w-]+\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    spans.push([m.index, i]);
  }
  return spans;
}

const SPANS = layerSpans(clean);
const LAYERED = SPANS.map(([a, b]) => clean.slice(a, b)).join("\n");
const UNLAYERED = (() => {
  let rest = clean;
  for (const [a, b] of [...SPANS].reverse()) rest = rest.slice(0, a) + rest.slice(b);
  return rest;
})();

/** A selector made only of bare element names — no class, id, attribute or
 * pseudo anywhere in it. These are the ones that collide with utilities. */
const BARE_ELEMENT = /^[a-z][a-z0-9]*(\s*,\s*[a-z][a-z0-9]*)*$/;

function selectorsOf(css: string): string[] {
  return [...css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)].map((m) => m[2].trim()).filter(Boolean);
}

describe("C1 — the element reset is layered, so utilities win", () => {
  const RESET_PROPS = [
    ["button", "background"],
    ["button", "border"],
    ["button", "padding"],
    ["a", "color"],
    ["ul, ol", "list-style"],
  ] as const;

  it.each(RESET_PROPS)("`%s { %s }` is inside an @layer", (selector, prop) => {
    const inLayer = new RegExp(`${selector.replace(/[,\s]+/g, "[,\\s]+")}\\s*\\{[^}]*${prop}\\s*:`);
    expect(LAYERED).toMatch(inLayer);
    // …and nowhere outside one. An unlayered duplicate would win again, and the
    // first assertion alone would not notice.
    expect(UNLAYERED).not.toMatch(inLayer);
  });

  it("leaves no bare-element rule unlayered anywhere in the sheet", () => {
    // `@keyframes` steps are spelled `from`/`to`/`50%`, which look like element
    // selectors and are not — a keyframe cannot collide with a utility class.
    const noKeyframes = UNLAYERED.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
    const offenders = selectorsOf(noKeyframes).filter(
      (sel) =>
        BARE_ELEMENT.test(sel) &&
        // `html` / `body` set the page plane. No utility competes for it, and
        // they cannot be layered without losing to Tailwind's own preflight.
        !/^(html|body)(\s*,\s*(html|body))*$/.test(sel),
    );
    expect(offenders).toEqual([]);
  });
});

describe("C2 — the sheet stays a base layer and does not regrow a component library", () => {
  it("declares no component-shaped class rules", () => {
    // `base.css` was 798 lines and a complete second design system: `.btn`,
    // `.card`, `.pill`, `.tag`, `.rail`, `.meter`, `.empty-state`, `.dot`. Every
    // one of those now lives in `components/ui/`, and the failure mode this
    // guards is the cheap one — someone adding "just one" `.badge` here because
    // a stylesheet is faster to edit than a component is.
    //
    // `.ng-root` is the single permitted class: it marks the subtrees Radix
    // portals outside the app root so they inherit v3 typography and the ring.
    const classes = new Set(
      [...clean.matchAll(/\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]),
    );
    classes.delete("ng-root");
    expect([...classes]).toEqual([]);
  });
});
