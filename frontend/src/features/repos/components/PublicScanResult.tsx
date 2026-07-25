/** The body of a public-repo snapshot: boundary badges, progress, the severity
 * ribbon, the coverage statement, and the dependency table.
 *
 * Extracted from `PublicAuditReportDialog` when `/scan` (F-H6) arrived, and
 * extracted rather than copied for the reason R-1 exists: two renderers of one
 * fact eventually disagree about it, and the fact here is a security posture.
 * The dialog keeps its chrome and the page keeps its hero; what a snapshot MEANS
 * is written once, below.
 *
 * ── The coverage statement, and why it exists ───────────────────────────────
 *
 * `repo.lockfileDepCount` is what the LOCKFILE held; `set.rollup.total` is what
 * this scan COVERS. They differ when the per-user cost ceiling bound the scan
 * (D-1 / F-F6): past it a scan is served from cached verdicts rather than
 * refused, so it answers for fewer packages than the repo has.
 *
 * That gap is stated in words, and it is not decoration. §0 rule 1: SAFE does not
 * mean "this package is safe", it means "this audit found nothing it could
 * confirm" — and a partial scan reported as a whole one is the same credibility
 * failure one step earlier, at the level of the repository. The line renders
 * whenever coverage is short, next to the ribbon, so it cannot be read
 * separately from the posture it qualifies.
 *
 * Achromatic, like the truncation notice beside it and for the same §0 rule 2
 * reason: "we audited 150 of 900" is a fact about this scan's REACH, not a
 * finding and not a failure. Hue here would raise an alarm the sentence does not
 * support. It is deliberately NOT the hatch either — hatch means "no signal
 * here", and the packages that were covered carry real signal. */

import type { AuditSetItem, PublicRepoScanDetailResponse } from "@npmguard/shared";
import { depTone, toneSeverity } from "../../../components/panel/tone.tsx";
import { ProgressStamp, VerdictStamp } from "../../../components/ui/verdict-stamp.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import { EmptyState } from "../../../components/ui/empty-state.tsx";
import type { LoadState } from "../../../components/ui/load-state.ts";
import { Progress } from "../../../components/ui/progress.tsx";
import { SeverityRibbon } from "../../../components/ui/severity-ribbon.tsx";
import { Skeleton } from "../../../components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table.tsx";

function depReason(dep: AuditSetItem): string {
  if (dep.verdictReason) return dep.verdictReason;
  // ERROR carries no reason of its own: the audit never produced one. A null
  // outcome always has a live attempt behind it.
  if (dep.outcome === "ERROR") return "Audit could not be completed";
  if (dep.outcome === null) return "Audit in progress";
  return "—";
}

export function PublicScanResult({
  state,
}: {
  state: LoadState<PublicRepoScanDetailResponse>;
}) {
  // The narrowed STATE, not just its data: `state.read` is what `EmptyState`
  // demands below, and it exists on this arm only.
  const ok = state.status === "ok" ? state : null;
  const data = ok?.data ?? null;
  const scan = data?.scan ?? null;
  const rollup = scan?.set.rollup ?? null;
  const running = scan?.set.status === "running";
  const completed = rollup ? rollup.total - rollup.pending : 0;
  // Coverage short of the lockfile. `>` and not `!==`: a set can never cover MORE
  // pairs than the lockfile held, so the other direction is a bug upstream and
  // is not a state to render copy for.
  const uncovered = scan && rollup ? scan.repo.lockfileDepCount - rollup.total : 0;

  return (
    <div className="flex flex-col gap-3.5">
      {state.status === "loading" && (
        // `aria-busy` plus ONE sr-only announcement, and skeletons only where
        // the final dimensions are known (§3.1) — the ribbon band and the first
        // few table rows. A spinner per placeholder announces the wait N times.
        <div role="status" aria-busy="true" className="flex flex-col gap-3.5">
          <span className="sr-only">Loading snapshot</span>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}
      {state.status === "failed" && <DegradedRegion failure={state.failure} title="Snapshot" />}
      {ok && data && scan && rollup && (
        <>
          <div className="flex flex-wrap gap-1">
            {/* Neutral throughout: these state the audit's BOUNDARY, which is
                metadata about how the snapshot was taken and not an outcome. */}
            <Badge>Read-only snapshot</Badge>
            <Badge>No protect</Badge>
            <Badge>No webhook</Badge>
            <Badge>No GitHub check</Badge>
          </div>

          {running && rollup.total > 0 && (
            <Progress
              value={completed}
              max={rollup.total}
              label={`${completed}/${rollup.total} resolved`}
            />
          )}

          {/* Rendered only over a population. The ribbon's own all-zero fallback
              is a bare hatched bar, and its docblock says a caller should put a
              real state around that rather than ship a mystery bar — here the
              honest rendering for a lockfile with nothing in it is no bar, and
              the caller's stamp already says "Nothing to audit". */}
          {rollup.total > 0 && (
            <div className="flex flex-col gap-2">
              <SeverityRibbon
                dangerous={rollup.dangerous}
                error={rollup.error}
                safe={rollup.safe}
                pending={rollup.pending}
              />
              <p className="text-2xs text-text-3">
                <span className="font-mono tabular-nums">{rollup.total}</span> packages ·{" "}
                <span className="font-mono tabular-nums">{rollup.dangerous}</span> dangerous ·{" "}
                <span className="font-mono tabular-nums">{rollup.error}</span> could not conclude ·{" "}
                <span className="font-mono tabular-nums">{rollup.safe}</span> no threat found ·{" "}
                <span className="font-mono tabular-nums">{rollup.cached}</span> reused from cache
              </p>
              {uncovered > 0 && (
                <p className="text-2xs text-text-2">
                  This scan covers{" "}
                  <span className="font-mono tabular-nums">{rollup.total}</span> of the lockfile&rsquo;s{" "}
                  <span className="font-mono tabular-nums">{scan.repo.lockfileDepCount}</span>{" "}
                  packages. The other{" "}
                  <span className="font-mono tabular-nums">{uncovered}</span> were not audited and
                  this snapshot says nothing about them.
                </p>
              )}
              {rollup.pending > 0 && (
                // The progress axis refusing to masquerade as a verdict. Without
                // this line a half-finished snapshot reads as a settled posture.
                <p className="text-2xs text-progress-ink">
                  <span className="font-mono tabular-nums">{rollup.pending}</span> still running —
                  posture may change
                </p>
              )}
            </div>
          )}

          {data.depsTruncated && (
            <p className="rounded-md border border-border bg-sunken px-2.5 py-2 text-xs text-text-2">
              Showing the 500 highest-priority dependencies — the summary above covers everything
              this scan audited.
            </p>
          )}

          {data.deps.length === 0 ? (
            <EmptyState
              read={ok.read}
              message="No npm dependencies in this lockfile."
              hint="A lockfile can resolve to nothing auditable — a workspace root, or a project whose only dependencies are not npm packages."
            />
          ) : (
            // Wide content scrolls inside its own container, never the page
            // body. Plain overflow rather than `ScrollArea`: §3.1 forbids
            // nesting a second scroll region inside the page scroll, and this
            // one is horizontal only.
            //
            // NOT `TableHeader sticky`, deliberately. `position: sticky`
            // resolves against the nearest scroll container, and this
            // `overflow-x-auto` is one — so `sticky top-0` would pin to a box
            // that never scrolls vertically and the prop would be decoration.
            <div className="overflow-x-auto">
              <Table density="dense" label="Snapshot dependencies">
                <TableHeader>
                  <tr>
                    <TableHead>Dependency</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Reason</TableHead>
                  </tr>
                </TableHeader>
                <TableBody>
                  {data.deps.map((dep) => (
                    <TableRow
                      key={`${dep.name}@${dep.version}`}
                      // Severity as the §2.8 3px left rule, never a row fill:
                      // whole-row tinting is reserved for log and evidence
                      // panes, and on 500 rows it turns a table into wallpaper.
                      severity={toneSeverity(depTone(dep))}
                    >
                      <TableCell className="font-mono text-text">
                        {dep.name}@{dep.version}
                      </TableCell>
                      <TableCell className="text-text-2">
                        <span className="flex flex-col gap-0.5">
                          {dep.direct ? "Direct" : "Transitive"}
                          {dep.cached && <span className="text-2xs text-text-3">Cached verdict</span>}
                        </span>
                      </TableCell>
                      <TableCell>
                        {dep.outcome ? (
                          <VerdictStamp outcome={dep.outcome} />
                        ) : (
                          <ProgressStamp state="queued">Queued</ProgressStamp>
                        )}
                      </TableCell>
                      <TableCell className="max-w-80 text-text-2">{depReason(dep)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
