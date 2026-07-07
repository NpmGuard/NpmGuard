# NpmGuard frontend — prod-grade design pass

## 1. Structural insight + core re-architecture

The app's identity — "Paper Cream" light / "Urushi" dark-lacquer-gold, mono microlabels,
3px status rails, dark evidence cards on cream — is already distinctive. The generic
"security tool = OLED dark + green accent" direction is the category centroid; **rejected**.
We keep the identity and recalibrate magnitude.

What prod security/agent products do that this UI doesn't:

1. **Status leads with semantic color + proportion** (Cloudflare Security Insights,
   Vanta Tests). Our stat cards are colorless number boxes; verdict semantics live only
   in tiny table badges. → Color the SAFE/DANGEROUS numbers, add a proportional verdict
   bar, demote "Latest" from fake-stat to metadata.
2. **Tables end honestly and cells speak** (Vanta, Cloudflare): "1–10 of 12 results"
   pagination, row hover, plain-language status. → Add to registry + benchmark tables.
3. **Agent feeds subordinate actions under reasoning** (Replit Agent, AI Studio):
   reasoning prose leads; tool calls are compact indented rows; timestamps tiny. Our
   feed gives every item equal weight (the infodump tell). → Rebalance visual weight only.
4. **First tab shown must have content** (Lovable expanded finding): cached-report
   ProofDetail defaults to a Source tab whose body is an unavailable-source apology.
   → Default to "Why" when no live source is available.
5. **The one input that IS the product gets hero treatment** (AI Studio / Replit prompt
   bars): our Audit button looks disabled (lavender-on-lavender), input focus is faint.
   → Real primary button, strong focus-within ring, bigger input.

## 2. Sources

- GitLab Security dashboard — 58e886b7, 83a4d831 (severity rows, muted chrome)
- Cloudflare Security Insights — 53f8867e (severity counts + stacked proportion bar), 1a4f30cf (table)
- Vanta Tests / Findings — d33c50cb, 631da5b7 (number-first status cards, pagination footer)
- Lovable security scan — 2b31dce1, 249b76a6 (expanded finding anatomy)
- Replit Agent — 0210fe24 (reasoning leads, actions indented, checkpoint rows)
- Google AI Studio — 915541ca (run metadata demoted, action history box)

Roles: Cloudflare/Vanta = status-band + table anatomy · Replit = feed anatomy ·
Lovable = finding anatomy · app's own Urushi/Paper-Cream = vibe (unchanged).

## 3. Changes (file → intent)

- `index.css` — global `:focus-visible` ring; `prefers-reduced-motion` guard;
  `.btn-primary` (real CTA); landing search bar focus ring + size; card hover lift;
  raise micro-type floor (0.5rem → 0.6rem min); theme-toggle button affordance.
- `Header.tsx` — theme toggle: 5px dot → labeled icon button (aria-label, focus ring).
- `Landing.tsx` — search input hero treatment; primary Audit button; footer strip
  with quiet product metadata; card hover.
- `PackageSearch.tsx` — semantic stat numbers + verdict proportion bar; "Latest" →
  metadata line; pagination "1–10 of 12" + button states; row hover; tabular numbers.
- `Benchmark.tsx` — metric numbers colored semantically (Detected/Missed/Timeout);
  consistent card treatment.
- `ReportView.tsx` — verdict header hierarchy: verdict word leads, stats support.
- `ProofDetail.tsx` — content-first default tab for cached reports; tab focus states.
- `ActivityFeed.tsx` — tool calls compact + muted; reasoning leads; readable type floor.
- `FindingsList.tsx` / `ResultsPanel.tsx` — badge legibility (≥0.6rem), spacing rhythm.
- `PaymentModal.tsx` — tokens instead of raw rgba; consistent button anatomy.

## 4. Deliberately rejected

- OLED-dark + green accent + JetBrains Mono restyle — category centroid; erases identity.
- New component library / new tokens — the token system is coherent; magnitude only.
- IA changes to routing, data fetching, store logic — out of scope ("not talking logic").
- Removing the dark demo cards on the cream landing — they are the signature flourish.
