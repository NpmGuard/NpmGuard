# NpmGuard v3 — Visual Design Direction

_Status: design deliverable. Satisfies the design phase that R-6 of
`2026-07-24-platform-v3-system-design.md` says must precede the component build.
Substrate is already decided (D-3) and is not re-litigated here: **Tailwind v4
CSS-first `@theme` + shadcn-vendored Radix + a project design-system layer.**_

**What this document is:** the visual point of view, a complete token
specification with both themes and stated contrast ratios, the component
inventory with its Radix backing, wireframes for the two hardest screens, and an
explicit list of what still needs a human's taste.

**What it is not:** code. No component is implemented here. The build phase
should be mechanical after this.

---

## 0. The one constraint that drives everything else

Read §4.4 of the system design and the visual problem states itself:

> `SAFE` — audit concluded; no confirmed threat.
> `DANGEROUS` — audit concluded; ≥1 confirmed hypothesis or a dealbreaker.
> `ERROR` — the audit **could not conclude**. "NOT maybe unsafe. NOT not checked
> yet. We tried and failed — and that is a fact worth showing."

A security tool's UI can fail in two directions, and they are not symmetric.
Missing a threat is a product failure. **Overstating a clean result is a
credibility failure, and credibility is the whole product.** `SAFE` does not mean
"this package is safe." It means "this audit found nothing it could confirm."
The design's job is to make that distinction impossible to miss, on every surface,
without turning every green result into a wall of disclaimers.

Three rules follow, and they are load-bearing for the rest of this document:

1. **SAFE is the quietest state in the system, not the loudest.** No filled green
   banners, no checkmark celebration, no confetti, no "You're protected!" A SAFE
   verdict is stated flatly and is always accompanied by its coverage counts. The
   loud color is reserved for `DANGEROUS`, which is the only state that earns
   alarm.
2. **Progress is achromatic.** The progress axis (`unaudited → queued → running →
   concluded`) gets no hue at all — neutral ink plus motion. Only *outcomes* get
   color. This encodes the two-axis model in the palette itself, so the old
   `UNKNOWN` conflation cannot be re-expressed visually even by accident. It also
   solved a real accessibility failure (see §2.3).
3. **"We could not conclude" gets its own reserved hue, and it is shared with UI
   degradation.** Audit `ERROR` and a failed sub-fetch (N-3) are the same fact
   from the user's side: *we don't know.* They share one semantic slot. Red never
   appears unless NpmGuard is making a claim about a package. The UI can therefore
   never cry wolf about its own plumbing.

---

## 1. Three directions

Three genuinely different theses about where credibility comes from. They are not
three palettes; they imply different component emphasis and different information
hierarchy.

### Direction A — "Case File" · the UI is a *record*

**Thesis.** Credibility comes from looking like a document that could be handed to
an auditor. The interface is a laboratory record: warm-neutral paper and ink,
hairline rules instead of boxes and shadows, monospace for every
machine-authored fact, a serif voice on the static explanatory surfaces, verdicts
rendered as *stamps* rather than badges, and evidence rendered as *citations* with
provenance and timestamps. Chrome recedes to near-nothing so the content is the
design. Density is high but the rhythm is typographic, not gridded.

**What it signals.** Rigor, restraint, accountability. "This is a finding, not a
pitch." It reads as something with a paper trail behind it.

**References found.** [Vercel's deployment log](https://mobbin.com/screens/57050b5a-de61-4735-b2f9-44cde31df42a)
— muted timestamp gutter, monospace body, collapsible summary sections whose
headers carry count pills (`All 42 · 1 · 8s ✓`); severity communicated by
[tinting the whole log row](https://mobbin.com/screens/d4bd289f-0040-4309-80d1-04dcf528e4c2)
rather than adding an icon column, with an `All Logs (21) / Errors (2) /
Warnings (1)` filter strip. [Vanta's Policies table](https://mobbin.com/screens/7f317ce6-2e6e-4fb2-929d-c8de5b2c2f75)
— hairline rows, a `Dense / Regular / Comfortable` density control and per-column
visibility toggles in one dropdown. [Cohere's fine-tune metrics](https://mobbin.com/screens/dd89e83a-58b4-4483-9b75-b41581b17c6b)
— every metric card carries a one-sentence definition of what the number means
("Accuracy — Correct predictions across all predictions made"), which is the
honest-metric pattern `/benchmark` needs. [Antimetal](https://mobbin.com/sites/sections/38557cd6-0834-4d5a-b186-89ac968d8332)
and [Frontify](https://mobbin.com/sites/sections/67380933-75aa-40ed-b13c-617db6250c9c)
for the near-monochrome, light-weight-display-type marketing register.

**Risk.** Under-designed to a non-technical evaluator — a VP who sees it next to
Snyk may read restraint as unfinished. Hairline-only separation can go muddy in
dark mode if the surface steps are too close. And there is no obvious visual hook
for the landing page, so `/` has to earn attention with the live replay rather
than with graphics.

### Direction B — "Control Room" · the UI is an *instrument*

**Thesis.** Credibility comes from looking like continuous operational
monitoring. Cool graphite base, one restrained cyan "reading" accent, a strict
gridded layout, status indicators as LEDs, sparklines and meters on every card,
rollups everywhere. The live audit reads as a scope trace. The dashboard is the
centre of gravity and every other surface is a view into it.

**What it signals.** Vigilance, scale, always-on. "Your supply chain is under
watch."

**References found.** [Vapi's Issues console](https://mobbin.com/screens/9afecd03-c74c-41b9-b1f3-a4eee7089c21)
— genuinely good dark security-ops chrome: `Critical 0 / MTTR —` tiles,
two-column category list with colored dots, a centered empty state with a ringed
glyph and one action. [GitLab's security dashboard](https://mobbin.com/screens/83a4d831-a8b2-4240-b322-02aec38ec666)
— severity rows with dot + label + bar, and projects graded by *highest severity
present*, which is precisely the max-severity rollup F-C5 specifies.
[Cloudflare Security Insights](https://mobbin.com/screens/53f8867e-f2e8-4451-a58d-a2f2a3cf35d7)
— `Last scan performed on: 18 Feb 2025 13:42:51` with an inline `Scan now`
(exactly the dead `lastScan` field F-C7 wants back), plus a single segmented
severity ribbon. [Vanta's home](https://mobbin.com/screens/eaeda897-a742-4213-834c-7025bcf3c7c1)
— `Needs attention 14` over a meter over `1 OK / 15 total`, the plan/usage meter
pattern. [Replit](https://mobbin.com/screens/65647ca7-bef2-49e2-af15-37feb7056049)
— horizontal segmented phase bar (`Provision ✓ / Build ◐ / Promote ○`) above a
dark log pane.

**Risk.** This is the most crowded look in the category — Vapi, Cloudflare,
GitLab and every observability vendor already live here, so it buys zero
differentiation and invites direct feature comparison on incumbents' turf. Worse,
the instrument metaphor *overpromises*: continuous monitoring is true only for
Protect-enabled repos, not for a one-off paid audit. And "everything is a gauge"
creates constant pressure to synthesize a score or a grade out of data that does
not support one — the exact N-3 / overstatement failure mode.

### Direction C — "Proof Terminal" · the UI is a *transcript*

**Thesis.** Credibility comes from putting nothing between the user and the raw
machine output. Near-black canvas, monospace for *everything* including display
type, the log and the code are the primary visual artifacts, chrome reduced to a
thin frame, keyboard-first with a command palette as primary navigation. The
report is a transcript you scroll, not a document you read.

**What it signals.** CLI-native, no-marketing, "read it yourself."

**References found.** [Height](https://mobbin.com/sites/sections/4661d2d5-6de0-4c89-abe6-79f1d910ef02)
and [Resend](https://mobbin.com/sites/sections/3e29d44f-de0b-4b87-8d3e-f913f7651e5b)
— near-black pages where a code window *is* the hero.
[Linear](https://mobbin.com/sites/sections/038755ae-4b0f-4e25-a7df-dca35d71d6bc)
— `⌘K` elevated to the headline proposition.
[Render](https://mobbin.com/screens/1b400c9e-2ebe-45ad-9d14-83dca9bbd425) — a
dark log pane with `Live tail` and in-log search embedded in otherwise light
chrome. [Braintrust](https://mobbin.com/screens/aaaf6c4e-7a6d-4670-8299-ac3098661c84)
— dense rows with whole-row error tinting plus a trace-tree drawer showing each
span's duration, which is the closest reference to drilling into a hypothesis'
evidence.

**Risk.** Three problems, one of them disqualifying. (a) It structurally fights
the light-mode constraint — a transcript aesthetic rendered light is just a beige
terminal, so light mode becomes the second-class citizen we were explicitly told
to avoid. (b) Monospace display type wrecks `/how-it-works`, which is prose-heavy
and is one of the three legs of the credibility triangle. (c) "Raw output" gives
you no vocabulary for *confidence calibration* — a transcript can show you what
happened but has no natural way to say "this is what we could not determine,"
which is the single thing this product must say well. It also reads as costume to
the engineering-lead half of the audience.

### Recommendation: **Direction A — "Case File"**

**Why A over B.** B optimizes the dashboard, but §6.4 says the dashboard is the
*last* surface a new user meets. The funnel is `/scan` → results and `/replays` →
`/audit/:id`; the credibility triangle is `/how-it-works` + `/replays` +
`/benchmark`. Four of those five are document-shaped surfaces where a record
aesthetic is native and an instrument aesthetic is a costume. B also fails the §0
constraint in two specific ways: its metaphor implies continuous monitoring for
products that are one-off, and its gauge-density pressures the UI toward
synthesized scores. Finally, B is a commodity look — adopting it means being
compared to Snyk and Socket on visual terms where we have nothing new to say.

**Why A over C.** C is the most epistemically honest of the three and I want to
keep its instincts, but as a *whole-product* direction it breaks a hard
constraint (light mode as a first-class citizen) and it damages the surface that
does the most persuasive work in prose. C's real contribution — that the log and
the code should be shown at full fidelity, unsummarized — survives inside A as
the code-viewer and log-pane components, which A renders as *exhibits inside a
document* rather than as the document itself.

**What A takes from the other two, explicitly.** From B: the density discipline,
the segmented rollup ribbon, the `last scan · scan now` header pattern, and the
plan/usage meter. From C: full-fidelity monospace log and code panes, and
keyboard-first navigation with a command palette. What A *rejects* from B: the
cool-graphite palette, accent-as-glow, LED status dots as the primary status
channel, and any synthesized grade. What A rejects from C: monospace display
type, and dark-as-default.

**What survives from the current app.** Two things, conceptually, and they were
the good parts: the **tone-quad structure** (every semantic ships as
`wash / border / ink / mark` rather than a single hex — kept, and extended with
an `on-` step for text on fills), and the **hairline-first aesthetic** (kept, and
now given a proper 3:1 control-border token it was missing). What does not
survive: the light-only assumption, the warm-paper-only palette, the
four-state verdict tone map, and per-page stylesheets.

---

## 2. Token specification

> **Value authority moved.** This section's *structure* stands: the token
> inventory, the five-step semantic shape, the contrast floors, the CVD
> methodology, the motion and spacing ladders, and every enforcement mechanism.
> The palette *values* and the two faces were later re-authored into the
> paper-and-lacquer identity — warm cream light theme, lacquer-brown dark theme
> with a gold accent, Space Grotesk + JetBrains Mono — and
> `frontend/src/styles/tokens.css` is the authority for values.
> `token-contract.test.ts` recomputes this section's floors against whatever
> values that file holds, so the floors bind without the hexes below needing to
> match. Where a hex in this section disagrees with `tokens.css`, the CSS wins.

### 2.1 How this maps onto Tailwind v4

Semantic values must change per theme, so the primitives live in scoped custom
properties and `@theme inline` maps them into utility generation. `@theme inline`
(not plain `@theme`) is required — it makes the generated utilities reference
`var(--canvas)` rather than copying its value, which is what lets one class work
in both themes.

```css
@import "tailwindcss";

/* shadcn-compatible: class-based override, with a system default and a
   `.light` escape hatch so an explicit light stamp beats OS dark. */
@custom-variant dark (&:where(.dark, .dark *));

:root {
  color-scheme: light;
  /* …light values (§2.2) … */
}

@media (prefers-color-scheme: dark) {
  :root:not(.light) {
    color-scheme: dark;
    /* …dark values… */
  }
}

.dark {
  color-scheme: dark;
  /* …dark values… */
}

@theme inline {
  --color-canvas:  var(--canvas);
  --color-surface: var(--surface);
  /* …one line per token… */
}
```

All colors are authored in OKLCH (perceptually uniform lightness, which is what
makes the two themes derivable rather than guessed) and shipped as hex for
predictability. The OKLCH triple is retained in a comment on every token so the
next person can re-step a ramp instead of eyedropping it.

### 2.2 Color — light and dark

Contrast ratios below are computed WCAG 2.1 values, not estimates. **Body text
requires ≥ 4.5:1; large text (≥ 24px, or ≥ 19px bold) and non-text UI marks
require ≥ 3:1.** Every text pair in this table passes AA.

#### Surfaces — four elevation levels

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-sunken` | `#f4f3f0` | `#0a0908` | Recessed: log panes, code blocks, table headers, inset wells |
| `--color-canvas` | `#fbfaf8` | `#100f0d` | The page plane |
| `--color-surface` | `#ffffff` | `#181816` | Cards, panels, table body — elevation 1 |
| `--color-raised` | `#ffffff` | `#23221f` | Popovers, dropdowns, dialogs, tooltips — elevation 2 |

```css
/* light */
--sunken:  #f4f3f0; /* oklch(0.964 0.0045 95) */
--canvas:  #fbfaf8; /* oklch(0.986 0.0030 95) */
--surface: #ffffff; /* oklch(1.000 0      95) */
--raised:  #ffffff; /* oklch(1.000 0      95) */
/* dark */
--sunken:  #0a0908; /* oklch(0.142 0.0040 95) */
--canvas:  #100f0d; /* oklch(0.170 0.0040 95) */
--surface: #181816; /* oklch(0.208 0.0045 95) */
--raised:  #23221f; /* oklch(0.252 0.0050 95) */
```

Two decisions worth naming. **Hue 95 at chroma ≤ 0.005 in both themes** — a
barely-perceptible warmth that survives into dark mode, so dark reads as "ink and
paper at night" rather than as a console. This is the single cheapest
differentiator from every cool-graphite competitor, and it costs nothing. Second:
in light mode elevation rises *toward white* while inset elements go *darker*; in
dark mode **elevation is carried by the surface step and the hairline, not by
shadow** — shadows are nearly invisible on a `#100f0d` canvas, so dark mode gets a
1px inset top highlight instead (§2.6).

#### Text

| Token | Light | Dark | vs canvas | vs surface | vs sunken | vs raised |
|---|---|---|---|---|---|---|
| `--color-text` | `#22201c` | `#f5f4f2` | 15.59 / 17.43 | 16.26 / 16.18 | 14.65 / 18.10 | 16.26 / 14.47 |
| `--color-text-2` | `#585752` | `#b2b2ae` | 6.94 / 9.01 | 7.24 / 8.36 | 6.53 / 9.35 | 7.24 / 7.48 |
| `--color-text-3` | `#6e6d68` | `#8f8e8a` | 4.97 / 5.84 | 5.18 / 5.42 | 4.67 / 6.07 | 5.18 / 4.85 |

(light / dark, all `:1`.) `--color-text-3` is the muted step and is the tightest
in the system — 4.67:1 at its worst, on sunken in light mode. It was originally
one step lighter and measured **4.03:1, which fails**; it is darkened
specifically to clear AA on the sunken surface. It is deliberately still legal
for body text, because in a product full of dense tables the "muted" step
inevitably gets used for real content (versions, timestamps, paths), and a muted
token that can't legally carry content is a trap.

#### Borders

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-border-faint` | `#ededea` | `#22211e` | Row separators inside a table |
| `--color-border` | `#dddcd9` | `#302f2c` | Default hairline: cards, panels, dividers |
| `--color-border-strong` | `#c3c2bf` | `#464541` | Emphasis dividers, active table column |
| `--color-border-control` | `#8d8c88` | `#6a6964` | **Interactive boundaries** — inputs, checkboxes, unfilled buttons |

`--color-border-control` measures **3.37:1 light / 3.23:1 dark on surface** and
**3.23:1 / 3.48:1 on canvas**, clearing WCAG 1.4.11 for non-text controls. The
decorative hairlines deliberately do not: `--color-border` is 1.31–1.43:1 and is
never the sole indicator of a control. The current app has no equivalent
distinction, which is a latent a11y bug in every input it renders.

#### Semantic set — the domain colors

Each semantic ships as five steps. `mark` is for icons, fills, chart marks and
meter bars (needs 3:1). `text` is for text on canvas/surface/wash (needs 4.5:1).
`wash` is a tinted background. `border` is the wash's hairline. `on` is text
placed *on* a `mark` fill.

```css
/* ── light ───────────────────────────────────────────────── */
--danger:        #cb2529;  /* oklch(0.545 0.200 26)  */
--danger-text:   #ab0d19;  /* oklch(0.470 0.185 26)  */
--danger-border: #ec978e;  /* oklch(0.760 0.105 26)  */
--danger-wash:   #ffefed;  /* oklch(0.966 0.020 26)  */
--danger-on:     #ffffff;

--safe:          #197c4d;  /* oklch(0.520 0.115 157) */
--safe-text:     #066039;  /* oklch(0.430 0.100 157) */
--safe-border:   #96c9a9;  /* oklch(0.790 0.070 157) */
--safe-wash:     #ebf8f0;  /* oklch(0.968 0.018 157) */
--safe-on:       #ffffff;

--error:         #7e47ba;  /* oklch(0.520 0.175 303) */
--error-text:    #6d2ea9;  /* oklch(0.455 0.185 303) */
--error-border:  #c5afe5;  /* oklch(0.790 0.080 303) */
--error-wash:    #f7f2fe;  /* oklch(0.968 0.017 303) */
--error-on:      #ffffff;

--accent:        #1566c5;  /* oklch(0.520 0.165 256) */
--accent-text:   #0052af;  /* oklch(0.455 0.165 256) */
--accent-border: #9bbdeb;  /* oklch(0.790 0.075 256) */
--accent-wash:   #ecf5ff;  /* oklch(0.968 0.019 256) */
--accent-on:     #ffffff;

/* ── dark ────────────────────────────────────────────────── */
--danger:        #ca3735;  /* oklch(0.560 0.185 26)  */
--danger-text:   #ff8e84;  /* oklch(0.780 0.150 26)  */
--danger-border: #892a27;  /* oklch(0.430 0.130 26)  */
--danger-wash:   #3c1b18;  /* oklch(0.268 0.052 26)  */
--danger-on:     #ffffff;

--safe:          #37aa70;  /* oklch(0.660 0.135 157) */
--safe-text:     #76d59f;  /* oklch(0.800 0.120 157) */
--safe-border:   #1e5d3c;  /* oklch(0.430 0.085 157) */
--safe-wash:     #0f2b1c;  /* oklch(0.262 0.045 157) */
--safe-on:       #100f0d;

--error:         #a677df;  /* oklch(0.660 0.155 303) */
--error-text:    #cfa9ff;  /* oklch(0.800 0.130 303) */
--error-border:  #5f4184;  /* oklch(0.440 0.110 303) */
--error-wash:    #2c203d;  /* oklch(0.272 0.055 303) */
--error-on:      #100f0d;

--accent:        #468ae2;  /* oklch(0.630 0.150 256) */
--accent-text:   #84bdff;  /* oklch(0.790 0.125 256) */
--accent-border: #26518a;  /* oklch(0.435 0.105 256) */
--accent-wash:   #132640;  /* oklch(0.268 0.055 256) */
--accent-on:     #100f0d;
```

#### The progress axis — explicitly achromatic

`pending` / `queued` / `running` are part of the semantic set and therefore get
tokens, but they are **neutral by construction** (§2.3). They are listed here so
nobody has to invent them:

```css
/* light */
--progress-ink:    #585752;  /* = text-2 — "queued"/"running" label            */
--progress-idle:   #6e6d68;  /* = text-3 — "unaudited" label                   */
--progress-track:  #ededea;  /* = border-faint — meter/bar track               */
--progress-mark:   #1566c5;  /* = accent — the MOVING part only (spinner arc)  */
--progress-hatch:  #c3c2bf;  /* = border-strong — 45° hatch stroke             */
/* dark */
--progress-ink:    #b2b2ae;
--progress-idle:   #8f8e8a;
--progress-track:  #22211e;
--progress-mark:   #468ae2;
--progress-hatch:  #464541;
```

`--progress-mark` is the *only* place accent appears in a status context, and it
is confined to the animated arc of a spinner — the label beside it stays neutral
ink. That confinement is what keeps "running" from ever reading as a verdict, and
it is why the accent blue never has to be distinguishable from the outcome hues in
a status column: it is never a status.

**Semantic contrast, measured** (light / dark, `:1`):

| Pair | Required | Light | Dark |
|---|---|---|---|
| `danger-text` on canvas | 4.5 | **7.18** | **8.62** |
| `danger-text` on surface | 4.5 | **7.49** | **8.00** |
| `danger-text` on `danger-wash` | 4.5 | **6.71** | **6.94** |
| `danger` mark on canvas | 3.0 | **5.25** | **3.75** |
| `danger-on` on `danger` fill | 4.5 | **5.47** | **5.11** |
| `safe-text` on canvas | 4.5 | **7.35** | **10.75** |
| `safe-text` on surface | 4.5 | **7.66** | **9.98** |
| `safe-text` on `safe-wash` | 4.5 | **7.01** | **8.53** |
| `safe` mark on canvas | 3.0 | **4.99** | **6.52** |
| `safe-on` on `safe` fill | 4.5 | **5.21** | **6.52** |
| `error-text` on canvas | 4.5 | **7.70** | **9.83** |
| `error-text` on surface | 4.5 | **8.03** | **9.12** |
| `error-text` on `error-wash` | 4.5 | **7.30** | **7.80** |
| `error` mark on canvas | 3.0 | **5.76** | **5.77** |
| `error-on` on `error` fill | 4.5 | **6.00** | **5.77** |
| `accent-text` on canvas | 4.5 | **7.12** | **9.77** |
| `accent-text` on surface | 4.5 | **7.43** | **9.06** |
| `accent` mark on canvas | 3.0 | **5.38** | **5.47** |
| `accent-on` on `accent` fill | 4.5 | **5.62** | **5.47** |

Note that `--*-on` is **white in light mode for all four semantics, but flips to
near-black ink in dark mode for safe/error/accent** (white on `#37aa70` is only
2.94:1 — a fail). Only dark `danger` keeps white, because its mark is a full
lightness step darker than the others by design (below). This asymmetry is why
`on` is a token and not a hardcoded `text-white`.

The `*-border` steps measure 1.71–2.01:1 against their own wash. That is
intentional and legal: they are decoration on a surface whose meaning is carried
by a glyph and a word at 6.7–8.5:1. They are never the sole indicator of
anything. Interactive boundaries use `--color-border-control`.

#### 2.3 The colorblind-separation finding

This is the part that changed the design, so it is worth recording rather than
burying.

The first palette had four semantic hues co-occurring in the dep table's status
column: safe green, danger red, error **violet**, and running **blue**. Run
through the `dataviz` validator:

```
[FAIL] CVD separation      worst all-pairs #1566c5↔#8146b8 ΔE 3.0 (deutan)
[FAIL] Normal-vision floor worst all-pairs #1566c5↔#8146b8 ΔE 14.1 — below 15
```

Accent-blue and error-violet were indistinguishable *even to full-color vision*,
never mind deuteranopia. Substituting an amber/ochre for violet was worse — at
the lightness needed to clear 3:1 on a light surface, ochre collapses onto red
(deutan ΔE 2.3–3.5). Forcing four chromatic status colors to simultaneously clear
3:1 on a *light* surface compresses them all into one narrow dark band, and no
hue assignment survives it.

The fix was structural, not cosmetic: **drop `running` out of the chromatic set
entirely.** A spinner asserts nothing, so it should not be colored like a verdict.
That leaves three outcome hues, which validate cleanly:

```
── light  (#cb2529, #197c4d, #7e47ba on #fbfaf8, --pairs all)
[PASS] Lightness band       all 3 inside L 0.43–0.77
[PASS] Chroma floor         all 3 >= 0.1
[WARN] CVD separation       worst #197c4d↔#cb2529 ΔE 7.8 (deutan) · tritan 13.0
[PASS] Normal-vision floor  worst #7e47ba↔#cb2529 ΔE 25.2
[PASS] Contrast vs surface  all 3 >= 3:1
→ ALL CHECKS PASS

── dark   (#ca3735, #37aa70, #a677df on #100f0d, --pairs all)
[PASS] Lightness band       all 3 inside L 0.48–0.67
[PASS] Chroma floor         all 3 >= 0.1
[PASS] CVD separation       worst #37aa70↔#ca3735 ΔE 9.9 (deutan) · tritan 14.8
[PASS] Normal-vision floor  worst #a677df↔#ca3735 ΔE 24.7
[PASS] Contrast vs surface  all 3 >= 3:1
→ ALL CHECKS PASS
```

The light-mode red↔green pair sits at deutan ΔE 7.8, inside the 6–8 warn band,
which is **legal only with secondary encoding**. That is satisfied
unconditionally: see the glyph rule in §2.4. The dark steps are not a
lightness-flip of the light ones — they were re-stepped for the dark band, and
`danger` was deliberately placed a full lightness step below `safe` and `error`
(L 0.56 vs 0.66) because equal-lightness red and green are exactly what
deuteranopia cannot separate. That single lightness offset moved dark-mode
separation from a failing 5.8 to a passing 9.9.

**Re-run the validator on any palette edit.** Do not reason about ΔE by eye:

```
node <dataviz-skill>/scripts/validate_palette.js \
  "#cb2529,#197c4d,#7e47ba" --mode light --surface "#fbfaf8" --pairs all
```

#### 2.4 The glyph rule (non-negotiable)

Because red↔green sits in the CVD warn band, and because §0 forbids
color-as-meaning anyway, **every outcome renders as glyph + word + color, in that
order of priority.** The glyphs are chosen for distinct *silhouette*, not just
distinct color:

| State | Glyph | Silhouette rationale | Color |
|---|---|---|---|
| `SAFE` | circle with a check | closed, complete | `safe`, quiet |
| `DANGEROUS` | filled octagon with `!` | the only filled polygon in the set | `danger`, loud |
| `ERROR` | circle with a diagonal slash | "no signal" — reads as absence, not severity | `error` |
| `queued` | hollow circle | empty = nothing yet | neutral |
| `running` | arc spinner | the only moving glyph | neutral + accent motion |
| `unaudited` | dashed hollow circle | dashed = not attempted | neutral, `text-3` |

Remove all color from the UI and every state is still readable. That is the test.
Icon set is **Lucide**, 1.5px stroke, sized on the `--size-icon-*` tokens; the
verdict glyphs are custom SVGs because Lucide has no filled-octagon or
slashed-circle at the silhouette distinctness this needs.

#### 2.5 Chart tokens

Status colors are **reserved** and never reused as series colors. For series work
(`/benchmark` comparisons, verdict mix over time), a separate three-slot
categorical, assigned in fixed order, never cycled:

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | blue | `#1566c5` | `#468ae2` |
| 2 | orange | `#eb6834` | `#d95926` |
| 3 | aqua | `#1baf7a` | `#199e70` |

Slot 1 is the accent step in each theme — the accent is not a status color, so
reusing it for the primary series is intentional and keeps the system's one
"interactive/system" hue consistent between chrome and charts.

Validated all-pairs in both modes: light worst CVD ΔE 9.2, normal-vision 27.0;
dark worst CVD ΔE 9.4, normal-vision 20.2. Both **pass**. One caveat the
validator flagged: light-mode aqua measures **2.7:1** on canvas — below 3:1 — so
the **relief rule** applies whenever it is used in light mode: visible direct
labels or the table view must be present. **Three series is the cap.** A fourth
category folds into "Other", facets into small multiples, or the chart becomes a
table. There is no slot 4; do not generate one.

Sequential ramp (single hue, blue, for magnitude — dep counts, latency heat):

| Step | Hex | vs light canvas | vs dark canvas |
|---|---|---|---|
| 100 | `#dbe9fc` | 1.18 | 15.58 |
| 200 | `#bed6f7` | 1.42 | 12.91 |
| 300 | `#9fc0ed` | 1.79 | 10.25 |
| 400 | `#7ca7e0` | 2.38 | 7.72 |
| 500 | `#578bcf` | 3.36 | 5.47 |
| 600 | `#3270c0` | 4.78 | 3.84 |
| 700 | `#0055ae` | 6.92 | 2.66 |
| 800 | `#003c94` | 9.71 | 1.89 |

Full 100→800 is for continuous sequential encoding where the lightest step means
"near zero" and may recede into the surface. For **ordinal** ramps (discrete
ordered marks) the step nearest the surface must still clear 2:1: on light start
no lighter than 300; on dark go no darker than 600. Diverging scales are **not
defined** — nothing in this product is genuinely bipolar, and inventing a
diverging scale invites someone to encode "safety" on a continuum, which is the
one thing the verdict model forbids.

Chart chrome: gridlines `--color-border-faint`, axis/baseline `--color-border`,
axis labels `--color-text-3`, all values in mono with `tabular-nums`. **Never a
dual-axis chart.** Text in charts always wears text tokens, never the series
color.

### 2.6 Elevation and shadow

```css
/* light — two-layer, low-alpha, warm-tinted */
--shadow-sm:  0 1px 2px rgba(34,32,28,0.05);
--shadow-card:0 2px 4px rgba(34,32,28,0.05), 0 1px 1px rgba(34,32,28,0.04);
--shadow-pop: 0 8px 24px rgba(34,32,28,0.10), 0 2px 6px rgba(34,32,28,0.06);
--shadow-modal:0 24px 64px rgba(34,32,28,0.18), 0 4px 12px rgba(34,32,28,0.08);
--scrim: rgba(24,22,19,0.42);

/* dark — shadow is nearly invisible; elevation is surface-step + hairline,
   plus a 1px inset top highlight to catch the edge */
--shadow-sm:   none;
--shadow-card: inset 0 1px 0 rgba(255,255,255,0.03);
--shadow-pop:  0 8px 24px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.05);
--shadow-modal:0 32px 72px rgba(0,0,0,0.70), inset 0 1px 0 rgba(255,255,255,0.06);
--scrim: rgba(0,0,0,0.62);
```

Scrim is 42% / 62% black — inside the 40–60% band that keeps foreground content
legible, and the dark value is higher because the dialog surface is closer in
lightness to the canvas.

### 2.7 Typography

**Three faces, and one rule that decides which to use.**

```css
--font-sans: "Inter var", Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
--font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;
--font-display: "Source Serif 4", ui-serif, Georgia, serif;
```

> **The rule.** Mono = a machine-authored fact (package name, version, hash,
> file path, code, count, rate, duration, audit id). Sans = interface language
> (labels, buttons, prose in the app). Serif = the product's own voice, and it
> appears **only** on the static and editorial surfaces (`/`, `/how-it-works`,
> `/replays` blurbs, `/benchmark` methodology prose). The app chrome never uses
> serif.

The corollary is memorable and enforceable: **every number that is a measurement
is set in mono**, including the large hero figures on `/benchmark`. A percentage
is a reading, not a headline.

Why these three. **Inter** is chosen unromantically: it is the right tool at
12–14px in a table with three hundred rows, it has a real variable axis, and it
ships `tabular-nums` and the `ss01`/`cv05` alternates that disambiguate `l`/`I`.
The product's character is not supposed to come from the UI face. **IBM Plex
Mono** carries the character instead, because mono is everywhere in this product;
it is economical in width (which matters when a cell holds
`@babel/plugin-transform-runtime@7.24.7`), has unambiguous `0`/`O` and `1`/`l`,
and reads institutional rather than costume — the opposite of a phosphor font.
**Source Serif 4** was designed for long-form technical reading; at display sizes
it has enough contrast to look deliberate without tipping into editorial fashion.
All three are OFL/SIL — no licensing exposure, self-hosted, no Google Fonts
runtime dependency (the current app `@import`s from `fonts.googleapis.com`, which
is a third-party request on every page load and should not survive the rebuild).

Load with `font-display: swap`, subset to Latin, preload only the two weights
above the fold (Inter 400/500).

**Scale.** Root 16px. App base is 14px because the app is dense; static surfaces
base at 16px because they are read.

| Token | px / rem | Line height | Use |
|---|---|---|---|
| `--text-2xs` | 11 / 0.6875 | 1.45 | Table meta, `kbd`, chart tick. **Never body.** |
| `--text-xs` | 12 / 0.75 | 1.45 | Column headers, chips, secondary cell text |
| `--text-sm` | 13 / 0.8125 | 1.5 | Dense table body, dep rows |
| `--text-base` | 14 / 0.875 | 1.55 | App body default |
| `--text-md` | 16 / 1 | 1.6 | Static-surface body; **all form inputs on mobile** |
| `--text-lg` | 18 / 1.125 | 1.6 | Lead paragraph |
| `--text-xl` | 20 / 1.25 | 1.4 | Card titles, section headings in app |
| `--text-2xl` | 24 / 1.5 | 1.3 | Page titles |
| `--text-3xl` | 30 / 1.875 | 1.25 | Static section headings (serif) |
| `--text-4xl` | 38 / 2.375 | 1.15 | Static page titles (serif) |
| `--text-5xl` | 48 / 3 | 1.05 | Landing hero (serif) |
| `--text-figure` | 60 / 3.75 | 1 | `/benchmark` hero figures (**mono**, tabular) |

Weights: 400 body, 500 labels and table headers, 600 headings and emphasis. No
700 in the app; 700 only for the landing hero if the serif needs it. Prose
measure caps at **68ch**; `/how-it-works` body is `--text-md` at line-height
1.65.

Inline mono inside sans runs at `0.925em` — Plex Mono's x-height reads larger at
matched nominal size. Tabular figures (`font-variant-numeric: tabular-nums`) are
mandatory in table columns, axis ticks, meters and timers; the hero figures also
use them so a ticking count does not reflow.

### 2.8 Spacing, radii, borders, sizes

4px base, dense-dashboard biased.

```css
--space-0-5: 2px;  --space-1: 4px;   --space-1-5: 6px;  --space-2: 8px;
--space-3: 12px;   --space-4: 16px;  --space-5: 20px;   --space-6: 24px;
--space-8: 32px;   --space-10: 40px; --space-12: 48px;  --space-16: 64px;
--space-20: 80px;  --space-24: 96px;
```

Section rhythm: 16 within a card, 24 between cards, 48 between page sections in
the app, 96 between sections on static surfaces. Horizontal gutters step
16 → 24 → 32 → 48 across the 375 / 768 / 1024 / 1440 breakpoints.

**Radii — modest, because a case file is not a bubble.**

```css
--radius-xs: 3px;   /* kbd, tiny chips */
--radius-sm: 4px;   /* verdict stamps, badges, inputs, dense buttons */
--radius-md: 6px;   /* buttons, list rows, table row hover */
--radius-lg: 8px;   /* cards, panels */
--radius-xl: 10px;  /* dialogs, sheets */
```

There is **no `rounded-full` on any status element.** The verdict chip is a
4px-radius rectangle — a stamp, not a pill. This is a deliberate break from the
category default (Surfshark, GitLab and Cloudflare all use fully-round severity
pills) and it is the single strongest carrier of the "record, not a
consumer app" read. Fully-round is reserved for avatars and the count dot on a
nav item.

**Borders.**

```css
--border-hairline: 1px;   /* everything, by default */
--border-emphasis: 2px;   /* focus ring, active phase indicator */
--border-rule: 3px;       /* left rule on a DANGEROUS / ERROR row or card */
```

The 3px left rule is how severity reaches a row without adding a colored
background to three hundred of them. Whole-row wash tinting (the Vercel log
pattern) is reserved for the log/evidence panes, where rows are few and the tint
is the point.

**Control sizes** — note the 44px minimum for touch:

```css
--h-control-sm: 28px;  --h-control: 34px;  --h-control-lg: 40px;
--h-row-dense: 32px;   --h-row: 40px;      --h-row-comfy: 48px;
--h-topbar: 56px;
--size-icon-sm: 14px;  --size-icon: 16px;  --size-icon-lg: 20px;
--tap-min: 44px;       /* hit area, extended via padding/::before, not visual size */
```

Below 768px every control's *hit area* grows to 44px even when its visual box
stays 34px, and dense table rows relax to `--h-row-comfy`.

**Focus.** One ring, everywhere, no exceptions:

```css
--focus-ring: 0 0 0 2px var(--canvas), 0 0 0 4px var(--accent);
```

Accent-on-canvas measures **5.38:1 light / 5.47:1 dark**, well clear of the 3:1
non-text requirement, and the inner canvas-colored ring keeps it legible when the
focused element sits on a wash or a fill. Focus is never removed — `:focus-visible`
only, so mouse users don't see it but keyboard users always do.

### 2.9 Motion

```css
--ease-out: cubic-bezier(0.20, 0.80, 0.20, 1);   /* entering */
--ease-in:  cubic-bezier(0.40, 0.00, 1.00, 1);   /* exiting */
--ease-std: cubic-bezier(0.40, 0.00, 0.20, 1);   /* moving / resizing */

--dur-press:  80ms;   /* active state */
--dur-fast:   120ms;  /* hover, focus, color change */
--dur-base:   180ms;  /* state change, popover, tooltip */
--dur-enter:  240ms;  /* dialog, sheet, drawer */
--dur-exit:   160ms;  /* ~65% of enter */
--dur-reveal: 420ms;  /* the verdict reveal — the one deliberate slow one */
--stagger:    40ms;   /* per item, capped at 6 items = 240ms total */
```

Enter uses `--ease-out`, exit uses `--ease-in` and is shorter. Only `transform`
and `opacity` animate — never `width`, `height`, `top` or `left`. Animations are
interruptible and never block input.

**Three motion rules specific to this product**, all downstream of §0:

1. **Motion never carries information that isn't also in text.** The phase rail
   always shows a phase *name* and an elapsed counter; the spinner is decoration
   on top of that. If motion is the only thing telling you an audit is alive, the
   audit looks dead the moment animation is disabled.
2. **No fabricated progress.** Phases of unknown duration get an indeterminate
   marching hairline, never a percentage and never a bar that creeps to 90% and
   waits. A synthesized progress number is N-3 expressed in motion.
3. **The verdict reveal is not a celebration.** Over `--dur-reveal` the stamp
   crossfades in and its border goes 1px → 2px. No scale-up, no bounce, no
   confetti, no sound — for either verdict. A DANGEROUS finding should not feel
   like a win, and a SAFE finding should not feel like an all-clear.

**Reduced motion** (`@media (prefers-reduced-motion: reduce)`), designed rather
than defaulted:

- All durations → `0ms`, except content-replacement crossfades which hold at
  `80ms` opacity-only so a swap doesn't read as a glitch.
- Spinners become a **static** glyph plus the phase name plus the live elapsed
  counter (text updates are not motion).
- The indeterminate marching hairline becomes a **static 45° hatch** — the same
  hatch the degraded state uses, which is already in the system.
- Streaming inserts (a new hypothesis card arriving) do not slide or stagger.
  They appear, and carry a persistent `NEW` chip for 8s instead of an animation,
  so the "something changed" signal survives without movement.
- The verdict reveal becomes an immediate state change plus an `aria-live="polite"`
  announcement of the verdict and its caveat line.
- No parallax, no scroll-linked animation anywhere, in either mode.

---

## 3. Component inventory

`Radix` = vendored shadcn wrapper over that primitive. `plain` = no Radix
primitive exists or is warranted; build it in the design-system layer with
correct semantics by hand.

### 3.1 Primitives

| Component | For | Backing | Domain states / notes |
|---|---|---|---|
| `Dialog` | Upgrade/paywall, confirm destructive, replay picker, evidence detail | Radix `Dialog` | Replaces the hand-rolled `PanelDialog` (its own focus trap, escape handling, portal and ARIA — four places to be silently wrong). Needs a `scrollable-body` variant for long evidence. |
| `AlertDialog` | Disable Protect, revoke install, force-install a DANGEROUS package | Radix `AlertDialog` | Destructive confirm; the action button wears `danger`, and is never the default-focused element. |
| `DropdownMenu` | Row actions, column visibility, density, org switcher | Radix `DropdownMenu` | Needs checkbox-items (column toggles) and radio-items (density) — per [Vanta's combined density + columns menu](https://mobbin.com/screens/7f317ce6-2e6e-4fb2-929d-c8de5b2c2f75). |
| `ContextMenu` | Table header actions (sort asc/desc, pin, hide) | Radix `ContextMenu` | Modeled on [Retool's column header menu](https://mobbin.com/screens/efce0115-d594-4584-9bca-9e048dc80673); must also be reachable from a visible affordance, not right-click only. |
| `Tabs` | `/audit` stream filters, `/package` report sections, `/benchmark` run views | Radix `Tabs` | Tab labels carry counts (`Hypotheses 4`, `Files 128`, `Errors 2`) — the [Vercel log filter](https://mobbin.com/screens/d4bd289f-0040-4309-80d1-04dcf528e4c2) pattern. A count of 0 renders the tab disabled, not hidden. |
| `Toast` | Scan started, Protect toggled, copy confirmations, SSE reconnected | `Sonner` (shadcn default) | `aria-live="polite"`, never steals focus, 4s auto-dismiss, `undo` slot for reversible actions. **Errors do not use toasts** — a failure that matters goes to a degraded state, because toasts vanish. |
| `Tooltip` | Truncated package names, metric definitions, glyph legends | Radix `Tooltip` | Content must also be reachable without hover (focus, and a tap target on touch). Never the only place information exists. |
| `Popover` | Filter builders, CI explainer, "why this verdict" | Radix `Popover` | |
| `HoverCard` | Dep row → report preview on hover | Radix `HoverCard` | Desktop enhancement only; the row click is the real path. |
| `Select` / `Combobox` | Version picker, org picker, dataset picker | Radix `Select`; combobox via `cmdk` | Version picker must be a combobox — packages have hundreds of versions. |
| `Switch` | Protect per repo | Radix `Switch` | Optimistic on-state with a pending shimmer; F-D1 says the toggle responds immediately while the first scan runs behind it. Needs a `pending` and a `blocked-by-quota` state. |
| `Checkbox` / `RadioGroup` | Bulk row selection, density choice | Radix | 44px hit area on touch. |
| `ScrollArea` | Log pane, file tree, dep table viewport | Radix `ScrollArea` | Must not nest a second scroll region inside the page scroll. |
| `Collapsible` / `Accordion` | File summaries, evidence sections, phase substeps | Radix | Default-collapsed for anything over 6 items. |
| `Separator` | Hairline dividers | Radix `Separator` | |
| `Command` | `⌘K` — jump to package, repo, replay, audit | `cmdk` | Keyboard-first nav is what Direction A keeps from C. |
| `Sheet` | Mobile nav, row detail drawer | Radix `Dialog` | |
| `Skeleton` | Loading placeholders | plain | Only for waits > 300ms, and only where the final layout's dimensions are known — otherwise it causes the layout shift it exists to prevent. |
| `Kbd` | Shortcut hints | plain | Mono, `--text-2xs`, sunken surface. |
| `CopyButton` | Package name, audit id, install command, tx hash | plain | Everything in mono is copyable. Success is an inline glyph swap, not a toast. |

### 3.2 Data display

| Component | For | Backing | Domain states / notes |
|---|---|---|---|
| `Card` | Repo cards, metric cards, replay gallery items | plain | Hairline + `--radius-lg` + `--shadow-card`. Variants: `default`, `interactive` (whole card is a link), `severity` (3px left rule in `danger`/`error`). |
| `Table` | Dep tables, bench rows, package registry | plain (+ TanStack Table for state) | Radix has no table primitive; use real `<table>` semantics with `aria-sort` on sorted headers. Sticky header, row-number gutter and column-type glyphs per [Clay](https://mobbin.com/screens/319d3af8-a182-45e9-a46d-36f3bfe7bb4e); `Dense / Regular / Comfortable` density; grouped rows with a group header carrying count + rollup per [Airtable](https://mobbin.com/screens/7612f4c4-4104-4dbc-8e5f-579dde687f2b). |
| `VirtualTable` | The dep table at hundreds of rows | plain + TanStack Virtual | Virtualize above 100 rows. Fixed row height per density token so the scrollbar is honest. Must keep: keyboard row navigation, find-in-page fallback (a "search this table" input, since ⌘F cannot see virtualized rows), and a non-virtualized print/export path. |
| `StatTile` | Bench metrics, cost/latency, usage | plain | Hairline-divided horizontal strip per [n8n's eval run](https://mobbin.com/screens/8e2ed125-52a7-457f-9831-caadfc788629). Value in mono tabular; label in sans; **and a one-line definition of what the metric means**, per [Cohere](https://mobbin.com/screens/dd89e83a-58b4-4483-9b75-b41581b17c6b). A tile with no data shows an em-dash, never `0`. |
| `HeroFigure` | `/benchmark` headline rates | plain | Mono, `--text-figure`, tabular. Always paired with its Wilson CI and its denominator (`47 / 52`). Never a bare percentage. |
| `IntervalBar` | Wilson 95% CI | plain SVG | Point estimate as an 8px dot with a 2px whisker on a 0–100% axis; the interval is the mark, the point is secondary. Has a table view. This is the F-G3 component — the thing that stops the bench from shipping bare point estimates. |
| `Meter` | Plan/usage, scan progress, coverage | plain, `role="meter"` | Radix `Progress` is for indeterminate/determinate task progress; a *quota* is a meter, semantically different. Pattern from [Vanta](https://mobbin.com/screens/eaeda897-a742-4213-834c-7025bcf3c7c1): count + bar + `n OK / m total`. States: `normal`, `near-limit`, `over-limit`, `unmetered`, `unknown` (hatched — never a full or empty bar when the number is unavailable). |
| `Progress` | Scan progress ("12 of 340 concluded") | Radix `Progress` | Computed from `scan_items` rows (F-C2), never a counter. Indeterminate variant is the marching hairline. |
| `SeverityRibbon` | Repo/org posture rollup | plain | One segmented horizontal bar, segments in outcome order `DANGEROUS · ERROR · SAFE · pending`, 2px surface gap between segments, each segment labeled with its count. Per [Cloudflare](https://mobbin.com/screens/53f8867e-f2e8-4451-a58d-a2f2a3cf35d7). Pending is a hatched neutral segment, so an in-flight scan cannot read as green. |
| `Badge` | Provenance and metadata chips | plain | `direct`/`transitive`, `dev`, `cached 3d ago`, `watch-audited`, `replay`, `deferred`. Neutral by default; chips are metadata and almost never colored. |
| `Sparkline` | Verdict mix over time on a repo card | plain SVG | 2px line, no axis, no fill, one series only. Optional — see §5. |

### 3.3 Domain components

| Component | For | Backing | Domain states / notes |
|---|---|---|---|
| `VerdictStamp` (the "verdict pill") | The verdict, everywhere | plain | 4px-radius rectangle, mono uppercase label, glyph + word + color (§2.4). Sizes `sm` (table cell), `md` (card), `lg` (report header). States: `SAFE`, `DANGEROUS`, `ERROR`, `queued`, `running`, `unaudited`. **The `lg` variant always renders a caveat line beneath it**: SAFE reads "No confirmed threat found. Not a proof of absence." plus coverage counts; ERROR reads what failed and offers retry. The caveat is part of the component, not something a page remembers to add — that is how §0 gets enforced structurally instead of by discipline. |
| `PhaseRail` | Pipeline progress on `/audit/:id` | plain (`ol` + `aria-current`) | Phases: `resolve → deps → inventory → intent → flag → hypothesize → graph → experiments → judge → verdict`. Per-phase states: `pending` (hollow), `active` (spinner + elapsed + live substatus), `done` (check + duration), `skipped` (dash + reason — real in this pipeline, since FLAG with no suspicion jumps straight to verdict), `failed` (slash, `error` hue). Vertical rail + log pane below is the [Cloudflare](https://mobbin.com/screens/38e77df4-8321-4393-9bf7-6d0dac0d678d) shape; per-substep `Pending / Finished / Skipped` with durations is [Laravel Cloud](https://mobbin.com/screens/dd29535f-34aa-4279-82fc-76e11059f596). A horizontal compact variant for narrow viewports, per [Replit](https://mobbin.com/screens/65647ca7-bef2-49e2-af15-37feb7056049). |
| `DepRow` | One dependency in a repo/scan | plain (table row) | Columns: name@version (mono, truncate-middle so the version stays visible), outcome stamp, depth chip, provenance chip, last-audited, drill-through. States: all six outcome/progress states, plus `cached`, `watch-audited`, `quota-blocked`. Severity arrives as a 3px left rule, not a row fill. |
| `HypothesisCard` | A typed hypothesis appearing and resolving live | plain + `Collapsible` | States: `proposed`, `compiling`, `running`, `CONFIRMED`, `REFUTED`, `DEFERRED`. `DEFERRED` is a first-class, prominent state — F-I5 says showing what the tool *can't* prove is as persuasive as a catch, so it is styled as a real outcome in `error` hue, not as a greyed-out afterthought. Body sections (claim, compiled experiment, oracle output, judgment) are inset panels, per [Vapi's test cards](https://mobbin.com/screens/404a5004-51fa-45e5-8a56-428518c63fdf). |
| `EvidenceTimeline` | Cited events backing a judgment | plain (`ol`) | Rows: timestamp (mono, muted gutter), event kind glyph, payload. Cited events are marked and deep-linkable; the judgment's citations resolve *into* this list. Whole-row wash tint for the events that carry the finding. |
| `CodeViewer` | File contents, compiled experiments, diffs | plain (Shiki, build-time or worker) | Line numbers in a muted gutter, wrap off with horizontal scroll inside its own container, copy button, permalink per line range, highlighted evidence ranges. Sunken surface. Must render with syntax highlighting *disabled* as a graceful fallback rather than blocking on the highlighter. |
| `FileTree` | Package contents on `/audit` and `/package` | plain (`aria-tree`) | Per-file flag state and summary presence; files that were flagged carry a marker. Virtualized above 200 nodes. |
| `LogPane` | Raw SSE event stream | plain | Mono, muted timestamp gutter, `Live tail` toggle and in-log search per [Render](https://mobbin.com/screens/1b400c9e-2ebe-45ad-9d14-83dca9bbd425); severity by whole-row wash tint per [Vercel](https://mobbin.com/screens/d4bd289f-0040-4309-80d1-04dcf528e4c2). Auto-scroll pauses the moment the user scrolls up and shows a "jump to live" affordance. |
| `AlertFeedRow` | Org alerts | plain | Unacked vs acked; whole-feed acknowledge (F-D5). Never a red dot without a count. |
| `ReplayBanner` | "This is a recording" | plain | Persistent, non-dismissable, top of the audit surface when replaying (F-I4). Must be unmistakable but must not alter the audit chrome beneath it, since a replay has to be visually identical to a live run. Carries the recording's date and the engine version it was recorded against. |
| `ConnectionStatus` | SSE health | plain | `live`, `reconnecting` (with attempt count), `resumed at seq N`, `disconnected`. A dropped stream must never present as a permanent spinner — that is stale­ness #4 in the design doc, and this component is the fix. |
| `LaunchInput` | One-shot audit launcher on `/`, repo paste on `/scan` | plain | Mono input, inline resolve preview (`express → 5.2.1`), validation on blur. 16px font on mobile to prevent iOS zoom. |

### 3.4 States — empty, degraded, and the difference between them

This is where N-3 gets designed instead of left to chance. **Empty and degraded
must be visually unmistakable**, because conflating them is exactly the failure
the design doc calls out (`/bench/results` returning `{runs: []}` when the truth
is "this code cannot read this engine's reports").

| Component | For | Backing | Notes |
|---|---|---|---|
| `EmptyState` | A successful read that returned nothing | plain | **Fully achromatic.** Ringed neutral glyph, one sentence saying what would appear here, one primary action. Per [Vapi](https://mobbin.com/screens/9afecd03-c74c-41b9-b1f3-a4eee7089c21) and [GitHub](https://mobbin.com/screens/054b197e-baf6-4692-8d51-ee6e826c2b71) — note that GitHub keeps the table chrome and tab counts around the empty body, which preserves the reader's sense of *where* the emptiness is. Copy is specific: "No dependencies audited yet", never "No data". |
| `DegradedState` | A read that **failed** | plain | Three variants by blast radius. **`field`** — one value missing: renders an em-dash plus a small `?` affordance naming the failed fetch. Never `0`, never a blank. **`region`** — a card or section failed: the frame and title survive, the body becomes a 45° hatch in `error` hue with a named reason, a retry button, and the timestamp of the last good data if any exists. **`surface`** — the page's primary fetch failed: full-region state naming what failed, the request id, retry, and a link to a surface that still works. |
| `StaleChip` | Data that loaded but is old | plain | `as of 14:02 · refresh`. Distinct from degraded: the data is real, just not current. |

Three rules for `DegradedState`, all of them enforceable in review:

1. **It names the thing that failed.** "Alerts feed unavailable", not "Something
   went wrong". The user can only route around a failure they can identify.
2. **It uses `error` violet, never `danger` red.** A failed fetch is not a
   security finding. Red is reserved for claims about packages. This is why audit
   `ERROR` and UI degradation share one semantic slot — both mean *we don't
   know*, and the user must never confuse "we don't know" with "it's bad."
3. **It is hatched, not blank.** The 45° hatch is the system's visual signature
   for "no signal here" — the same fill used for an indeterminate meter, a
   pending ribbon segment, and a reduced-motion indeterminate bar. One texture,
   one meaning, and it survives greyscale, print and `forced-colors`.

---

## 4. Wireframes for the two hardest screens

### 4.1 `/audit/:id` — the live audit (the signature screen)

Three zones. The identity bar never moves. The rail is sticky. The stream is the
only thing that scrolls. The verdict dock is present from the first frame as an
empty, labeled slot — so the verdict *lands in a place the eye is already
watching* instead of pushing the layout around when it arrives.

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ ◐ AUDIT   event-stream@3.3.6            audit_01JQ…7bK ⧉   04:12 elapsed   ● live  │  ← identity bar, 56px
│ ─────────────────────────────────────────────────────────────────────────────────  │     mono pkg@ver, copyable id
├──────────────────────────┬─────────────────────────────────────────────────────────┤
│ PIPELINE                 │  ┌ Hypotheses 3 ─ Files 128 ─ Evidence 41 ─ Raw log ──┐ │  ← Tabs w/ counts
│                          │                                                         │
│  ✓ resolve       0.4s    │  ┌───────────────────────────────────────────────┐ NEW │
│  ✓ deps          1.2s    │  │ ⊘ DEFERRED   H-2                              │     │  ← HypothesisCard
│  ✓ inventory     2.8s    │  │ "flatmap-stream postinstall reads ~/.npmrc     │     │     error hue, 3px left rule
│  ✓ intent        3.1s    │  │  and POSTs to a remote host"                   │     │
│  ✓ flag          6.7s    │  │ ▸ compiled experiment      ▸ oracle output     │     │
│    └ 4 of 128 flagged    │  │ Could not be evaluated — load crash at require │     │  ← the honest middle,
│  ✓ hypothesize  11.9s    │  └───────────────────────────────────────────────┘     │     styled as a real outcome
│    └ 3 proposed          │                                                         │
│  ◐ experiments   ⣾ 02:14 │  ┌───────────────────────────────────────────────┐     │
│    ├ ✓ H-1       48s     │  │ ✖ CONFIRMED  H-1                    danger    │     │
│    ├ ⊘ H-2   deferred    │  │ "index.js exfiltrates env to 5.188.x.x:443"   │     │
│    └ ◐ H-3   running     │  │ ▸ compiled experiment                         │     │
│  ○ judge                 │  │ ▾ oracle output                               │     │
│  ○ verdict               │  │ ┌───────────────────────────────────────────┐ │     │
│                          │  │ │ 14:02:11.204  net.connect 5.188.x.x:443  │ │     │  ← EvidenceTimeline,
│ ── marching hairline ──  │  │ │ 14:02:11.288  tls.write  1.2 kB          │ │     │     cited rows wash-tinted
│ (static hatch when       │  │ │ 14:02:11.401  fs.read    /proc/self/env  │ │     │
│  reduced-motion)         │  │ └───────────────────────────────────────────┘ │     │
│                          │  └───────────────────────────────────────────────┘     │
│ ── FILES ──────────────  │                                                         │
│ ▾ package/               │  ┌───────────────────────────────────────────────┐     │
│   ● index.js      flagged│  │ ✓ REFUTED    H-3                              │     │
│   ● postinstall.js  flag │  │ "test/fixture.js writes outside tmp"          │     │
│     lib/util.js          │  └───────────────────────────────────────────────┘     │
│     README.md            │                                                         │
│                          │  ┌─ alerts feed ─────────────────────────────────┐     │
│                          │  │ ╱╱╱╱ Alerts feed unavailable  ╱╱╱╱╱╱╱╱╱╱╱╱╱╱ │     │  ← DegradedState / region
│                          │  │ ╱╱╱╱ GET /panel/alerts failed (502)   ↻ Retry │     │     hatched, error hue,
│                          │  │ ╱╱╱╱ Last good data 14:01                     │     │     names the failure
│                          │  └───────────────────────────────────────────────┘     │
├──────────────────────────┴─────────────────────────────────────────────────────────┤
│ VERDICT                                                        pending — 2 running │  ← verdict dock, reserved
│ ░░░░░░░░░░  awaiting judgment · 1 confirmed · 1 deferred · 1 refuted               │     from first frame
└────────────────────────────────────────────────────────────────────────────────────┘

On conclusion the dock fills — 420ms crossfade, border 1px → 2px, no scale:

┌────────────────────────────────────────────────────────────────────────────────────┐
│ VERDICT                                                              concluded 4:38│
│ ┌──────────────┐  1 confirmed hypothesis · dealbreaker: none                       │
│ │ ✖ DANGEROUS  │  Confirmed exfiltration of process environment to a remote host.  │
│ └──────────────┘  Evidence: 3 cited events (H-1) · 128 files inventoried           │
│                   → canonical report /package/event-stream/3.3.6                   │
└────────────────────────────────────────────────────────────────────────────────────┘

…and the SAFE case, deliberately quieter, with the caveat baked into the component:

┌────────────────────────────────────────────────────────────────────────────────────┐
│ VERDICT                                                              concluded 1:12│
│ ┌──────────────┐  No confirmed threat found. Not a proof of absence.               │
│ │ ✓ SAFE       │  128 files inventoried · 4 flagged · 3 hypotheses, 0 confirmed    │
│ └──────────────┘  1 hypothesis could not be evaluated → see H-2                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Notes on why this shape. The rail carries *duration per phase* because cost and
latency are part of the product's honesty (F-G4) and because a phase that took
11.9s is information. The `experiments` phase nests its hypotheses so the rail and
the stream stay in sync. The `NEW` chip on an arriving card is what replaces the
slide-in animation under reduced motion. And the degraded alerts region sits
inline in the stream rather than as a toast, because a toast would vanish and the
page would then look confidently complete — the exact silent-fallback bug in
`panelStore.refresh()`.

Narrow viewport (< 900px): the rail collapses to the horizontal compact
`PhaseRail`, pinned under the identity bar; the file tree moves behind a `Sheet`.

### 4.2 `/repo/:owner/:name` — repo detail with a long dependency table

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ dashboard / acme-corp / ▸ web-platform                                    ⌘K       │
├────────────────────────────────────────────────────────────────────────────────────┤
│ web-platform                                          Protect ●━━  ↻ Scan now      │
│ github.com/acme-corp/web-platform · pnpm-lock.yaml · main                          │
│ Last scan 2026-07-25 14:02 · push a3f91c2 · 340 deps · 4m 18s          ⟶ history   │  ← the resurrected lastScan
├────────────────────────────────────────────────────────────────────────────────────┤
│ POSTURE                                                                            │
│ ┌──────────────┐   ┌──────┬────────┬──────────────────────────────┬──────────────┐ │
│ │ ✖ DANGEROUS  │   │  3   │   12   │            313               │ ╱╱ 12 ╱╱╱╱╱ │ │  ← SeverityRibbon,
│ └──────────────┘   │dangr.│ error  │           safe               │   running    │ │     pending is hatched
│  max over 328      └──────┴────────┴──────────────────────────────┴──────────────┘ │     so it can't read green
│  concluded deps       3 dangerous · 12 could not conclude · 313 no threat found     │
│                       12 still running — posture may change                        │  ← progress ≠ verdict, stated
├────────────────────────────────────────────────────────────────────────────────────┤
│ ┌ 2 unacknowledged alerts ────────────────────────────────────── acknowledge all ┐ │
│ │ ✖  event-stream@3.3.6  newly published version is DANGEROUS      2h ago  ⟶     │ │
│ │ ✖  rc@1.2.9            confirmed exfil in transitive dep         6h ago  ⟶     │ │
│ └────────────────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────────────────────────────────────────────────────────┤
│ DEPENDENCIES                                                                       │
│ ┌────────────────────────────────────────────────────────────────────────────────┐ │
│ │ ⌕ search 340 deps      [outcome ▾] [depth ▾] [dev ▾]   group: outcome ▾  ⚙ ⤓  │ │  ← toolbar: search is
│ ├──┬───────────────────────────────┬─────────┬────────┬──────────┬──────────────┤ │     mandatory (⌘F can't
│ │ #│ package ▲                     │ outcome │ depth  │ audited  │              │ │     see virtual rows)
│ ├──┴───────────────────────────────┴─────────┴────────┴──────────┴──────────────┤ │
│ │ ▾ ✖ DANGEROUS · 3                                        blocks install       │ │  ← group header + count
│ │▌1│ event-stream@3.3.6            │✖ DANGER │ direct │ 2h ago   │ report ⟶     │ │  ← 3px left rule = severity
│ │▌2│ flatmap-stream@0.1.1          │✖ DANGER │ trans. │ 2h ago   │ report ⟶     │ │
│ │▌3│ rc@1.2.9                      │✖ DANGER │ trans. │ 6h ago   │ report ⟶     │ │
│ │                                                                                │ │
│ │ ▾ ⊘ COULD NOT CONCLUDE · 12                       not safe, not dangerous     │ │  ← the group whose label
│ │▌4│ node-sass@4.14.1              │⊘ ERROR  │ direct │ 1d ago   │ ↻ retry      │ │     does the most work
│ │▌5│ sharp@0.32.6                  │⊘ ERROR  │ direct │ 1d ago   │ ↻ retry      │ │
│ │ …                                                                              │ │
│ │                                                                                │ │
│ │ ▸ ◐ RUNNING · 12                                                              │ │
│ │ ▸ ✓ NO THREAT FOUND · 313                                                     │ │  ← collapsed by default:
│ │                                                                                │ │     the 313 clean rows are
│ │ ▸ ○ UNAUDITED · 0                                                             │ │     not the story
│ └────────────────────────────────────────────────────────────────────────────────┘ │
│ 340 rows · 328 concluded · 12 running · virtualized          density: ◉ dense ○ reg│
└────────────────────────────────────────────────────────────────────────────────────┘

Row click opens a drawer rather than navigating away — the table's scroll
position and filter state are expensive to rebuild:

                          ┌──────────────────────────────────────┐
                          │ event-stream@3.3.6              ✕    │
                          │ ┌──────────────┐                     │
                          │ │ ✖ DANGEROUS  │ concluded 2h ago    │
                          │ └──────────────┘                     │
                          │ Confirmed exfiltration of process    │
                          │ environment to a remote host.        │
                          │ ── why ─────────────────────────────  │
                          │ H-1 CONFIRMED · 3 cited events       │
                          │ ▸ oracle output                      │
                          │ ── reached via ──────────────────────  │
                          │ web-platform → build-tools →         │
                          │ event-stream  (transitive, depth 2)   │
                          │ ── actions ─────────────────────────  │
                          │ full report ⟶   re-audit   ignore…    │
                          └──────────────────────────────────────┘
```

Notes on why this shape. **Grouping by outcome with `DANGEROUS` first and the 313
clean rows collapsed** is the single most important decision on this screen: a
flat 340-row table buries the three rows that matter, and sorting by name is
actively hostile. The group labels are prose, not enum names — "COULD NOT
CONCLUDE · 12 — not safe, not dangerous" is the §4.4 distinction taught in situ,
every time someone looks at the table. The `12 still running — posture may change`
line under the ribbon is the progress axis refusing to masquerade as a verdict.
Per-row `↻ retry` on ERROR rows exists because §4.4 says a failed audit "needs a
retry" while a pending one resolves itself, and the UI should express that
difference as an affordance, not just a color.

---

## 5. What I deliberately did not decide

Where a human's taste is still required, and why I stopped.

1. **Whether the serif is used at all.** This is the highest-taste-risk call in
   the document. `Source Serif 4` on the static surfaces is what gives Direction
   A its "document" voice, but serif in a developer tool is a genuine coin-flip
   that reference-hunting cannot settle — none of the dev-tool landing pages I
   retrieved use one (Antimetal's display face is the closest). Build `/` and
   `/how-it-works` both ways at the hero and pick by looking. The fallback is
   Inter at weight 500 with tighter tracking, which costs nothing but voice.
2. **Which theme is the default, and which one the marketing screenshots use.**
   Tokens are complete for both and the recommendation is
   `prefers-color-scheme` with a persisted override. But "what NpmGuard looks
   like in people's heads" is a brand decision, and the screenshots on `/` decide
   it. I have no basis to pick.
3. **The wordmark, logo, and any mascot.** Out of scope here and genuinely
   upstream of it — the mark will pull the palette around, not the reverse.
4. **Diagram and illustration language for `/how-it-works`.** It is the
   prose-and-diagrams surface (F-H2) and diagrams are most of its value.
   The 1Password developer hero's isometric line-work is one credible register
   and Cloudflare's flat stage diagrams are another; they imply very different
   amounts of ongoing illustration labour. That is a resourcing decision.
5. **Landing-page composition and copy.** I specified the type scale, the hero
   figure treatment and the register; I did not lay out `/`. The one structural
   opinion I will assert: the inline live replay is the hero, because it is the
   only asset that proves anything, and everything else on the page is caption.
6. **Whether repo cards carry sparklines.** Specified as optional. It needs the
   real data first — if most repos have a flat verdict history, a sparkline is
   decoration, and decoration that looks like data is the worst outcome in this
   product.
7. **Whether `/benchmark` shows a single headline grade.** I designed against it
   (two equal-weight figures — caught *and* missed — rather than one score,
   deviating deliberately from [Adaline's single `64.00% Passed`](https://mobbin.com/screens/f553932d-1520-42fc-952e-af797e7b798f)).
   But F-G's scoring rule is itself an open question (O-2) and a resolved scoring
   rule might justify one number. Revisit after O-2, not before.
8. **Default table density, and whether the setting persists per user or per
   table.** Both are cheap; the right default depends on watching someone use a
   340-row table, which I cannot do from here.
9. **The exact `ReplayBanner` treatment.** F-I4 sets up a real tension — a replay
   must be *visually indistinguishable* from a live audit yet *unmistakably
   labelled* as a replay. I specified a persistent non-dismissable banner that
   does not alter the chrome beneath it. Whether that is loud enough to be honest
   without being loud enough to undercut the demo is a judgment call that needs
   to be made while watching a replay play.
10. **Chart rendering library.** The token layer and mark specs are
    library-agnostic on purpose. `IntervalBar`, `SeverityRibbon` and `Sparkline`
    are all small enough to be hand-rolled SVG, which may mean no chart library
    at all — worth confirming once `/benchmark`'s scoring rule exists, since that
    is the only surface that might need real charting.
11. **Motion beyond the app vocabulary.** §2.9 covers app motion completely. If
    `/` wants scroll choreography, that is a separate decision with a separate
    reduced-motion story; nothing in the app vocabulary licenses it.

---

## 6. Review checklist for the build phase

Mechanical gates, so this document can be enforced rather than admired.

- [ ] Every color used in a component resolves to a token from §2.2. No raw hex
      outside the token block.
- [ ] Both themes rendered for every component before it is called done. Dark is
      not inferred from light.
- [ ] Every outcome renders correctly with color removed (greyscale screenshot
      test) — glyph and word carry it.
- [ ] `node validate_palette.js` re-run and passing after any palette edit.
- [ ] No `rounded-full` on a status element.
- [ ] Every dynamic region has a designed `DegradedState`, and it names its
      failure. No `catch {}`, no fabricated zeros, no empty list standing in for a
      failed read.
- [ ] `EmptyState` is achromatic; `DegradedState` is hatched and violet. They are
      never confusable.
- [ ] Every input is 16px on mobile; every hit area is ≥ 44px below 768px.
- [ ] `prefers-reduced-motion` verified per §2.9 — spinners static, phase name and
      elapsed counter still present, verdict announced via `aria-live`.
- [ ] Tables: `aria-sort` on sorted headers, keyboard row navigation, in-table
      search present wherever rows are virtualized.
- [ ] No dual-axis chart. No fourth series color. No diverging scale.
- [ ] Focus visible on every interactive element; `:focus-visible` only; ring
      never removed.
- [ ] Verified at 375 / 768 / 1024 / 1440 and in landscape.
