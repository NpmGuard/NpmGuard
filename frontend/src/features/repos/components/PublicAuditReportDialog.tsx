/** Public snapshot report.
 *
 * The detail body is fetched once and then advanced by the audit-set progress
 * STREAM — the same `/panel/scan/:id/events` an owned-repo scan uses, because
 * a public audit is the same entity as any other set and its id IS a set id, so
 * there is no second progress implementation here.
 *
 * ── PRESENTATION ────────────────────────────────────────────────────────────
 *
 * 1. **"No npm dependencies in this lockfile" is an `EmptyState`, not a
 *    hand-written box.** A hand-written box is unreachable from a failure only
 *    because of where the guard happens to sit, and the next edit to that guard
 *    silently turns it into a failed read rendering as an absence of
 *    dependencies. `EmptyState` demands `state.read`, the token minted from THIS
 *    read and impossible to forge, so the branch cannot be reached without the
 *    data behind it. That is why `state` is narrowed to an `ok` object below
 *    rather than flattened to `data | null`: flattening throws the token away.
 * 2. **The rollup is a `SeverityRibbon` plus a prose line, not a grid of
 *    counts.** Colouring a bare NUMBER red/violet/green when it is non-zero is
 *    colour-only encoding (§2.4) and puts the danger hue on a count rather than
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

import { ExternalLink, X } from "lucide-react";
import { SectionLabel } from "../../../components/panel/layout.tsx";
import { PanelDialog } from "../../../components/panel/PanelDialog.tsx";
import { ProgressStamp, VerdictStamp } from "../../../components/ui/verdict-stamp.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { DialogHeader } from "../../../components/ui/dialog.tsx";
import { formatDate } from "../../../lib/format.ts";
import { usePublicScanDetail, usePublicScanStream } from "../hooks.ts";
import { PublicScanResult } from "./PublicScanResult.tsx";

interface PublicAuditReportDialogProps {
  scanId: number;
  onClose: () => void;
}

export function PublicAuditReportDialog({ scanId, onClose }: PublicAuditReportDialogProps) {
  const state = usePublicScanDetail(scanId);
  const data = state.status === "ok" ? state.data : null;

  // Follow the set's progress stream while it is live. The stream writes into the
  // query cache, so there is no second copy of `deps` to keep in step — and the
  // 2.5s self-poll this replaced was the second progress implementation.
  usePublicScanStream(scanId, data?.scan.set.status === "running");

  const scan = data?.scan ?? null;
  const running = scan?.set.status === "running";

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

      <div className="px-5 py-4">
        {/* The snapshot body is `PublicScanResult` — the SAME component `/scan`
            renders. What a snapshot means is written once; this dialog owns only
            the chrome around it. */}
        <PublicScanResult state={state} />
      </div>
    </PanelDialog>
  );
}
