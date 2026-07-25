/** Portfolio coverage strip: protection ratio + stacked proportion rail
 * (attention / scanning / safe / unknown) with its counts. One repo lands in
 * exactly one segment, so the rail is a true proportion.
 *
 * ── PRESENTATION: what the recomposition changed ────────────────────────────
 *
 * Nothing about the four buckets, the denominator, or which repo lands where.
 * Two things about what the rail SAYS, and both are the §2.2/§2.4 corrections the
 * repo-detail rail got in the same pass:
 *
 * 1. **`scanning` was BLUE.** A hue on the progress axis, which §2.2 rule 2 makes
 *    achromatic precisely so an in-flight scan cannot read as a verdict — and
 *    danger-red against progress-blue is the pair §2.3's colourblind check
 *    failed. It is neutral ink on the progress track now.
 * 2. **`unknown` was a grey FILL, and the legend was coloured dots.** A repo that
 *    has never been audited is the definition of "no signal here", so it wears the
 *    one texture that means that (§3.4 rule 3, `HATCH_NEUTRAL`). And a dot encodes
 *    state in colour alone; §2.4 requires the word too, so every segment now
 *    carries its own count and label and the dot legend is gone. That retires this
 *    file's use of `toneDotClass`.
 *
 * ── WHY NOT `SeverityRibbon` ────────────────────────────────────────────────
 *
 * §3.2 lists it for "repo/org posture rollup", and its rules — fixed
 * DANGEROUS·ERROR·SAFE·pending order, hatched pending, count per segment, drop
 * zero-count segments — are the rules this rail wants. It still does not fit, for
 * one reason that is not cosmetic: its four slots are a DEP rollup, and its
 * `pending` slot is labelled "running". A portfolio has a fifth fact — a repo with
 * no audit set at all — and folding that into `pending` would tell the reader that
 * something is running when nothing has ever run. Its labels are not caller-
 * supplied, so there is no honest mapping. Composed locally to the same rules;
 * reported as a primitive gap (a `notAttempted` slot, or caller-supplied labels)
 * rather than papered over here or worked around by lying about a count. */

import type { PanelRepo } from "@npmguard/shared";
import { PanelSection } from "../../../components/panel/layout.tsx";
import { Card, CardBody } from "../../../components/ui/card.tsx";
import { HATCH_NEUTRAL } from "../../../components/ui/hatch.ts";
import { cn } from "../../../lib/cn.ts";
import { portfolioCounts } from "../posture.ts";

interface Segment {
  key: string;
  label: string;
  count: number;
  /** Segment skin. Only the two CONCLUDED buckets carry a hue: §0 rule 3 keeps
   * the semantic set for claims about packages, so scanning and unknown sit on
   * the achromatic progress axis. */
  className: string;
  hatched?: boolean;
}

export function PortfolioPosture({ repos }: { repos: PanelRepo[] }) {
  if (repos.length === 0) return null;

  // The classification lives in `posture.ts`, beside the one the dashboard's
  // Attention filter reads — the two are shown within a few hundred pixels of
  // each other, and two inline copies of one rule is a pair that can disagree on
  // screen. ERROR counting as attention (a repo whose audits crashed is not a
  // green repo) and `running` winning over a partial rollup are decisions
  // recorded there, with the tests that pin them.
  const {
    attention,
    running,
    safe,
    unknown,
    protectedRepos: protectedCount,
    audited,
  } = portfolioCounts(repos);
  const pct = Math.round((protectedCount / repos.length) * 100);

  // Order is fixed and is NOT sorted by count — attention is always leftmost so
  // the eye lands on it first even when it is the smallest segment.
  const segments: Segment[] = [
    {
      key: "attention",
      label: "Attention",
      count: attention,
      className: "border-danger-border bg-danger-wash text-danger-text",
    },
    {
      key: "safe",
      label: "Safe",
      count: safe,
      className: "border-safe-border bg-safe-wash text-safe-text",
    },
    {
      key: "running",
      label: "Scanning",
      count: running,
      className: "border-border-faint bg-progress-track text-progress-ink",
    },
    {
      key: "unknown",
      label: "Unknown",
      count: unknown,
      className: "border-border-faint text-progress-idle",
      hatched: true,
    },
  ];
  const drawn = segments.filter((segment) => segment.count > 0);

  return (
    <PanelSection label="Portfolio">
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2.5">
            <p className="text-sm text-text-2">
              <strong className="font-semibold text-text">
                {protectedCount} of {repos.length}
              </strong>{" "}
              repositories protected · {pct}%
            </p>
            <span className="text-2xs text-text-3">
              {audited} audited · {repos.length - audited} not audited
            </span>
          </div>

          {/* A real list, so each count is navigable rather than buried in one
              opaque `aria-label` blob — but the `role="img"` summary is kept as
              the rail's own name, because the PROPORTION is information no
              individual list item carries. */}
          <ul
            className="flex w-full items-stretch gap-0.5"
            aria-label={`${attention} need attention, ${running} scanning, ${safe} safe, ${unknown} unknown`}
          >
            {drawn.map((segment) => (
              <li
                key={segment.key}
                data-segment={segment.key}
                style={{
                  // `flexBasis` in percent with `flexGrow: 0` is an honest
                  // proportion; `minWidth` keeps a 1-in-200 segment readable,
                  // because a segment you cannot see is a count you cannot read.
                  flexBasis: `${(segment.count / repos.length) * 100}%`,
                  flexGrow: 0,
                  minWidth: "3.5rem",
                  ...(segment.hatched ? HATCH_NEUTRAL : undefined),
                }}
                className={cn(
                  "flex flex-col items-center justify-center rounded-sm border px-1 py-1",
                  segment.className,
                )}
              >
                <span className="font-mono text-sm leading-none tabular-nums">{segment.count}</span>
                <span className="mt-0.5 truncate text-2xs leading-none">{segment.label}</span>
              </li>
            ))}
          </ul>

          {/* Zero-count segments are dropped from the bar (a label with no bar is
              noise), so the counts that ARE zero live here in prose — which is
              also where "scanning" gets to say that the posture above is not
              settled yet. */}
          <p className="text-2xs text-text-3">
            {segments.map((segment, index) => (
              <span key={segment.key}>
                {index > 0 ? " · " : ""}
                <span className="font-mono tabular-nums">{segment.count}</span>{" "}
                {segment.label.toLowerCase()}
              </span>
            ))}
          </p>
          {running > 0 && (
            <p className="text-2xs text-progress-ink">
              <span className="font-mono tabular-nums">{running}</span>{" "}
              {running === 1 ? "repository is" : "repositories are"} still scanning — posture may
              change
            </p>
          )}
        </CardBody>
      </Card>
    </PanelSection>
  );
}
