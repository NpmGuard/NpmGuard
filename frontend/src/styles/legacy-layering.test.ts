/**
 * Contract: the legacy substrate cannot silently overrule the design system.
 *
 * `base.css` is deliberately UNLAYERED, and `index.css`'s header calls that
 * inversion "what makes the two systems safe to coexist" — an unlayered rule
 * beats every layer regardless of specificity, so a legacy page's `.btn` still
 * wins on a legacy page. For legacy *class* rules that is true and intended.
 *
 * For bare *element* rules it was the opposite of safe. `button { background:
 * none; border: 0; padding: 0 }` unlayered beats `.bg-accent`, `.border` and
 * `.px-3` in `@layer utilities`, so every `<Button>` in `components/ui/` was
 * rendering as unstyled text on every recomposed surface, and
 * `a { color: inherit }` was eating every link colour utility. It went unseen
 * because the panel pages that recomposed first lean on `Card`, `Table` and the
 * stamps — none of which are bare elements — and because nothing in the suite
 * could see the cascade: jsdom does not implement `@layer`, so no rendering test
 * can catch this. Hence a text contract, the same technique
 * `token-contract.test.ts` uses.
 *
 * C1 is the discriminating half (N-7): it FAILS against the file as it stood
 * before the fix, which is the only reason to trust that it is testing anything.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(resolve(process.cwd(), "src/styles/base.css"), "utf8");
const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** The `@layer <name> { … }` bodies in the sheet, brace-matched. */
function layerBodies(css: string): string[] {
  const out: string[] = [];
  const re = /@layer\s+[\w-]+\s*\{/g;
  while (re.exec(css)) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out;
}

const LAYERED = layerBodies(clean).join("\n");
const UNLAYERED = (() => {
  let rest = clean;
  const re = /@layer\s+[\w-]+\s*\{/g;
  let m: RegExpExecArray | null;
  const spans: [number, number][] = [];
  while ((m = re.exec(clean))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < clean.length && depth > 0; i++) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") depth--;
    }
    spans.push([m.index, i]);
  }
  for (const [a, b] of spans.reverse()) rest = rest.slice(0, a) + rest.slice(b);
  return rest;
})();

/** Selectors that are bare elements — no class, id or attribute anywhere in the
 * compound. These are the ones that collide with utility classes. */
const BARE_ELEMENT = /^[a-z][a-z0-9]*(\s*,\s*[a-z][a-z0-9]*)*$/;

function selectorsOf(css: string): string[] {
  return [...css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)].map((m) => m[2].trim()).filter(Boolean);
}

describe("C1 — base.css's element reset is layered, so utilities win", () => {
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
    // …and nowhere outside one. An unlayered duplicate would win again and the
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
        // `html`/`body`/`#root` set the page plane, which no utility competes
        // for, and `:where(html)` in the v3 tier is zero-specificity by design.
        !/^(html|body)(\s*,\s*(html|body))*$/.test(sel),
    );
    expect(offenders).toEqual([]);
  });
});

describe("C2 — legacy CLASS rules stay unlayered, which is the intended half", () => {
  it("keeps .btn and .pill above the layers, so legacy pages are unrepainted", () => {
    // If these ever move into a layer, every legacy page loses to Tailwind's
    // preflight and repaints — the exact regression the tier comment warns about.
    expect(UNLAYERED).toMatch(/\.btn\s*\{/);
    expect(UNLAYERED).toMatch(/\.pill\s*\{/);
  });
});
