/** Recent public-repository snapshots (up to 6 rows). Rows open the report
 * dialog; running rows show progress over the set's rollup.
 *
 * A public audit is an audit SET like any other after R-1: the row reads
 * `scan.set` for progress and `scan.repo` for identity, and its id IS the set id
 * the progress stream is keyed on.
 *
 * ── PRESENTATION ────────────────────────────────────────────────────────────
 *
 * The running row's blue `dot--running` is gone for the §2.4/§2.2 reason the rest
 * of this cluster lost its dots: colour alone is not a state, and the progress
 * axis carries no hue. `ProgressStamp` puts a glyph and the word "Scanning" there,
 * and `Progress` carries the count in text beside the bar so it survives
 * reduced motion.
 *
 * The row's identity is a `<button>` and stays one — deliberately unlike the repo
 * card, whose head became a `<Link>`. This does not navigate: it opens a dialog
 * over the dashboard, and there is no URL to middle-click. A `<Link>` here would
 * promise a destination that does not exist.
 *
 * The three arms are unchanged, including the one that matters: `failed` renders a
 * named degraded region, and EMPTY renders nothing — only ever from the arm that
 * HELD the data. */

import type { PublicRepoScan } from "@npmguard/shared";
import { PanelSection } from "../../../components/panel/layout.tsx";
import { ProgressStamp, VerdictStamp } from "../../../components/ui/verdict-stamp.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Card } from "../../../components/ui/card.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import { FOCUS_RING } from "../../../components/ui/focus.ts";
import type { LoadState } from "../../../components/ui/load-state.ts";
import { Progress } from "../../../components/ui/progress.tsx";
import { cn } from "../../../lib/cn.ts";
import { formatDate } from "../../../lib/format.ts";

interface PublicAuditHistoryProps {
  state: LoadState<PublicRepoScan[]>;
  onOpen: (scanId: number) => void;
}

export function PublicAuditHistory({ state, onOpen }: PublicAuditHistoryProps) {
  if (state.status === "loading") return null;
  if (state.status === "failed") {
    // Not inside a `PanelSection`: `DegradedRegion` brings its own titled frame,
    // and two headings would name the section as present and as missing at once.
    return (
      <div className="mt-12">
        <DegradedRegion failure={state.failure} title="Public repository audits" />
      </div>
    );
  }

  // Empty renders nothing, and only from here — the arm that HELD the data. A
  // history section that has never had a row is not worth a box; a history
  // section we could not read is, and that is the arm above.
  const scans = state.data;
  if (scans.length === 0) return null;

  return (
    <PanelSection label="Public repository audits" meta="Read-only snapshots">
      <Card className="overflow-hidden">
        {scans.slice(0, 6).map((scan) => {
          const { total, pending, cached, error, outcome } = scan.set.rollup;
          const running = scan.set.status === "running";
          const completed = total - pending;
          return (
            <div
              key={scan.id}
              className="flex flex-wrap items-center gap-4 border-b border-border-faint px-4 py-3 last:border-b-0"
            >
              <div className="flex min-w-55 flex-[1.4] flex-col items-start gap-1">
                <button
                  type="button"
                  onClick={() => onOpen(scan.id)}
                  className={cn(
                    "rounded-xs font-mono text-sm font-medium text-text",
                    "transition-colors duration-fast hover:text-accent-text",
                    FOCUS_RING,
                  )}
                >
                  {scan.repo.owner}/{scan.repo.name}
                </button>
                <span className="font-mono text-2xs text-text-3">
                  {scan.repo.lockfilePath} · {scan.repo.defaultBranch}
                </span>
                <div className="flex flex-wrap gap-1">
                  {/* All neutral: these describe the audit's BOUNDARY, not its
                      outcome. §3.2 keeps chips uncoloured so the coloured thing
                      on the row is the stamp. */}
                  <Badge>Public</Badge>
                  <Badge>Snapshot</Badge>
                  <Badge>No write</Badge>
                </div>
              </div>

              <div className="flex min-w-45 flex-1 flex-col gap-1.5">
                {running ? (
                  <>
                    <span className="flex items-center gap-2">
                      <ProgressStamp state="running">Scanning</ProgressStamp>
                    </span>
                    {/* Only over a real population — Radix rejects `max={0}`, and a
                        bar over an empty denominator is an invented magnitude. */}
                    {total > 0 && (
                      <Progress
                        value={completed}
                        max={total}
                        label={`${completed}/${total} concluded`}
                      />
                    )}
                  </>
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    {outcome ? <VerdictStamp outcome={outcome} /> : <Badge>Nothing to audit</Badge>}
                    <span className="text-2xs text-text-3">{formatDate(scan.set.finishedAt)}</span>
                  </span>
                )}
                <span className="text-2xs text-text-3">
                  {total} packages · {cached} cached · {error} unresolved
                </span>
              </div>

              <div className="flex flex-col items-end gap-1.5">
                <Button variant="outline" size="sm" onClick={() => onOpen(scan.id)}>
                  {running ? "View progress" : "Report"}
                </Button>
                {/* The "Allowance · <org>" line is gone with the allowance
                    itself (D-1): a public scan is billed to no installation, so
                    naming one under every row would attribute a cost that is not
                    charged anywhere. */}
              </div>
            </div>
          );
        })}
      </Card>
    </PanelSection>
  );
}
