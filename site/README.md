# `site/` — the explainer page

A dependency-free static page that explains how an audit reaches `SAFE` or
`DANGEROUS`, for someone who has never seen the product. Three files, no build
step, no external requests:

```
site/index.html   structure + copy
site/styles.css   tokens + layout + motion
site/app.js       reveal-on-enter, the sequenced step animations, theme, copy
```

Open `index.html` directly, or serve the folder:

```bash
python3 -m http.server 4321 --directory site
```

## Rules this page follows

**Tokens are transcribed, not invented.** Every colour, size, radius, duration
and easing comes from
[`docs/specs/2026-07-25-frontend-design-direction.md`](../docs/specs/2026-07-25-frontend-design-direction.md)
§2. If a value needs to change, re-step the ramp in the spec and copy it here —
do not eyedrop.

**Scrolling is never taken from the reader.** No pinning, no scroll hijacking,
no fabricated progress. Animations are triggered by *"this element is on
screen"* (`IntersectionObserver`), not driven by scrollbar position, so the page
scrolls at whatever speed the reader wants, in either direction.

**Motion never carries information that isn't also in text.** Every animated
visual reads correctly as a static image. `prefers-reduced-motion` is designed
rather than defaulted: sequences land instantly, the marching pulse becomes the
same static 45° hatch the app uses for degraded state, and the typewriter and
read-head simply do not run.

**The verdict is not a celebration.** The stamp crossfades and its border goes
1px → 2px. No scale, no bounce — for either verdict. `SAFE` is the quietest
state on the page, and the section that explains it says out loud that it does
not mean "this package is safe".

Both themes ship. The page follows the OS by default; the header toggle
overrides and persists.
