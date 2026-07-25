/**
 * Contract: the design-token layer — tokens.css.
 *
 * The brief (docs/specs/2026-07-25-frontend-design-direction.md §2) states 60+
 * contrast ratios as computed values. Prose cannot be trusted to stay true
 * across an edit, and "it looked fine" is how a 4.03:1 muted step ships. So
 * this file RECOMPUTES them from the hexes actually in tokens.css and asserts
 * the brief's own numbers — which means any palette edit fails here with a
 * precise diff instead of failing later in an accessibility audit.
 *
 * Input classes:
 *  C1  Completeness — every token §2.2/§2.6/§2.7/§2.8/§2.9 names exists, and
 *      every theme-varying one exists in BOTH themes. A dark theme with a hole
 *      in it inherits a light value and renders invisible text.
 *  C2  The two dark blocks (system `prefers-color-scheme` and explicit `.dark`)
 *      are byte-equal after parsing. CSS cannot share a declaration list
 *      between two selectors, so the values are written twice; this is the only
 *      thing standing between that and drift.
 *  C3  Contrast, recomputed. Every pair §2.2 tabulates, against its stated
 *      value AND its WCAG floor (4.5:1 text, 3:1 non-text marks and control
 *      boundaries). Plus §2.8's focus ring and §2.5's sequential ramp.
 *  C4  Schema, not convention — the `@theme inline` mapping is a bijection.
 *      Every mapped key resolves to a primitive that exists (a utility that
 *      suggests a token has one), and every colour primitive is mapped (a token
 *      that exists is reachable as a utility).
 *  C5  The vocabulary is CLOSED. Tailwind's default palette, the extra type
 *      steps, radii, shadows, `ease-in-out`, `bounce` and `font-serif` are
 *      cleared, so an off-system value cannot be spelled as a utility. This is
 *      §6's review checklist turned into a build outcome, and D-8 (no serif)
 *      enforced rather than remembered.
 *  C6  The KNOWN exceptions, pinned. Two values in the brief deliberately do
 *      not meet a floor; both are legal only because of a stated mitigation.
 *      Pinning them stops someone "fixing" the hex and silently deleting the
 *      reason the mitigation exists.
 *  C7  The reduced-motion override (§2.9) zeroes every duration EXCEPT the
 *      content crossfade, which must hold at 80ms so a swap doesn't read as a
 *      glitch.
 *
 * Blackbox: tokens.css is read as text and parsed. Nothing imports the app, and
 * jsdom cannot resolve `@theme` — the stylesheet IS the artifact under test.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/* ── the parser ─────────────────────────────────────────────────────────────
   Resolved from the vitest cwd (the frontend package root) — under jsdom
   `import.meta.url` is an http:// URL, not a file path. */
const CSS = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

/** Comments carry hexes in them (the OKLCH triples and the ratio annotations);
 *  every one of those would be a false positive for the parser. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

type Block = { prelude: string; body: string };

/** Top-level blocks, by brace matching. Enough structure for a token file and
 *  far less machinery than a real CSS parser. */
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

/** `--name: value` pairs from a block body, ignoring nested blocks. */
const decls = (body: string): Record<string, string> => {
  const flat = body.replace(/[^{}]*\{[\s\S]*?\}/g, (m) => (m.includes("--") ? m : ""));
  const out: Record<string, string> = {};
  // Two kinds of property name have to be captured, and missing either made this
  // parser silently report `undefined` for a declaration that is present:
  //   - a CUSTOM property: `--ng-bg`, Tailwind's compound
  //     `--text-6xl--line-height`, and its namespace-clearing `--color-*` (the
  //     `*` is why a `[a-z0-9-]` charset is not enough);
  //   - a PLAIN CSS property: `color-scheme`, which carries the light/dark
  //     contract to UA widgets and is not a custom property at all.
  // Anchoring on a declaration boundary stops the plain-property arm matching
  // inside a value such as `url(https://…)`, and excluding braces from the value
  // stops a match running past the end of its own block. The boundary is a
  // LOOKBEHIND on purpose: a consuming `(?:^|[;{])` swallows the `;` that ends
  // one declaration, which is the same character the next declaration needs as
  // its boundary — so every second declaration silently vanishes.
  for (const [, k, v] of flat.matchAll(
    /(?<=^|[;{])\s*(--[a-z0-9*-]+(?:--[a-z-]+)?|[a-z][a-z0-9-]*)\s*:\s*([^;{}]+);/gi,
  )) {
    out[k] = v.trim().replace(/\s+/g, " ");
  }
  return out;
};

const clean = stripComments(CSS);
const top = blocks(clean);
const pick = (re: RegExp): Block[] => top.filter((b) => re.test(b.prelude));

/** Every top-level `:root` block merged — §2.2's light values plus the
 *  theme-invariant block that follows them. */
const LIGHT = Object.assign(
  {},
  ...pick(/^:root$/).map((b) => decls(b.body)),
) as Record<string, string>;

const nested = (b: Block, selector: string): Record<string, string> => {
  const inner = blocks(b.body).find((n) => n.prelude === selector);
  if (!inner) throw new Error(`missing ${selector} inside ${b.prelude}`);
  return decls(inner.body);
};

const DARK_SYSTEM = nested(
  pick(/^@media \(prefers-color-scheme: dark\)$/)[0],
  ":root:not(.light)",
);
const DARK_CLASS = decls(pick(/^\.dark$/)[0].body);
const REDUCED = nested(pick(/^@media \(prefers-reduced-motion: reduce\)$/)[0], ":root");
const THEME_INLINE = Object.assign(
  {},
  ...pick(/^@theme inline$/).map((b) => decls(b.body)),
) as Record<string, string>;
const THEME_PLAIN = Object.assign(
  {},
  ...pick(/^@theme$/).map((b) => decls(b.body)),
) as Record<string, string>;

/** The two themes as flat lookups: dark is light with the dark block applied,
 *  which is exactly how the cascade sees it. */
const themes = {
  light: LIGHT,
  dark: { ...LIGHT, ...DARK_CLASS },
} as const;
type ThemeName = keyof typeof themes;

/** Follow `var(--ng-x)` aliases to a literal. The progress axis and chart slot 1
 *  are aliases on purpose (§2.2/§2.5) — an alias cannot drift from its source. */
const literal = (name: string, theme: ThemeName, hops = 0): string => {
  const raw = themes[theme][name];
  if (raw === undefined) throw new Error(`token ${name} is not defined in ${theme}`);
  if (hops > 4) throw new Error(`token ${name} aliases in a cycle`);
  const alias = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  return alias ? literal(alias[1], theme, hops + 1) : raw;
};

/* ── WCAG 2.1 relative luminance ────────────────────────────────────────── */
const channel = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const luminance = (hex: string): number => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not an opaque hex colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(m[1].slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Rounded to 2dp, the precision §2.2 tabulates. */
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

const ratio = (fg: string, bg: string, theme: ThemeName): number =>
  contrast(literal(`--ng-${fg}`, theme), literal(`--ng-${bg}`, theme));

/* ── the token inventory the brief names ────────────────────────────────── */

/** §2.2 — every token whose VALUE differs per theme. */
const THEME_VARYING = [
  "sunken",
  "canvas",
  "surface",
  "raised",
  "text",
  "text-2",
  "text-3",
  "border-faint",
  "border",
  "border-strong",
  "border-control",
  ...["danger", "safe", "error", "accent"].flatMap((f) => [
    f,
    `${f}-text`,
    `${f}-border`,
    `${f}-wash`,
    `${f}-on`,
  ]),
  "series-2",
  "series-3",
  // §2.6
  "shadow-sm",
  "shadow-card",
  "shadow-pop",
  "shadow-modal",
  "scrim",
].map((n) => `--ng-${n}`);

/** §2.2 progress axis + §2.5 slot 1 — same in both themes because they alias. */
const INVARIANT = [
  "progress-ink",
  "progress-idle",
  "progress-track",
  "progress-mark",
  "progress-hatch",
  "series-1",
  ...[100, 200, 300, 400, 500, 600, 700, 800].map((s) => `seq-${s}`),
  // §2.7
  "font-sans",
  "font-mono",
  // §2.8
  ...["0-5", 1, "1-5", 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24].map((s) => `space-${s}`),
  "border-hairline",
  "border-emphasis",
  "border-rule",
  "h-control-sm",
  "h-control",
  "h-control-lg",
  "h-row-dense",
  "h-row",
  "h-row-comfy",
  "h-topbar",
  "size-icon-sm",
  "size-icon",
  "size-icon-lg",
  "tap-min",
  "focus-ring",
  // §2.9
  "dur-press",
  "dur-fast",
  "dur-base",
  "dur-enter",
  "dur-exit",
  "dur-reveal",
  "dur-crossfade",
  "stagger",
  "ease-out",
  "ease-in",
  "ease-std",
  "hatch-stroke",
  "hatch-pitch",
].map((n) => `--ng-${n}`);

describe("C1 completeness", () => {
  it("C1: every theme-varying token from §2.2/§2.6 exists in light", () => {
    for (const t of THEME_VARYING) expect(LIGHT, t).toHaveProperty(t);
  });

  it("C1: …and in dark. A hole inherits the LIGHT value", () => {
    // Which for `--ng-text` would be #22201c ink on a #100f0d canvas: 1.19:1,
    // i.e. invisible. There is no partial dark theme.
    for (const t of THEME_VARYING) {
      expect(DARK_CLASS, t).toHaveProperty(t);
      expect(DARK_SYSTEM, t).toHaveProperty(t);
    }
  });

  it("C1: the dark blocks add nothing light does not declare", () => {
    // A dark-only token is a token no light-mode reader can resolve.
    for (const t of Object.keys(DARK_CLASS)) {
      if (t === "color-scheme") continue;
      expect(LIGHT, t).toHaveProperty(t);
    }
  });

  it("C1: every theme-invariant token from §2.2/§2.5/§2.7/§2.8/§2.9 exists", () => {
    for (const t of INVARIANT) expect(LIGHT, t).toHaveProperty(t);
  });

  it("C1: §2.7's type scale is complete and closed at both ends", () => {
    const steps = [
      "2xs",
      "xs",
      "sm",
      "base",
      "md",
      "lg",
      "xl",
      "2xl",
      "3xl",
      "4xl",
      "5xl",
      "figure",
    ];
    for (const s of steps) {
      expect(THEME_PLAIN, `--text-${s}`).toHaveProperty(`--text-${s}`);
      // A size with no line height inherits 1.5 from preflight, which is wrong
      // for every step in this scale.
      expect(THEME_PLAIN, `--text-${s}--line-height`).toHaveProperty(
        `--text-${s}--line-height`,
      );
    }
  });

  it("C1: §2.8's radii ladder is complete", () => {
    for (const r of ["xs", "sm", "md", "lg", "xl"]) {
      expect(THEME_PLAIN, `--radius-${r}`).toHaveProperty(`--radius-${r}`);
    }
  });

  it("C1: the §2.8 spacing ladder is derived from --spacing, not restated", () => {
    // `var(--ng-space-4)` and `p-4` must be the same number by construction:
    // two px ladders would drift the first time one of them was edited.
    for (const [name, mult] of [
      ["--ng-space-0-5", "0.5"],
      ["--ng-space-4", "4"],
      ["--ng-space-24", "24"],
    ] as const) {
      expect(LIGHT[name]).toBe(`calc(var(--spacing) * ${mult})`);
    }
  });
});

describe("C2 the two dark blocks cannot drift", () => {
  it("C2: `prefers-color-scheme: dark` and `.dark` declare identical values", () => {
    expect(DARK_SYSTEM).toStrictEqual(DARK_CLASS);
  });

  it("C2: both set color-scheme so UA widgets follow the theme", () => {
    expect(DARK_SYSTEM["color-scheme"]).toBe("dark");
    expect(DARK_CLASS["color-scheme"]).toBe("dark");
    expect(LIGHT["color-scheme"]).toBe("light");
  });
});

describe("C3 contrast, recomputed from the hexes in the file", () => {
  /* §2.2 text table — light / dark, against all four surfaces. */
  const TEXT: ReadonlyArray<readonly [string, string, number, number]> = [
    ["text", "canvas", 15.59, 17.43],
    ["text", "surface", 16.26, 16.18],
    ["text", "sunken", 14.65, 18.1],
    ["text", "raised", 16.26, 14.47],
    ["text-2", "canvas", 6.94, 9.01],
    ["text-2", "surface", 7.24, 8.36],
    ["text-2", "sunken", 6.53, 9.35],
    ["text-2", "raised", 7.24, 7.48],
    ["text-3", "canvas", 4.97, 5.84],
    ["text-3", "surface", 5.18, 5.42],
    ["text-3", "sunken", 4.67, 6.07],
    ["text-3", "raised", 5.18, 4.85],
  ];

  it.each(TEXT)("C3: %s on %s is %f light / %f dark, and clears 4.5:1", (fg, bg, l, d) => {
    expect(ratio(fg, bg, "light")).toBe(l);
    expect(ratio(fg, bg, "dark")).toBe(d);
    expect(ratio(fg, bg, "light")).toBeGreaterThanOrEqual(4.5);
    expect(ratio(fg, bg, "dark")).toBeGreaterThanOrEqual(4.5);
  });

  it("C3: the muted step is legal for body text on EVERY surface", () => {
    // §2.2: text-3 is deliberately still legal for body text, because in a
    // product full of dense tables the muted step inevitably carries real
    // content — versions, timestamps, paths. Its worst pair is 4.67:1 on
    // sunken in light mode; one step lighter measured 4.03:1 and failed.
    for (const theme of ["light", "dark"] as const) {
      for (const bg of ["canvas", "surface", "sunken", "raised"]) {
        expect(ratio("text-3", bg, theme), `text-3 on ${bg} (${theme})`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    }
  });

  /* §2.2 semantic table. */
  const SEMANTIC: ReadonlyArray<readonly [string, string, number, number, number]> = [
    ["danger-text", "canvas", 4.5, 7.18, 8.62],
    ["danger-text", "surface", 4.5, 7.49, 8.0],
    ["danger-text", "danger-wash", 4.5, 6.71, 6.94],
    ["danger", "canvas", 3.0, 5.25, 3.75],
    ["danger-on", "danger", 4.5, 5.47, 5.11],
    ["safe-text", "canvas", 4.5, 7.35, 10.75],
    ["safe-text", "surface", 4.5, 7.66, 9.98],
    ["safe-text", "safe-wash", 4.5, 7.01, 8.53],
    ["safe", "canvas", 3.0, 4.99, 6.52],
    ["safe-on", "safe", 4.5, 5.21, 6.52],
    ["error-text", "canvas", 4.5, 7.7, 9.83],
    ["error-text", "surface", 4.5, 8.03, 9.12],
    ["error-text", "error-wash", 4.5, 7.3, 7.8],
    ["error", "canvas", 3.0, 5.76, 5.77],
    ["error-on", "error", 4.5, 6.0, 5.77],
    ["accent-text", "canvas", 4.5, 7.12, 9.77],
    ["accent-text", "surface", 4.5, 7.43, 9.06],
    ["accent", "canvas", 3.0, 5.38, 5.47],
    ["accent-on", "accent", 4.5, 5.62, 5.47],
  ];

  it.each(SEMANTIC)(
    "C3: %s on %s needs %f, measures %f light / %f dark",
    (fg, bg, req, l, d) => {
      expect(ratio(fg, bg, "light")).toBe(l);
      expect(ratio(fg, bg, "dark")).toBe(d);
      expect(ratio(fg, bg, "light")).toBeGreaterThanOrEqual(req);
      expect(ratio(fg, bg, "dark")).toBeGreaterThanOrEqual(req);
    },
  );

  it("C3: `on` is a token because white is NOT universally legal on a fill", () => {
    // White on the dark safe mark (#37aa70) is 2.94:1 — a fail. That single
    // fact is why §2.2 ships an `on` step per semantic instead of letting
    // components write `text-white`, and why safe/error/accent flip to
    // near-black ink in dark while danger keeps white (its mark is a full
    // lightness step darker by design, §2.3).
    expect(contrast("#ffffff", literal("--ng-safe", "dark"))).toBeLessThan(4.5);
    expect(literal("--ng-danger-on", "dark")).toBe("#ffffff");
    for (const f of ["safe", "error", "accent"]) {
      expect(literal(`--ng-${f}-on`, "dark")).toBe("#100f0d");
    }
  });

  it("C3: `border-control` clears 3:1 for non-text controls (WCAG 1.4.11)", () => {
    expect(ratio("border-control", "surface", "light")).toBe(3.37);
    expect(ratio("border-control", "surface", "dark")).toBe(3.23);
    expect(ratio("border-control", "canvas", "light")).toBe(3.23);
    expect(ratio("border-control", "canvas", "dark")).toBe(3.48);
  });

  it("C3: the decorative hairline does NOT clear 3:1 — and must never stand alone", () => {
    // §2.2 states 1.31–1.43:1 and calls it intentional. Asserting the ceiling
    // keeps someone from "improving" `--ng-border` into control territory,
    // which would erase the distinction the control token exists to draw.
    for (const theme of ["light", "dark"] as const) {
      for (const bg of ["surface", "canvas"]) {
        const r = ratio("border", bg, theme);
        expect(r, `border on ${bg} (${theme})`).toBeLessThan(3);
        expect(r).toBeGreaterThanOrEqual(1.3);
      }
    }
  });

  it("C3: §2.8's focus ring is legible in both themes", () => {
    // The ring is accent-on-canvas; §2.8 states 5.38 / 5.47 against a 3:1 floor.
    expect(ratio("accent", "canvas", "light")).toBe(5.38);
    expect(ratio("accent", "canvas", "dark")).toBe(5.47);
    expect(LIGHT["--ng-focus-ring"]).toBe(
      "0 0 0 2px var(--ng-canvas), 0 0 0 4px var(--ng-accent)",
    );
  });

  it("C3: §2.5's sequential ramp matches its stated contrast in both themes", () => {
    const stated: Record<number, readonly [number, number]> = {
      100: [1.18, 15.58],
      200: [1.42, 12.91],
      300: [1.79, 10.25],
      400: [2.38, 7.72],
      500: [3.36, 5.47],
      600: [4.78, 3.84],
      700: [6.92, 2.66],
      800: [9.71, 1.89],
    };
    for (const [step, [l, d]] of Object.entries(stated)) {
      expect(ratio(`seq-${step}`, "canvas", "light"), `seq-${step} light`).toBe(l);
      expect(ratio(`seq-${step}`, "canvas", "dark"), `seq-${step} dark`).toBe(d);
    }
    // The ORDINAL rule §2.5 states: light starts no lighter than 300, dark goes
    // no darker than 600, because the step nearest the surface must clear 2:1.
    expect(ratio("seq-300", "canvas", "light")).toBeLessThan(2);
    expect(ratio("seq-600", "canvas", "dark")).toBeGreaterThan(2);
  });
});

describe("C4 the mapping is a schema, not a convention", () => {
  it("C4: every @theme key resolves to a primitive that exists", () => {
    for (const [key, value] of Object.entries(THEME_INLINE)) {
      const refs = [...value.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);
      expect(refs.length, `${key} must alias a primitive`).toBeGreaterThan(0);
      for (const ref of refs) expect(LIGHT, `${key} -> ${ref}`).toHaveProperty(ref);
    }
  });

  it("C4: every colour primitive is reachable as a utility", () => {
    // The inverse direction: a token nobody can spell is a token that does not
    // exist. `--ng-focus-ring` is the one deliberate exception — it is a
    // box-shadow list applied once in base.css, not a colour a component picks.
    const exempt = new Set(["--ng-focus-ring"]);
    const mapped = new Set(
      Object.values(THEME_INLINE).flatMap((v) =>
        [...v.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]),
      ),
    );
    const isColour = (v: string) => /^(#[0-9a-f]{3,8}|rgb\(|oklch\(|var\(--ng-)/i.test(v);
    for (const [name, value] of Object.entries(LIGHT)) {
      if (!name.startsWith("--ng-") || exempt.has(name) || !isColour(value)) continue;
      // Shadows and the progress aliases both pass `isColour`; shadows are
      // mapped too, so the assertion holds for all of them.
      expect(mapped, `${name} is not mapped into a Tailwind namespace`).toContain(name);
    }
  });

  it("C4: the semantic set is five steps wide for all four families", () => {
    for (const f of ["danger", "safe", "error", "accent"]) {
      for (const step of ["", "-text", "-border", "-wash", "-on"]) {
        expect(THEME_INLINE, `--color-${f}${step}`).toHaveProperty(`--color-${f}${step}`);
      }
    }
  });

  it("C4: the progress axis is achromatic BY ALIAS, not by a copied hex", () => {
    // §0 rule 2: only outcomes get colour. Aliasing to the neutral ink steps is
    // what makes it impossible for a future edit to tint "running" green — you
    // would have to retype the alias to do it.
    expect(LIGHT["--ng-progress-ink"]).toBe("var(--ng-text-2)");
    expect(LIGHT["--ng-progress-idle"]).toBe("var(--ng-text-3)");
    expect(LIGHT["--ng-progress-track"]).toBe("var(--ng-border-faint)");
    expect(LIGHT["--ng-progress-hatch"]).toBe("var(--ng-border-strong)");
    // The single exception, and it is confined to a spinner's moving arc.
    expect(LIGHT["--ng-progress-mark"]).toBe("var(--ng-accent)");
  });

  it("C4: chart slot 1 IS the accent, and there is no slot 4", () => {
    expect(LIGHT["--ng-series-1"]).toBe("var(--ng-accent)");
    expect(THEME_INLINE).not.toHaveProperty("--color-series-4");
    expect(LIGHT).not.toHaveProperty("--ng-series-4");
  });
});

describe("C5 the vocabulary is closed", () => {
  it("C5: Tailwind's default palette is cleared", () => {
    // Without this, `bg-red-500` compiles and §6's "no raw hex outside the
    // token block" is only a review item.
    expect(THEME_PLAIN["--color-*"]).toBe("initial");
  });

  it("C5: only the structural colour keywords survive the clear", () => {
    expect(THEME_PLAIN["--color-transparent"]).toBe("transparent");
    expect(THEME_PLAIN["--color-current"]).toBe("currentColor");
    expect(THEME_PLAIN["--color-inherit"]).toBe("inherit");
    // `white` and `black` are NOT restored: §2.2 makes ink-on-a-fill a token
    // (`*-on`) precisely because white is illegal on three of the four dark
    // marks, and the scrim owns its own per-theme alpha.
    expect(THEME_PLAIN).not.toHaveProperty("--color-white");
    expect(THEME_PLAIN).not.toHaveProperty("--color-black");
    expect(THEME_INLINE).toHaveProperty("--color-scrim");
  });

  it("C5: D-8 — no serif, enforced rather than remembered", () => {
    expect(THEME_PLAIN["--font-serif"]).toBe("initial");
    // A cleared namespace must NAME the thing it clears, so `--font-serif:
    // initial` is the enforcement and not a violation of it. Skipping `initial`
    // declarations is what makes the two halves of this test consistent: the
    // first asserts the clear exists, the loop asserts no LIVE serif or display
    // token does. Without the skip, the assertion contradicted itself.
    for (const [key, value] of Object.entries({ ...THEME_INLINE, ...THEME_PLAIN, ...LIGHT })) {
      if (value === "initial") continue;
      expect(key, "a third voice competes with the mono signal").not.toMatch(
        /(display|serif)/,
      );
    }
  });

  it("C5: off-scale type, radii and shadows are cleared", () => {
    for (const s of ["6xl", "7xl", "8xl", "9xl"]) {
      expect(THEME_PLAIN[`--text-${s}`], `--text-${s}`).toBe("initial");
    }
    for (const r of ["2xl", "3xl", "4xl"]) {
      expect(THEME_PLAIN[`--radius-${r}`], `--radius-${r}`).toBe("initial");
    }
    for (const s of ["2xs", "xs", "md", "lg", "xl", "2xl"]) {
      expect(THEME_PLAIN[`--shadow-${s}`], `--shadow-${s}`).toBe("initial");
    }
  });

  it("C5: §2.9's three eases, and no bounce for either verdict", () => {
    expect(THEME_INLINE["--ease-out"]).toBe("var(--ng-ease-out)");
    expect(THEME_INLINE["--ease-in"]).toBe("var(--ng-ease-in)");
    expect(THEME_INLINE["--ease-std"]).toBe("var(--ng-ease-std)");
    expect(THEME_PLAIN["--ease-in-out"]).toBe("initial");
    expect(THEME_PLAIN["--animate-bounce"]).toBe("initial");
  });

  it("C5: nothing in the token layer is a bare hex outside a primitive block", () => {
    // The mapping must never inline a literal: a hex in `@theme` would be the
    // same value in both themes, which is the bug `@theme inline` prevents.
    for (const [key, value] of Object.entries(THEME_INLINE)) {
      expect(value, `${key} inlines a literal instead of aliasing`).not.toMatch(/#[0-9a-f]{3}/i);
    }
  });
});

describe("C6 the known exceptions, pinned", () => {
  it("C6: light-mode chart slot 3 is 2.70:1 — legal only under the relief rule", () => {
    // §2.5 flags this itself: aqua on the light canvas is below 3:1, so
    // whenever it is used in light mode visible direct labels or the table view
    // must be present. Do not "fix" the hex — it is chosen for CVD separation
    // from slots 1 and 2 (worst dE 9.2), and darkening it collapses that.
    expect(ratio("series-3", "canvas", "light")).toBe(2.7);
    expect(ratio("series-3", "canvas", "dark")).toBeGreaterThanOrEqual(3);
    expect(ratio("series-1", "canvas", "light")).toBeGreaterThanOrEqual(3);
    expect(ratio("series-2", "canvas", "light")).toBeGreaterThanOrEqual(3);
  });

  it("C6: the `*-border` steps sit at 1.71–2.01 against their own wash", () => {
    // §2.2: intentional and legal. They are decoration on a surface whose
    // meaning is carried by a glyph and a word at 6.7–8.5:1, and they are never
    // the sole indicator of anything — interactive boundaries use
    // `border-control`, which is separately asserted at >= 3:1 above.
    for (const theme of ["light", "dark"] as const) {
      for (const f of ["danger", "safe", "error", "accent"]) {
        const r = ratio(`${f}-border`, `${f}-wash`, theme);
        expect(r, `${f}-border on wash (${theme})`).toBeGreaterThanOrEqual(1.71);
        expect(r, `${f}-border on wash (${theme})`).toBeLessThanOrEqual(2.01);
      }
    }
  });

  it("C6: dark `danger` is a full lightness step below `safe` — deliberately", () => {
    // §2.3: equal-lightness red and green are exactly what deuteranopia cannot
    // separate. Raising danger to match safe would look tidier and would move
    // dark-mode CVD separation from a passing dE 9.9 back to a failing 5.8.
    expect(ratio("danger", "canvas", "dark")).toBeLessThan(ratio("safe", "canvas", "dark"));
    expect(ratio("danger", "canvas", "dark")).toBeGreaterThanOrEqual(3);
  });
});

describe("C7 reduced motion", () => {
  it("C7: every duration goes to 0ms", () => {
    for (const d of ["press", "fast", "base", "enter", "exit", "reveal"]) {
      expect(REDUCED[`--ng-dur-${d}`], `--ng-dur-${d}`).toBe("0ms");
    }
    expect(REDUCED["--ng-stagger"]).toBe("0ms");
  });

  it("C7: …except the content crossfade, which holds at 80ms", () => {
    // §2.9: opacity-only, so a swap doesn't read as a glitch. A blanket
    // `animation: none` would flatten this exception, which is why the override
    // is done on the TOKENS and not on the rules.
    expect(REDUCED).not.toHaveProperty("--ng-dur-crossfade");
    expect(LIGHT["--ng-dur-crossfade"]).toBe("80ms");
  });

  it("C7: a bare `transition` spends the token, so it complies for free", () => {
    expect(THEME_INLINE["--default-transition-duration"]).toBe("var(--ng-dur-base)");
  });
});
