/** Public snapshot report.
 *
 * The detail body is fetched once and then advanced by the audit-set progress
 * STREAM — the same `/panel/scan/:id/events` an owned-repo scan uses, because
 * after R-1 a public audit is the same entity and its id IS a set id. The 2.5s
 * self-poll this replaced was the second progress implementation.
 *
 * ── PRESENTATION: what the recomposition changed ────────────────────────────
 *
 * Nothing about what this dialog fetches, streams, or decides. Three things about
 * what it says, and two are §3.4 corrections:
 *
 * 1. **"No npm dependencies in this lockfile" was a hand-written `.empty-state`
 *    box.** It is unreachable from a failure today only because of where the guard
 *    happens to sit — which is exactly the arrangement `EmptyState` exists to
 *    replace, since the next edit to the guard silently turns it into a failed
 *    read rendering as an absence of dependencies. It now demands `state.read`,
 *    the token minted from THIS read and impossible to forge, so the branch cannot
 *    be reached without the data behind it. That is why `state` is narrowed to an
 *    `ok` object below rather than flattened to `data | null`: flattening threw
 *    the token away.
 * 2. **The six-cell `panel-summary` is a `SeverityRibbon` plus a prose line.** The
 *    old grid coloured a bare NUMBER red/violet/green when it was non-zero, which
 *    is colour-only encoding (§2.4) and put the danger hue on a count rather than
 *    on a claim. The ribbon is the primitive §3.2 names for a set rollup: fixed
 *    DANGEROUS·ERROR·SAFE·pending order so the eye lands on danger first even when
 *    it is the smallest segment, a hatched pending segment so an in-flight
 *    snapshot cannot read as green, and every segment labelled in words. `total`
 *    and `cached` are not severity buckets and were never part of the partition,
 *    so they read as prose beneath — where §4.2 wants the group words anyway,
 *    because "could not conclude" is the phrase that teaches the two-axis model.
 * 3. **The truncation notice was `banner--suspect` — amber, a retired outcome
 *    hue.** DECISION the brief left open: it is achromatic now. "You are seeing
 *    the top 500 of N" is a fact about this VIEW, not a finding and not a failure;
 *    the sentence itself says the summary above still covers the whole lockfile,
 *    so a hue would raise an alarm the copy then withdraws.
 *
 * `layout="scroll"` is what this surface actually wants — it is the long one, and
 * losing the title and close button at the bottom of 500 rows is the defect that
 * variant fixes. `PanelDialog` pins `layout="fit"` and does not expose it, so this
 * still scrolls whole-box exactly as the legacy shell did. Reported rather than
 * worked around; `DialogBody` is not used for the same reason (see `UpgradeDialog`). */

import type { AuditSetItem } from "@npmguard/shared";
import { ExternalLink, X } from "lucide-react";
import { SectionLabel } from "../../../components/panel/layout.tsx";
import { PanelDialog } from "../../../components/panel/PanelDialog.tsx";
import { depTone, toneSeverity } from "../../../components/panel/tone.tsx";
import { ProgressStamp, VerdictStamp } from "../../../components/ui/verdict-stamp.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import { DialogHeader } from "../../../components/ui/dialog.tsx";
import { EmptyState } from "../../../components/ui/empty-state.tsx";
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
import { formatDate } from "../../../lib/format.ts";
import { usePublicScanDetail, usePublicScanStream } from "../hooks.ts";

function depReason(dep: AuditSetItem): string {
  if (dep.verdictReason) return dep.verdictReason;
  // ERROR carries no reason of its own: the audit never produced one. A null
  // outcome always has a live attempt behind it.
  if (dep.outcome === "ERROR") return "Audit could not be completed";
  if (dep.outcome === null) return "Audit in progress";
  return "—";
}

interface PublicAuditReportDialogProps {
  scanId: number;
  onClose: () => void;
}

export function PublicAuditReportDialog({ scanId, onClose }: PublicAuditReportDialogProps) {
  const state = usePublicScanDetail(scanId);
  // The narrowed STATE, not just its data: `state.read` is what `EmptyState`
  // demands below, and it exists on this arm only.
  const ok = state.status === "ok" ? state : null;
  const data = ok?.data ?? null;

  // Follow the set's progress stream while it is live. The stream writes into the
  // query cache, so there is no second copy of `deps` to keep in step — and the
  // 2.5s self-poll this replaced was the second progress implementation.
  usePublicScanStream(scanId, data?.scan.set.status === "running");

  const scan = data?.scan ?? null;
  const running = scan?.set.status === "running";
  const rollup = scan?.set.rollup ?? null;
  const completed = rollup ? rollup.total - rollup.pending : 0;

  return (
    <PanelDialog ariaLabel={`Public audit snapshot ${scanId}`} onClose={onClose} wide>
      <DialogHeader className="flex-row items-start justify-between gap-3 pr-5">
        <div className="flex min-w-0 flex-col items-start gap-1">
          <SectionLabel>Snapshot #{scanId}</SectionLabel>
          {/* Never "Loading snapshot" over a failed read — the body already says
              what broke, and a title that claims progress contradicts it. */}
          <h2 className="text-xl font-semibold text-text">
            {scan
              ? scan.repo.fullName
              : state.status === "failed"
                ? "Snapshot unavailable"
                : "Loading snapshot"}
          </h2>
          {scan && (
            <p className="font-mono text-2xs text-text-3">
              {scan.repo.lockfilePath} · {scan.repo.defaultBranch} ·{" "}
              {formatDate(scan.set.startedAt)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {scan &&
            (running ? (
              <ProgressStamp state="running">Running</ProgressStamp>
            ) : scan.set.rollup.outcome ? (
              <VerdictStamp outcome={scan.set.rollup.outcome} />
            ) : (
              <Badge>Nothing to audit</Badge>
            ))}
          {scan && (
            <Button asChild variant="outline" size="sm">
              <a href={scan.repo.htmlUrl} target="_blank" rel="noreferrer">
                Open on GitHub <ExternalLink aria-hidden="true" className="size-icon-sm" />
              </a>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Close"
            className="size-control-sm shrink-0 px-0"
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-icon" />
          </Button>
        </div>
      </DialogHeader>

      <div className="flex flex-col gap-3.5 px-5 py-4">
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
                the header stamp already says "Nothing to audit". */}
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
                Showing the 500 highest-priority dependencies — the summary above covers the full
                lockfile.
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
    </PanelDialog>
  );
}
