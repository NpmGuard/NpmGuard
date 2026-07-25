/** Repository detail: overview posture, review queue, and the full
 * dependency inventory. While a scan is running it follows ONE scan-events SSE
 * stream (unnamed messages: dep snapshots, progress ticks, done).
 *
 * The page holds no copy of the response. The old version kept the detail in
 * `useState` and the stream wrote into that copy, which made the fetched value
 * and the streamed value two facts about one thing — and the page then had to
 * reconcile them by hand on every action (`toggleProtect` re-read the store to
 * decide whether its own optimistic write was safe). Now the query cache is the
 * single source of truth and the stream is one of its writers.
 *
 * ── PRESENTATION ────────────────────────────────────────────────────────────
 *
 * 1. The posture rail HATCHES its pending segment rather than painting it blue.
 *    §2.2 rule 2 makes the progress axis achromatic and confines accent to the
 *    moving part of a spinner, precisely so an in-flight scan cannot read as a
 *    verdict — which is `SeverityRibbon`'s stated reason to exist.
 * 2. Severity reaches a row as a stamp with a glyph plus the §2.8 3px left rule,
 *    never as a coloured dot. §2.4 requires glyph + word + colour, in that order:
 *    "remove all colour from the UI and every state is still readable".
 * 3. A rejected mutation lands in the `error` slot — the same "we don't know"
 *    slot as audit ERROR — never RED. §0 rule 3 reserves red for claims about a
 *    package, and this is a failure of our own plumbing.
 * 4. "No baseline" and "nothing matches this view" go through the
 *    `DataRegion`/`EmptyState` chokepoint, so a read failure has no code path
 *    that lands on either.
 *
 * `RepoDetail.test.tsx` passes unmodified, which is the intended proof that the
 * page's decisions are untouched.
 */

import type { AuditSetItem } from "@npmguard/shared";
import { ArrowLeft, ChevronRight, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { PanelPage, PanelSection, SectionLabel } from "../components/panel/layout.tsx";
import {
  depPriority,
  depTone,
  outcomeTone,
  toneSeverity,
  type Tone,
} from "../components/panel/tone.tsx";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardBody } from "../components/ui/card.tsx";
import { DataRegion } from "../components/ui/data-region.tsx";
import { DegradedSurface } from "../components/ui/degraded-state.tsx";
import { SearchInput } from "../components/ui/input.tsx";
import { ProgressStamp, VerdictStamp } from "../components/ui/verdict-stamp.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { loaded } from "../components/ui/load-state.ts";
import { SeverityRibbon } from "../components/ui/severity-ribbon.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Switch } from "../components/ui/switch.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import { UpgradeDialog } from "../features/billing/components/UpgradeDialog.tsx";
import {
  useRepoDetail,
  useRepoDetailStream,
  useResync,
  useSetProtect,
  useTriggerScan,
} from "../features/repos/hooks.ts";
import { cn } from "../lib/cn.ts";
import { formatDate } from "../lib/format.ts";
import { actionFailure } from "../lib/query-state.ts";
import { usePanelUi } from "../stores/panelStore.ts";

type DepFilter = "all" | "flagged" | "direct" | "pending";
const PAGE = 100;

/** The rollup of a repo that has never been scanned: a set of nothing. Zeroes
 * rather than null, so the rail, the tiles and the counters read one shape and no
 * consumer branches on "is there a set" to answer "how many are dangerous". The
 * "never scanned" vs "nothing to audit" distinction is made ONCE, from `set`
 * itself, where it actually lives. */
const NO_SET_ROLLUP = {
  outcome: null,
  total: 0,
  safe: 0,
  dangerous: 0,
  error: 0,
  pending: 0,
  cached: 0,
} as const;

const DEP_FILTERS: { key: DepFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "flagged", label: "Flagged" },
  { key: "direct", label: "Direct" },
  { key: "pending", label: "Pending" },
];

function DepStatusPill({ dep }: { dep: AuditSetItem }) {
  // Outcome first, progress only for the not-concluded case: a null outcome
  // ALWAYS resolves itself (a job is live), so it gets a spinner and never the
  // "Audit failed" copy — that belongs to ERROR, which needs a retry.
  if (dep.outcome) return <VerdictStamp outcome={dep.outcome} />;
  if (dep.jobState === "running") return <ProgressStamp state="running">Auditing</ProgressStamp>;
  return <ProgressStamp state="queued">Queued</ProgressStamp>;
}

/** One row of the review queue. A real `<Link>`, not a `<button onClick={navigate}>`:
 * these go to a canonical report URL, and a button that navigates cannot be
 * middle-clicked, opened in a new tab, or announced as a link. */
function QueueRow({
  to,
  name,
  version,
  stamp,
  meta,
  severity,
}: {
  to: string;
  name: string;
  version: string;
  stamp: ReactNode;
  meta: string;
  severity: "danger" | "error" | undefined;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-3 border-b border-border-faint px-4 py-2.5 text-sm last:border-b-0",
        "transition-colors duration-fast hover:bg-sunken",
        // §2.8's 3px rule, with a transparent one on unruled rows so nothing
        // shifts 3px when severity changes.
        "border-l-[length:var(--ng-border-rule)]",
        severity === "danger"
          ? "border-l-danger"
          : severity === "error"
            ? "border-l-error"
            : "border-l-transparent",
      )}
    >
      <span className="min-w-0 truncate font-mono text-sm text-text">
        {name}@{version}
      </span>
      {stamp}
      <span className="ms-auto flex items-center gap-1 whitespace-nowrap text-2xs text-text-3">
        {meta}
        <ChevronRight aria-hidden="true" className="size-icon-sm" />
      </span>
    </Link>
  );
}

export function RepoDetail() {
  const params = useParams<{ owner: string; name: string }>();
  const owner = params.owner ?? "";
  const name = params.name ?? "";

  const state = useRepoDetail(owner, name);
  const detail = state.status === "ok" ? state.data : null;
  const triggerScan = useTriggerScan();
  const setProtect = useSetProtect();
  const resync = useResync();
  const paywall = usePanelUi((s) => s.paywall);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DepFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const inventoryRef = useRef<HTMLElement | null>(null);
  const protectLabelId = useId();

  // ONE stream per live set, writing into the query cache: a dep frame REPLACES
  // the matching item (the frame carries the whole contract item, not a lossier
  // subset), a progress frame replaces the set's status + rollup, and the
  // terminal frame invalidates so the authoritative response lands. Every frame
  // is a snapshot, so a Last-Event-ID replay is idempotent without a seq guard.
  useRepoDetailStream(owner, name, detail?.set?.status === "running" ? detail.set.id : null);

  useEffect(() => {
    setQuery("");
    setFilter("all");
    setVisibleCount(PAGE);
  }, [owner, name]);

  useEffect(() => {
    setVisibleCount(PAGE);
  }, [query, filter]);

  const deps = useMemo(() => detail?.deps ?? [], [detail]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return deps
      .filter((dep) => {
        // "Flagged" is what needs a human: confirmed danger, or an audit that
        // could not conclude. A pending dep is neither — it resolves itself.
        if (filter === "flagged" && dep.outcome !== "DANGEROUS" && dep.outcome !== "ERROR")
          return false;
        if (filter === "direct" && !dep.direct) return false;
        if (filter === "pending" && dep.outcome !== null) return false;
        if (q && !`${dep.name}@${dep.version}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort(
        (a, b) =>
          depPriority(a) - depPriority(b) ||
          Number(b.direct) - Number(a.direct) ||
          a.name.localeCompare(b.name),
      );
  }, [deps, filter, query]);

  const queueDeps = useMemo(
    () =>
      deps
        .filter((dep) => dep.outcome === "DANGEROUS" || dep.outcome === "ERROR")
        .sort((a, b) => depPriority(a) - depPriority(b) || a.name.localeCompare(b.name))
        .slice(0, 4),
    [deps],
  );

  if (state.status === "loading") {
    return (
      <PanelPage>
        <div role="status" aria-busy="true" className="flex flex-col gap-6">
          <span className="sr-only">Loading repository</span>
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </PanelPage>
    );
  }

  // A repo we cannot read is a FAILED read, not an empty one — hence a degraded
  // surface rather than an empty-state box. The distinction matters most in
  // exactly this case: "no dependencies" and "we could not see this repository"
  // look identical in a grey box.
  //
  // A 404 offers no retry (there is nothing to retry into) but does offer a way
  // out; anything else offers the retry the query itself provides. Both come from
  // `Failure` rather than from a branch here — `retryable()` is the one policy.
  if (state.status === "failed") {
    return (
      <PanelPage>
        <DegradedSurface
          failure={state.failure}
          escape={{ label: "Back to dashboard", href: "/dashboard" }}
        />
      </PanelPage>
    );
  }

  // The `ok` arm always carries data, so no `|| detail === null` guard is
  // reachable here. Reading `state.data` directly is what keeps `state.read` in
  // scope — the token below is minted from this read and from nothing else.
  const detailOk = state.data;
  const repo = detailOk.repo;
  const scan = detailOk.set;
  const alerts = detailOk.alerts;
  // One banner over three mutations: each holds its own error, and a cap is
  // filtered out because the paywall dialog owns it.
  const actionFailed =
    actionFailure(triggerScan.error, "Starting the audit") ??
    actionFailure(setProtect.error, "Changing protection") ??
    actionFailure(resync.error, "Re-syncing the lockfile");
  const busy = triggerScan.isPending || setProtect.isPending || resync.isPending;

  // The ONE rollup, computed server-side over THIS SET's items — the same
  // population `deps` carries, so summing deps reproduces it. Recomputing the
  // counters client-side from `deps` while the engine sends a rollup over the
  // repo's dep INDEX is three implementations of one sum over two populations.
  const rollup = scan?.rollup ?? NO_SET_ROLLUP;
  const running = scan?.status === "running";
  const completed = rollup.total - rollup.pending;
  const pct = rollup.total > 0 ? Math.round((completed / rollup.total) * 100) : 0;
  const flagged = rollup.dangerous + rollup.error;
  const checked = completed;

  const lastScanCopy = scan
    ? `Last ${scan.trigger} scan started ${formatDate(scan.startedAt)}`
    : "Run the first audit to establish a dependency baseline.";

  let overview: { label: string; tone: Tone; copy: string };
  if (running) {
    overview = {
      label: `Scan in progress · ${pct}%`,
      tone: "running",
      copy: `${pct}% complete · ${rollup.cached} results reused from cache`,
    };
  } else if (scan === null || rollup.total === 0) {
    overview = {
      label: scan === null ? "Not audited" : "Nothing to audit",
      tone: "unknown",
      copy:
        scan === null
          ? "Run the first audit to establish a dependency baseline."
          : "This commit's lockfile declares no npm dependencies.",
    };
  } else if (rollup.dangerous > 0) {
    overview = { label: "Action required", tone: "danger", copy: lastScanCopy };
  } else if (rollup.error > 0) {
    // Severity DANGEROUS > ERROR > SAFE: audits that could not conclude are a
    // coverage gap, so this repo is NOT reported as having no known threats.
    overview = {
      label: `${rollup.error} could not be audited`,
      tone: "error",
      copy: lastScanCopy,
    };
  } else if (rollup.pending > 0) {
    overview = { label: "Coverage incomplete", tone: "unknown", copy: lastScanCopy };
  } else {
    overview = { label: "No known threats", tone: "safe", copy: lastScanCopy };
  }

  const filterCounts: Record<DepFilter, number> = {
    all: deps.length,
    flagged,
    direct: deps.filter((dep) => dep.direct).length,
    pending: rollup.pending,
  };

  // No hand-written reload and no local re-derivation of what succeeded: each
  // mutation's `onSuccess` already patches or invalidates the entries it
  // invalidated, so a successful protect flips the flag everywhere it is shown
  // and a failed one flips nothing.
  const dismissActionFailure = () => {
    triggerScan.reset();
    setProtect.reset();
    resync.reset();
  };

  const reviewFlagged = () => {
    setFilter("flagged");
    inventoryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const resetFilters = () => {
    setQuery("");
    setFilter("all");
  };

  return (
    <PanelPage>
      {/* A link, not a `navigate()` button — same destination, but back-to-parent
          is navigation and belongs on an `<a>`. */}
      <Button asChild variant="ghost" size="sm" className="-ms-2 mb-2">
        <Link to="/dashboard">
          <ArrowLeft aria-hidden="true" className="size-icon-sm" /> Dashboard
        </Link>
      </Button>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col items-start gap-1.5">
          <SectionLabel>{repo.owner}</SectionLabel>
          <h1 className="text-2xl font-semibold tracking-tight text-text">{repo.name}</h1>
          <div className="flex flex-wrap items-center gap-2">
            <Badge mono>{repo.defaultBranch}</Badge>
            {repo.private && <Badge>Private</Badge>}
            {/* Neutral either way. Protection is a system setting, not an outcome
                — §3.2 keeps chips almost always uncoloured so the one coloured
                thing on a row is the verdict. */}
            <Badge>{repo.protected ? "Continuous protection" : "Manual monitoring"}</Badge>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col items-start gap-1">
            {/* `aria-labelledby` to a real node rather than an `aria-label`
                string: Radix renders the switch as a `<button role="switch">`,
                which `<label for>` cannot legally associate with, and a duplicated
                string is a thing that drifts. */}
            <span id={protectLabelId} className="text-2xs font-medium text-text-2">
              Protect
            </span>
            <span className="flex items-center gap-2">
              {/* §3.1 inventories Protect as a `Switch`, and the semantics matter:
                  a toggle announces its on/off state, a button announces a label
                  that has to encode it ("Protected" vs "Protect").
                  `checked` is NOT optimistic, deliberately — `useSetProtect`
                  patches on success only, because Protect can be refused by a 402
                  cap and a security product must never flash a protection state
                  it does not have. `pending` therefore means "in flight", and it
                  contributes the shimmer and `aria-busy` without moving the
                  thumb. */}
              <Switch
                checked={repo.protected}
                pending={setProtect.isPending}
                disabled={busy}
                aria-labelledby={protectLabelId}
                onCheckedChange={(on) => setProtect.mutate({ repoId: repo.id, on })}
              />
              {repo.protected && (
                <ShieldCheck aria-hidden="true" className="size-icon-sm text-accent-text" />
              )}
            </span>
          </div>
          <Button
            disabled={running || busy}
            onClick={() => triggerScan.mutate(repo.id)}
          >
            {triggerScan.isPending
              ? "Starting…"
              : running
                ? "Scanning…"
                : scan
                  ? "Run audit again"
                  : "Run first audit"}
          </Button>
          <Button
            variant="outline"
            disabled={busy || running}
            title="Re-read the lockfile from GitHub"
            onClick={() => resync.mutate(repo.id)}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(
                "size-icon-sm",
                resync.isPending && "animate-spin motion-reduce:animate-none",
              )}
            />{" "}
            {resync.isPending ? "Re-syncing…" : "Re-sync"}
          </Button>
        </div>
      </header>

      {actionFailed && (
        // The `error` slot, not `danger`: a rejected action is our plumbing
        // failing, and §0 rule 3 keeps red for claims about a package. No hatch —
        // hatch means "no signal here", and this region has not gone missing; a
        // request was answered, with a refusal.
        <div
          role="alert"
          className="mt-6 flex items-center justify-between gap-3 rounded-lg border border-error-border bg-error-wash px-3 py-2 text-sm text-error-text"
        >
          <span>{`${actionFailed.what} failed — ${actionFailed.detail ?? "no detail"}`}</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Dismiss error"
            className="size-control-sm shrink-0 px-0 text-error-text"
            onClick={dismissActionFailure}
          >
            <X aria-hidden="true" className="size-icon-sm" />
          </Button>
        </div>
      )}

      {/* `role="group"` is what makes the label meaningful — an `aria-label` on a
          bare `<div>` is dropped by assistive tech, which is what the legacy
          markup did. */}
      <Card
        className="mt-6"
        severity={toneSeverity(overview.tone)}
        role="group"
        aria-label="Audit posture"
      >
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-text">{overview.label}</h2>
              <p className="text-sm text-text-2">
                {checked} of {rollup.total} dependencies checked
              </p>
            </div>
            <p className="text-2xs text-text-3">{overview.copy}</p>
          </div>

          {/* Rendered only over a population. `SeverityRibbon`'s own all-zero
              fallback is a bare hatched bar, and its docblock says callers should
              put a real state around that rather than ship a mystery bar — for an
              unaudited repo the honest rendering is no bar at all, and the label
              above already says "Not audited". */}
          {rollup.total > 0 && (
            <>
              <SeverityRibbon
                dangerous={rollup.dangerous}
                error={rollup.error}
                safe={rollup.safe}
                pending={rollup.pending}
              />
              {/* §4.2's prose summary. The group words do the teaching that the
                  enum names cannot: "could not conclude" is neither safe nor
                  dangerous, and saying so in situ is how the two-axis model gets
                  learned. */}
              <p className="text-2xs text-text-3">
                <span className="font-mono tabular-nums">{rollup.dangerous}</span> dangerous ·{" "}
                <span className="font-mono tabular-nums">{rollup.error}</span> could not conclude ·{" "}
                <span className="font-mono tabular-nums">{rollup.safe}</span> no threat found
                {rollup.cached > 0 && (
                  <>
                    {" · "}
                    <span className="font-mono tabular-nums">{rollup.cached}</span> reused from cache
                  </>
                )}
              </p>
              {rollup.pending > 0 && (
                // The progress axis refusing to masquerade as a verdict. Without
                // this line a half-finished scan reads as a settled posture.
                <p className="text-2xs text-progress-ink">
                  <span className="font-mono tabular-nums">{rollup.pending}</span> still running —
                  posture may change
                </p>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {flagged > 0 && (
        <PanelSection
          label="Review queue"
          tone="danger"
          meta={`${flagged} flagged ${flagged === 1 ? "dependency" : "dependencies"}`}
          action={
            <Button variant="outline" size="sm" onClick={reviewFlagged}>
              Review flagged
            </Button>
          }
        >
          <Card className="overflow-hidden">
            {alerts.length > 0
              ? alerts.slice(0, 4).map((alert) => (
                  <QueueRow
                    key={alert.id}
                    to={`/package/${alert.packageName}`}
                    name={alert.packageName}
                    version={alert.version}
                    stamp={<VerdictStamp outcome={alert.outcome} />}
                    meta={`${alert.origin} · ${formatDate(alert.createdAt)}`}
                    severity={toneSeverity(outcomeTone(alert.outcome))}
                  />
                ))
              : queueDeps.map((dep) => (
                  <QueueRow
                    key={`${dep.name}@${dep.version}`}
                    to={`/package/${dep.name}`}
                    name={dep.name}
                    version={dep.version}
                    stamp={dep.outcome ? <VerdictStamp outcome={dep.outcome} /> : null}
                    meta={dep.direct ? "Direct" : "Transitive"}
                    severity={toneSeverity(depTone(dep))}
                  />
                ))}
          </Card>
        </PanelSection>
      )}

      <PanelSection
        label="Dependency inventory"
        meta={<span className="font-mono tabular-nums">{filtered.length}</span>}
        ref={inventoryRef}
      >
        {deps.length === 0 ? (
          // The token comes from the read that produced `deps`. "No dependency
          // baseline yet" is a claim about this repository, and only a successful
          // read can support it — which is why `EmptyState` demands the proof
          // rather than trusting the call site to have checked.
          <EmptyState
            read={state.read}
            message="No dependency baseline yet."
            hint="Run an audit to index this repository's lockfile."
          />
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <SearchInput
                label="Search dependencies"
                placeholder="Search dependencies"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter dependencies">
                {DEP_FILTERS.map((entry) => (
                  <Button
                    key={entry.key}
                    variant="outline"
                    size="sm"
                    aria-pressed={filter === entry.key}
                    onClick={() => setFilter(entry.key)}
                    className={cn(
                      filter === entry.key &&
                        "border-accent-border bg-accent-wash text-accent-text",
                    )}
                  >
                    {entry.label}{" "}
                    <span className="font-mono text-2xs tabular-nums opacity-70">
                      {filterCounts[entry.key]}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
            {/* `loaded(filtered)` is honest: this IS data we read, narrowed by a
                client-side filter. Routing the "nothing matched" case through the
                same chokepoint as the read is what leaves no hand-written empty
                box on the page for a future edit to point at a failure. */}
            <DataRegion
              state={loaded(filtered)}
              empty={{
                message: "No dependencies match this view.",
                hint: "Clear the search box or widen the filter.",
                action: (
                  <Button variant="outline" onClick={resetFilters}>
                    Reset filters
                  </Button>
                ),
              }}
            >
              {(rows) => (
                <Card className="overflow-hidden">
                  {/* Wide content scrolls inside its own container, never the
                      page body. Plain overflow rather than `ScrollArea`: §3.1
                      forbids nesting a second scroll region inside the page
                      scroll, and this one is horizontal only. */}
                  <div className="overflow-x-auto">
                    <Table density="dense" label="Dependency inventory">
                      {/* NOT `sticky`, deliberately. `position: sticky` resolves
                          against the nearest scroll container, and the
                          `overflow-x-auto` above is one — so `sticky top-0` would
                          pin to a box that never scrolls vertically and the prop
                          would be decoration. Making it real needs either a
                          fixed-height vertically-scrolling body (which §3.1
                          forbids nesting inside the page scroll) or the
                          virtualized table §3.2 specifies, whose `TanStack
                          Virtual` dependency is not installed. Left off with the
                          reason, rather than set and inert. */}
                      <TableHeader>
                        <tr>
                          <TableHead>Package</TableHead>
                          <TableHead>Version</TableHead>
                          <TableHead>Source</TableHead>
                          <TableHead>Status</TableHead>
                        </tr>
                      </TableHeader>
                      <TableBody>
                        {rows.slice(0, visibleCount).map((dep) => (
                          <TableRow
                            key={`${dep.name}@${dep.version}`}
                            // Severity as a 3px left rule, never a row fill:
                            // whole-row tinting is reserved for log and evidence
                            // panes, and on 340 rows it turns a table into
                            // wallpaper.
                            severity={toneSeverity(depTone(dep))}
                          >
                            <TableCell>
                              <div className="flex flex-col gap-0.5">
                                {/* A report page exists only where an audit
                                    CONCLUDED with a verdict — an ERROR dep has
                                    no report to link to. */}
                                {dep.outcome === "SAFE" || dep.outcome === "DANGEROUS" ? (
                                  <Link
                                    className="font-mono text-sm text-accent-text hover:underline"
                                    to={`/package/${dep.name}`}
                                  >
                                    {dep.name}
                                  </Link>
                                ) : (
                                  <span className="font-mono text-sm text-text">{dep.name}</span>
                                )}
                                {dep.range && (
                                  <span className="font-mono text-2xs text-text-3">{dep.range}</span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="font-mono tabular-nums text-text-2">
                              {dep.version}
                            </TableCell>
                            <TableCell className="text-text-2">
                              {dep.direct ? "Direct" : "Transitive"}
                            </TableCell>
                            <TableCell>
                              <DepStatusPill dep={dep} />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  {rows.length > visibleCount && (
                    <div className="flex items-center gap-3 border-t border-border-faint px-4 py-3">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setVisibleCount((count) => count + PAGE)}
                      >
                        Load 100 more
                      </Button>
                      <span className="text-2xs text-text-3">
                        Showing{" "}
                        <span className="font-mono tabular-nums">
                          {Math.min(visibleCount, rows.length)}
                        </span>{" "}
                        of <span className="font-mono tabular-nums">{rows.length}</span>
                      </span>
                    </div>
                  )}
                </Card>
              )}
            </DataRegion>
          </>
        )}
      </PanelSection>

      {paywall && <UpgradeDialog />}
    </PanelPage>
  );
}
