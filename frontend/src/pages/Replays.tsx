/**
 * Replays (/replays) — every audit this engine has finished, watchable again.
 *
 * There is nothing here but a list of links. That is the whole design: the
 * engine already replays any terminal audit from its durable event log at
 * `/audit/{id}/events`, and `AuditRoute` already connects to it, so a gallery
 * needs to produce exactly one thing — the ids. No recording step, no second
 * renderer, no curated copy that could describe a run differently from how it
 * went.
 *
 * A row's link is `/audit/{auditId}`, never `/package/{name}`. The two are not
 * interchangeable: `data/reports/{name}/{version}.json` keeps only the LAST audit
 * of a pair, so a package-keyed link silently repoints the next time that package
 * is audited, while an audit id addresses one run forever. `App.tsx` carries the
 * other half of that guarantee — it suppresses its verdict-time canonicalization
 * while replaying, so following one of these links does not rewrite it away.
 */

import type { ReplayEntry } from "@npmguard/shared";
import { History } from "lucide-react";
import { Link } from "react-router";
import { VerdictStamp } from "../components/ui/verdict-stamp.tsx";
import { PanelPage, SectionLabel } from "../components/panel/layout.tsx";
import { Button } from "../components/ui/button.tsx";
import { DataRegion } from "../components/ui/data-region.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import { useReplays } from "../features/replays/hooks.ts";
import { formatDateTime, formatDuration } from "../lib/format.ts";

export function Replays() {
  const replays = useReplays();

  return (
    <PanelPage>
      <header className="flex flex-col items-start gap-1.5">
        <SectionLabel>Replay</SectionLabel>
        <h1 className="text-2xl font-semibold tracking-tight text-text">Finished audits</h1>
        <p className="max-w-2xl text-sm text-text-2">
          Every audit this engine has completed. Opening one rebuilds the entire run from its
          durable event log — the same phases, in the same order, reaching the same verdict.
        </p>
      </header>

      <DataRegion
        className="mt-8"
        state={replays}
        title="Finished audits"
        // The page's only read: there is no partial page worth keeping around a
        // failure, so the failure gets the whole surface.
        blastRadius="surface"
        empty={{
          message: "No audits have finished on this engine yet.",
          hint: "An audit appears here the moment it reaches a verdict. Nothing has to be recorded first.",
          action: (
            <Button asChild>
              <Link to="/packages">Audit a package</Link>
            </Button>
          ),
        }}
        loading={
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3].map((slot) => (
              <Skeleton key={slot} className="h-row w-full" />
            ))}
          </div>
        }
      >
        {(rows) => (
          <div className="overflow-x-auto">
            <Table label="Finished audits">
              <TableHeader>
                <TableRow>
                  <TableHead>Package</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead>Took</TableHead>
                  <TableHead>Ran</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) => (
                  <ReplayRow key={entry.auditId} entry={entry} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DataRegion>
    </PanelPage>
  );
}

/** One finished audit.
 *
 * `VerdictStamp` renders the verdict even though its declared domain is the panel
 * `Outcome`: SAFE|DANGEROUS is a subset of it, and this page can never produce
 * ERROR because an audit that could not conclude has no report and is not listed.
 * Reaching for the panel's stamp rather than writing a second one is deliberate —
 * `tone.tsx` already records that it is the one instance of a component the
 * design system has not yet promoted, and a local copy here would make it two.
 */
function ReplayRow({ entry }: { entry: ReplayEntry }) {
  return (
    <TableRow>
      <TableCell>
        <Link
          to={`/audit/${entry.auditId}`}
          className="font-mono text-text hover:underline"
          aria-label={`replay the audit of ${entry.packageName}`}
        >
          <History aria-hidden="true" className="mr-1.5 inline size-icon-sm align-[-2px]" />
          {entry.packageName}
        </Link>
      </TableCell>
      {/* An audit can finish without ever resolving a registry version (a local
          fixture never does). The engine sends null rather than inventing one, so
          the cell says so rather than showing a blank that reads as a bug. */}
      <TableCell className="font-mono tabular-nums text-text-2">
        {entry.version ?? <span className="text-text-3">unversioned</span>}
      </TableCell>
      <TableCell>
        <VerdictStamp outcome={entry.verdict} />
      </TableCell>
      <TableCell className="font-mono tabular-nums text-text-2">
        {formatDuration(entry.durationMs)}
      </TableCell>
      <TableCell className="text-text-3">{formatDateTime(entry.recordedAt)}</TableCell>
    </TableRow>
  );
}
