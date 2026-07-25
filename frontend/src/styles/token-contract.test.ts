/**
 * Contract: the design-token layer — tokens.css, read as text.
 *
 * Three properties, each recomputed from the file rather than restated from it:
 *  C1  a token that varies by theme is declared in EVERY theme, and the two dark
 *      blocks are identical. CSS cannot share a declaration list between two
 *      selectors, so `prefers-color-scheme: dark` and `.dark` are written twice;
 *      a hole in either inherits the LIGHT value — #22201c ink on a #100f0d
 *      canvas is 1.19:1, i.e. invisible.
 *  C2  contrast, over the full product of ink × surface, against the WCAG floors.
 *      Deliberately not against pinned ratios: a palette edit that stays legal is
 *      not a regression, and one that goes illegal must fail here rather than in
 *      an accessibility audit. Two pairs sit below a floor on purpose and are
 *      pinned as exceptions with their mitigation.
 *  C3  the vocabulary is CLOSED — Tailwind's default palette and the off-scale
 *      steps are cleared, so an off-system value cannot be spelled as a utility,
 *      and `@theme inline` aliases a primitive instead of inlining a literal (an
 *      inlined hex would be the same value in both themes).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* Resolved from the vitest cwd: under jsdom `import.meta.url` is an http:// URL. */
const CSS = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

/** Comments carry hexes (OKLCH triples, ratio annotations) — all false positives. */
const clean = CSS.replace(/\/\*[\s\S]*?\*\//g, "");

type Block = { prelude: string; body: string };

const blocks = (css: string): Block[] => {
  const out: Block[] = [];
  let depth = 0;
  let start = 0;
  let preludeStart = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) {
        out.push({ prelude: css.slice(preludeStart, i).trim(), body: "" });
        start = i + 1;
      }
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        out[out.length - 1].body = css.slice(start, i);
        preludeStart = i + 1;
      }
    }
  }
  return out;
};

/** `--name: value` pairs from a block body, ignoring nested blocks.
 *  The declaration boundary is a LOOKBEHIND on purpose: a consuming `(?:^|[;{])`
 *  swallows the `;` the next declaration needs as its own boundary, so every
 *  second declaration silently vanishes. The name charset has to cover custom
 *  properties (`--ng-bg`), Tailwind's compound (`--text-6xl--line-height`) and its
 *  namespace clears (`--color-*`), plus plain properties (`color-scheme`). */
const decls = (body: string): Record<string, string> => {
  const flat = body.replace(/[^{}]*\{[\s\S]*?\}/g, (m) => (m.includes("--") ? m : ""));
  const out: Record<string, string> = {};
  for (const [, k, v] of flat.matchAll(
    /(?<=^|[;{])\s*(--[a-z0-9*-]+(?:--[a-z-]+)?|[a-z][a-z0-9-]*)\s*:\s*([^;{}]+);/gi,
  )) {
    out[k] = v.trim().replace(/\s+/g, " ");
  }
  return out;
};

const top = blocks(clean);
const pick = (re: RegExp): Block[] => top.filter((b) => re.test(b.prelude));
const merge = (bs: Block[]) =>
  Object.assign({}, ...bs.map((b) => decls(b.body))) as Record<string, string>;

const nested = (b: Block, selector: string): Record<string, string> => {
  const inner = blocks(b.body).find((n) => n.prelude === selector);
  if (!inner) throw new Error(`missing ${selector} inside ${b.prelude}`);
  return decls(inner.body);
};

const LIGHT = merge(pick(/^:root$/));
const DARK_SYSTEM = nested(
  pick(/^@media \(prefers-color-scheme: dark\)$/)[0],
  ":root:not(.light)",
);
const DARK_CLASS = decls(pick(/^\.dark$/)[0].body);
const REDUCED = nested(pick(/^@media \(prefers-reduced-motion: reduce\)$/)[0], ":root");
const THEME_INLINE = merge(pick(/^@theme inline$/));
const THEME_PLAIN = merge(pick(/^@theme$/));

const themes = { light: LIGHT, dark: { ...LIGHT, ...DARK_CLASS } } as const;
type ThemeName = keyof typeof themes;

/** Follow `var(--ng-x)` aliases to a literal. The progress axis and chart slot 1
 *  are aliases on purpose — an alias cannot drift from its source. */
const literal = (name: string, theme: ThemeName, hops = 0): string => {
  const raw = themes[theme][name];
  if (raw === undefined) throw new Error(`token ${name} is not defined in ${theme}`);
  if (hops > 4) throw new Error(`token ${name} aliases in a cycle`);
  const alias = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  return alias ? literal(alias[1], theme, hops + 1) : raw;
};

/* WCAG 2.1 relative luminance. */
const channel = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const luminance = (hex: string): number => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not an opaque hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(m[1].slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

const ratio = (fg: string, bg: string, theme: ThemeName): number =>
  contrast(literal(`--ng-${fg}`, theme), literal(`--ng-${bg}`, theme));

const THEMES = ["light", "dark"] as const;
const SURFACES = ["canvas", "surface", "sunken", "raised"] as const;
const INKS = ["text", "text-2", "text-3"] as const;
const SEMANTICS = ["danger", "safe", "error", "accent"] as const;

describe("C1 every theme has every theme-varying token", () => {
  it("C1: the two dark blocks declare identical values", () => {
    expect(DARK_SYSTEM).toStrictEqual(DARK_CLASS);
  });

  it("C1: dark declares nothing light does not", () => {
    // A dark-only token is one no light-mode reader can resolve. The other
    // direction — a token MISSING from dark — is caught by C2 rather than here:
    // `literal()` throws on an undefined token, and C2 resolves every ink,
    // surface, semantic and ramp step in both themes. The `seq-*` ramp is
    // deliberately one set of hexes for both themes (its contrast against the
    // canvas inverts because the canvas flips), so a blanket "restated in dark"
    // rule would be wrong.
    for (const t of Object.keys(DARK_CLASS)) {
      if (t !== "color-scheme") expect(LIGHT, t).toHaveProperty(t);
    }
  });

  it("C1: both themes tell UA widgets which one they are", () => {
    expect(LIGHT["color-scheme"]).toBe("light");
    expect(DARK_CLASS["color-scheme"]).toBe("dark");
  });

  it("C1: the spacing ladder is derived from --spacing, not a second px ladder", () => {
    for (const [name, mult] of [
      ["--ng-space-0-5", "0.5"],
      ["--ng-space-4", "4"],
      ["--ng-space-24", "24"],
    ] as const) {
      expect(LIGHT[name]).toBe(`calc(var(--spacing) * ${mult})`);
    }
  });
});

describe("C2 contrast, recomputed over every pair", () => {
  it("C2: every ink step clears 4.5:1 on every surface, in both themes", () => {
    // The muted step included: in a product full of dense tables it inevitably
    // carries real content — versions, timestamps, paths.
    for (const theme of THEMES) {
      for (const ink of INKS) {
        for (const bg of SURFACES) {
          expect(ratio(ink, bg, theme), `${ink} on ${bg} (${theme})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("C2: every semantic text step clears 4.5:1 on canvas, surface and its own wash", () => {
    for (const theme of THEMES) {
      for (const f of SEMANTICS) {
        for (const bg of ["canvas", "surface", `${f}-wash`]) {
          expect(
            ratio(`${f}-text`, bg, theme),
            `${f}-text on ${bg} (${theme})`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it("C2: every semantic mark clears 3:1 on canvas, and its `on` ink clears 4.5:1", () => {
    for (const theme of THEMES) {
      for (const f of SEMANTICS) {
        expect(ratio(f, "canvas", theme), `${f} mark (${theme})`).toBeGreaterThanOrEqual(3);
        expect(ratio(`${f}-on`, f, theme), `${f}-on (${theme})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("C2: `on` is a token because white is NOT universally legal on a fill", () => {
    // White on the dark safe mark is 2.94:1 — a fail. That single fact is why
    // ink-on-a-fill is a token instead of components writing `text-white`, and why
    // three of the four semantics flip to near-black ink in dark.
    expect(contrast("#ffffff", literal("--ng-safe", "dark"))).toBeLessThan(4.5);
  });

  it("C2: control boundaries clear 3:1 and the decorative hairline stays below it", () => {
    // Two tokens whose whole distinction is this threshold (WCAG 1.4.11). Pinning
    // the hairline's ceiling stops it being "improved" into control territory,
    // which erases the distinction the control token exists to draw.
    for (const theme of THEMES) {
      for (const bg of ["surface", "canvas"]) {
        expect(ratio("border-control", bg, theme)).toBeGreaterThanOrEqual(3);
        expect(ratio("border", bg, theme)).toBeLessThan(3);
      }
    }
  });

  it("C2: the sequential ramp is ordinal and its near-surface end clears 2:1", () => {
    const steps = [100, 200, 300, 400, 500, 600, 700, 800];
    for (const theme of THEMES) {
      const ratios = steps.map((s) => ratio(`seq-${s}`, "canvas", theme));
      const ordered =
        theme === "light"
          ? [...ratios].sort((a, b) => a - b)
          : [...ratios].sort((a, b) => b - a);
      expect(ratios, `seq ramp is ordinal (${theme})`).toStrictEqual(ordered);
    }
    expect(ratio("seq-300", "canvas", "light")).toBeLessThan(2);
    expect(ratio("seq-600", "canvas", "dark")).toBeGreaterThan(2);
  });

  it("C2: dark `danger` is a full lightness step below `safe` — deliberately", () => {
    // Equal-lightness red and green are exactly what deuteranopia cannot separate.
    // Raising danger to match safe looks tidier and moves dark-mode CVD separation
    // from a passing dE 9.9 back to a failing 5.8.
    expect(ratio("danger", "canvas", "dark")).toBeLessThan(ratio("safe", "canvas", "dark"));
  });

  it("C2: the two sub-floor pairs are exceptions with a stated mitigation", () => {
    // Chart slot 3 (aqua on the light canvas) is legal only where direct labels or
    // the table view are present; its hex is chosen for CVD separation from slots 1
    // and 2 (worst dE 9.2) and darkening it collapses that. The `*-border` steps
    // are decoration on a surface whose meaning is carried by a glyph and a word at
    // 6.7–8.5:1, and are never the sole indicator of anything.
    expect(ratio("series-3", "canvas", "light")).toBeLessThan(3);
    expect(ratio("series-3", "canvas", "dark")).toBeGreaterThanOrEqual(3);
    for (const theme of THEMES) {
      for (const f of SEMANTICS) {
        expect(ratio(`${f}-border`, `${f}-wash`, theme)).toBeLessThan(3);
      }
    }
  });
});

describe("C3 the vocabulary is closed", () => {
  it("C3: Tailwind's default palette is cleared, and only the keywords survive", () => {
    // Without the clear, `bg-red-500` compiles and "no raw hex outside the token
    // block" is only a review item. `white`/`black` are NOT restored: ink on a fill
    // is a token because white is illegal on three of the four dark marks.
    expect(THEME_PLAIN["--color-*"]).toBe("initial");
    expect(THEME_PLAIN["--color-transparent"]).toBe("transparent");
    expect(THEME_PLAIN["--color-current"]).toBe("currentColor");
    expect(THEME_PLAIN).not.toHaveProperty("--color-white");
    expect(THEME_PLAIN).not.toHaveProperty("--color-black");
  });

  it("C3: the off-scale steps, the extra eases and the serif are cleared", () => {
    for (const key of ["--font-serif", "--ease-in-out", "--animate-bounce"]) {
      expect(THEME_PLAIN[key], key).toBe("initial");
    }
    expect(Object.values(THEME_PLAIN).filter((v) => v === "initial").length).toBeGreaterThan(10);
    // A cleared namespace NAMES what it clears, so `initial` declarations are the
    // enforcement rather than a violation of it — hence the skip.
    for (const [key, value] of Object.entries({ ...THEME_INLINE, ...THEME_PLAIN, ...LIGHT })) {
      if (value === "initial") continue;
      expect(key, "a third voice competes with the mono signal").not.toMatch(/(display|serif)/);
    }
  });

  it("C3: every @theme key aliases a primitive that exists, and inlines no literal", () => {
    for (const [key, value] of Object.entries(THEME_INLINE)) {
      const refs = [...value.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
      expect(refs.length, `${key} must alias a primitive`).toBeGreaterThan(0);
      for (const ref of refs) expect(LIGHT, `${key} -> ${ref}`).toHaveProperty(ref);
      expect(value, `${key} inlines a literal instead of aliasing`).not.toMatch(/#[0-9a-f]{3}/i);
    }
  });

  it("C3: every colour primitive is reachable as a utility", () => {
    // A token nobody can spell is a token that does not exist. `--ng-focus-ring` is
    // the one exception: a box-shadow list applied once in base.css, not a colour a
    // component picks.
    const mapped = new Set(
      Object.values(THEME_INLINE).flatMap((v) =>
        [...v.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
      ),
    );
    for (const [name, value] of Object.entries(LIGHT)) {
      if (!name.startsWith("--ng-") || name === "--ng-focus-ring") continue;
      if (!/^(#[0-9a-f]{3,8}|rgb\(|oklch\(|var\(--ng-)/i.test(value)) continue;
      expect(mapped, `${name} is not mapped into a Tailwind namespace`).toContain(name);
    }
  });

  it("C3: the progress axis is achromatic BY ALIAS, not by a copied hex", () => {
    // Only outcomes get colour. Aliasing to the neutral ink steps makes it
    // impossible to tint "running" green without retyping the alias. The single
    // exception is confined to a spinner's moving arc.
    for (const [name, target] of [
      ["progress-ink", "text-2"],
      ["progress-idle", "text-3"],
      ["progress-track", "border-faint"],
      ["progress-hatch", "border-strong"],
      ["progress-mark", "accent"],
    ] as const) {
      expect(LIGHT[`--ng-${name}`]).toBe(`var(--ng-${target})`);
    }
    expect(LIGHT["--ng-series-1"]).toBe("var(--ng-accent)");
  });

  it("C3: reduced motion zeroes every duration except the content crossfade", () => {
    // The crossfade is opacity-only, so a swap does not read as a glitch. A blanket
    // `animation: none` would flatten that exception, which is why the override is
    // on the TOKENS and not on the rules.
    for (const [name, value] of Object.entries(REDUCED)) {
      if (/^--ng-(dur-|stagger)/.test(name)) expect(value, name).toBe("0ms");
    }
    expect(REDUCED).not.toHaveProperty("--ng-dur-crossfade");
    expect(LIGHT["--ng-dur-crossfade"]).toBe("80ms");
    expect(THEME_INLINE["--default-transition-duration"]).toBe("var(--ng-dur-base)");
  });
});
