/**
 * Replays (/replays) — every audit this engine has finished, watchable again.
 *
 * ── ONE JOB: choose an investigation worth watching ─────────────────────────
 *
 * So the page leads with the runs that actually PLAY. An audit recorded before
 * the stream carried experiment, sandbox and judgment frames has no
 * investigation to animate — opening it lands on a static report — and the row
 * says so here rather than letting somebody find out by clicking. Those rows are
 * still listed, collapsed, because they are real audits and hiding them would
 * make the gallery look emptier than the engine is.
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
import { REPLAY_FORMAT } from "@npmguard/shared";
import { History } from "lucide-react";
import { Link } from "react-router";
import { VerdictStamp } from "../components/ui/verdict-stamp.tsx";
import {
  NothingToDo,
  QuietGroup,
  WorkspaceBody,
  WorkspaceHeader,
  WorkspacePage,
  WorkspaceSection,
} from "../components/shell/workspace.tsx";
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

  const playable = replays.status === "ok" ? replays.data.filter(isPlayable) : [];
  const archived = replays.status === "ok" ? replays.data.filter((row) => !isPlayable(row)) : [];

  return (
    <WorkspacePage>
      <WorkspaceHeader
        title="Replays"
        lede="Every audit this engine has completed. Opening one rebuilds the run from its durable event log — the same steps, in the same order, reaching the same verdict."
        meta={replays.status === "ok" ? `${playable.length} playable` : undefined}
      />

      <WorkspaceBody>
        <DataRegion
          state={replays}
          title="Finished audits"
          // The page's only read: there is no partial page worth keeping around
          // a failure, so the failure gets the whole surface.
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
          {() => (
            <>
              <WorkspaceSection
                label="Watchable investigations"
                meta={`${playable.length} of ${playable.length + archived.length}`}
              >
                {playable.length === 0 ? (
                  <NothingToDo>
                    No audit on this engine carries the event format the animated replay needs.
                    Every run below still opens as a static report.
                  </NothingToDo>
                ) : (
                  <ReplayTable label="Watchable investigations" rows={playable} />
                )}
              </WorkspaceSection>

              <WorkspaceSection label="Archived">
                <QuietGroup
                  label="Audits recorded before the evidence graph"
                  count={archived.length}
                >
                  <ReplayTable label="Archived audits" rows={archived} />
                </QuietGroup>
              </WorkspaceSection>
            </>
          )}
        </DataRegion>
      </WorkspaceBody>
    </WorkspacePage>
  );
}

/** Does this run carry the frames the animated replay is made of?
 *
 * Read off the entry, never guessed from a date: the engine reports what each
 * stream announced, and a cutoff would be a guess dressed as a fact. */
function isPlayable(entry: ReplayEntry): boolean {
  return entry.replayVersion >= REPLAY_FORMAT;
}

function ReplayTable({ label, rows }: { label: string; rows: ReplayEntry[] }) {
  return (
    <div className="overflow-x-auto">
      <Table label={label}>
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
      <TableCell className="text-text-3">
        {formatDateTime(entry.recordedAt)}
        {!isPlayable(entry) ? (
          <span className="ms-2 font-mono text-2xs text-text-3">static report</span>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
