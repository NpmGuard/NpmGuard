/**
 * Packages registry (/packages) — the audited-report index.
 *
 * ONE list query (fetchPackages → {packages}), then everything else is derived
 * with .filter/.find/useMemo — no store, no data-grid, no virtualization
 * (patterns-synthesis.md §1.4). Selection lives in the URL: each row is a real
 * <a href> to /package/<name>?version=<v>. A search term that matches no audited
 * row can be resolved (resolveVersion) into an "Audit <pkg>@<version>" CTA.
 *
 * ── PRESENTATION: what the recomposition onto the token layer changed ───────
 *
 * `styles/registry.css` is gone; this page composes `ui/` primitives. Three of
 * the changes are honesty fixes rather than restyling:
 *
 * 1. The read was a hand-rolled `QueryState` tri-state whose failure arm
 *    rendered a RED `banner--danger`. Red is reserved for claims about packages
 *    (§0 rule 3) — a `GET /packages` that 502s is our plumbing, not a finding.
 *    It is now `LoadState` + `DegradedSurface`, which is the `error` violet
 *    slot, names the failed read, and offers retry and an escape hatch.
 * 2. The three empty arms were hand-built `div.empty-state` boxes, reachable in
 *    principle from a failed read. They now go through `EmptyState`, which
 *    requires a `ReadSucceeded` token — so "render the empty state on error" is
 *    a type error rather than a review catch.
 * 3. The verdict was a `.pill--{tone}` — colour only. §2.4 requires glyph +
 *    word + colour, in that order; the column now carries `VerdictStamp`.
 *
 * The empty state stays INSIDE the table body rather than replacing the table,
 * per §3.4's GitHub reference: keeping the header row and the count around the
 * emptiness preserves the reader's sense of *where* the emptiness is. That is
 * also why this switches on `state.status` at the call site instead of wrapping
 * the table in a `DataRegion` — `DataRegion` renders a `<div>`, which is not a
 * legal child of `<table>`, and CLAUDE.md §1 names the call-site switch as the
 * supported path when the honest rendering is structurally different.
 *
 * The verdict filter is a button group with `aria-pressed`, matching
 * `RepoDetail`'s dependency filter — the same job (narrow a table by outcome)
 * on the sibling surface, and one fewer portal in a toolbar.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../lib/api-base.ts";
import { fetchPackages, resolveVersion } from "../lib/api.ts";
import type { VerdictEnum } from "@npmguard/shared";
import type { PackageSummary } from "../lib/engine-types.ts";
import { formatDate } from "../lib/format.ts";
import { parsePackageInput } from "../lib/types.ts";
import { useAuditStore } from "../stores/auditStore.ts";
import { PanelPage, SectionLabel } from "../components/panel/layout.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { DegradedRegion, DegradedSurface } from "../components/ui/degraded-state.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import { SearchInput } from "../components/ui/input.tsx";
import { failed, loaded, type Failure, type LoadState } from "../components/ui/load-state.ts";
import { Skeleton } from "../components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.tsx";
import { ProgressStamp, VerdictStamp } from "../components/ui/verdict-stamp.tsx";
import { cn } from "../lib/cn.ts";

type VerdictFilter = "ALL" | VerdictEnum;

type LookupState =
  | { kind: "idle" }
  | { kind: "resolving"; term: string }
  | { kind: "resolved"; name: string; version: string }
  | { kind: "notfound"; term: string }
  | { kind: "failed"; failure: Failure };

const SKELETON_ROWS = 5;

const VERDICT_FILTERS: { key: VerdictFilter; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "SAFE", label: "Safe" },
  { key: "DANGEROUS", label: "Dangerous" },
];

export function Registry() {
  const [state, setState] = useState<LoadState<PackageSummary[]>>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [verdict, setVerdict] = useState<VerdictFilter>("ALL");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
  const [starting, setStarting] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    let live = true;
    setState({ status: "loading" });
    void fetchPackages()
      .then((r) => live && setState(loaded(r.packages)))
      .catch(
        (err) =>
          live &&
          // `what` is the subject, never the symptom: the reader can only route
          // around a failure they can identify (§3.4 rule 1).
          setState(
            failed({
              what: "Audited packages",
              detail: err instanceof Error ? err.message : undefined,
              retry: load,
            }),
          ),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  const allPackages = state.status === "ok" ? state.data : [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return allPackages.filter((pkg) => {
      const matchesTerm = term === "" || pkg.packageName.toLowerCase().includes(term);
      const matchesVerdict = verdict === "ALL" || pkg.verdict === verdict;
      return matchesTerm && matchesVerdict;
    });
  }, [allPackages, search, verdict]);

  const trimmedSearch = search.trim();

  async function runLookup(raw: string) {
    const { name, version } = parsePackageInput(raw);
    if (!name) return;
    setLookup({ kind: "resolving", term: raw });
    try {
      const resolved = await resolveVersion(name, version ?? undefined);
      setLookup({ kind: "resolved", name: resolved.packageName, version: resolved.version });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setLookup({ kind: "notfound", term: raw });
      } else {
        setLookup({
          kind: "failed",
          failure: {
            what: "Package lookup",
            detail: err instanceof Error ? err.message : undefined,
            retry: () => void runLookup(raw),
          },
        });
      }
    }
  }

  async function startAuditFor(name: string, version: string) {
    setStarting(true);
    try {
      // Payment verification is a server-side trust boundary — the UI observes.
      // dev (payment off) starts the stream; a 402 means the engine wants payment.
      await useAuditStore.getState().startAudit(name, version);
      // The store now holds an auditId; App's effect navigates to /audit/:id.
    } catch (err) {
      setStarting(false);
      if (err instanceof ApiError && err.status === 402) {
        navigate(`/pay?package=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`);
        return;
      }
      setLookup({
        kind: "failed",
        failure: {
          what: "Audit start",
          detail: err instanceof Error ? err.message : undefined,
          retry: () => void startAuditFor(name, version),
        },
      });
    }
  }

  // An em-dash, never `0`, while the count is unknown: a fabricated zero is the
  // field-scale version of the empty/degraded conflation (§3.4).
  const shownCount = state.status === "ok" ? `${filtered.length}` : "—";

  return (
    <PanelPage>
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-col gap-1">
          <SectionLabel>Registry</SectionLabel>
          <h1 className="text-2xl font-semibold text-text">Audited packages</h1>
        </div>
        <span
          aria-label="packages shown"
          aria-live="polite"
          className="font-mono text-2xs tracking-wide whitespace-nowrap text-text-3 uppercase tabular-nums"
        >
          {shownCount} shown
        </span>
      </header>

      <form
        className="mt-6 flex flex-wrap items-center gap-2"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmedSearch) void runLookup(trimmedSearch);
        }}
      >
        <SearchInput
          label="filter audited packages by name"
          placeholder="Filter by package name…"
          name="q"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (lookup.kind !== "idle") setLookup({ kind: "idle" });
          }}
        />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="filter by verdict">
          {VERDICT_FILTERS.map((entry) => (
            <Button
              key={entry.key}
              variant="outline"
              size="sm"
              aria-pressed={verdict === entry.key}
              onClick={() => setVerdict(entry.key)}
              className={cn(verdict === entry.key && "border-border-strong bg-sunken text-text")}
            >
              {entry.label}
            </Button>
          ))}
        </div>
        <Button
          type="submit"
          disabled={!trimmedSearch || lookup.kind === "resolving"}
          aria-label={`look up ${trimmedSearch || "a package"} on the registry`}
        >
          Look up
        </Button>
      </form>

      {lookup.kind !== "idle" && (
        <LookupResult
          lookup={lookup}
          starting={starting}
          onAudit={(name, version) => void startAuditFor(name, version)}
        />
      )}

      {state.status === "failed" ? (
        // `surface`, not `region`: this is the page's primary fetch and there is
        // no partial page worth salvaging around it.
        <DegradedSurface
          failure={state.failure}
          escape={{ label: "Audit a package instead", href: "/" }}
          className="mt-6"
        />
      ) : (
        <div className="mt-6 overflow-x-auto">
          <Table label="Audited packages" className="min-w-[520px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Package</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Verdict</TableHead>
                <TableHead>Audited</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.status === "loading" ? (
                Array.from({ length: SKELETON_ROWS }, (_, i) => <SkeletonRow key={i} />)
              ) : filtered.length > 0 ? (
                filtered.map((pkg) => (
                  <PackageRow key={`${pkg.packageName}@${pkg.version}`} pkg={pkg} />
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="p-0">
                    <RegistryEmpty
                      read={state.read}
                      totalCount={allPackages.length}
                      search={trimmedSearch}
                      filtered={verdict !== "ALL"}
                      onLookup={() => trimmedSearch && void runLookup(trimmedSearch)}
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </PanelPage>
  );
}

/** One audited package — a real `<a href>` row. The anchor's stretched
 * pseudo-element covers the positioned row, so a click anywhere on it navigates
 * while keyboard focus and cmd-click stay on the real `<a>`. */
function PackageRow({ pkg }: { pkg: PackageSummary }) {
  return (
    <TableRow className="relative">
      <TableCell>
        <Link
          className={cn(
            "font-mono text-sm font-medium text-text after:absolute after:inset-0",
            "transition-colors duration-fast hover:text-accent-text",
            // The ring lands on the stretched pseudo-element, so it outlines the
            // whole row rather than the four characters of the package name.
            "rounded-xs focus-visible:outline-none focus-visible:after:[box-shadow:var(--ng-focus-ring)]",
          )}
          to={`/package/${pkg.packageName}?version=${pkg.version}`}
          aria-label={`view full audit of ${pkg.packageName}`}
        >
          {pkg.packageName}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-sm text-text-2 tabular-nums">{pkg.version}</TableCell>
      {/* Above the stretched overlay so the stamp is not swallowed by it. */}
      <TableCell className="relative">
        <VerdictStamp outcome={pkg.verdict} />
      </TableCell>
      <TableCell className="text-2xs text-text-3">{formatDate(pkg.auditedAt)}</TableCell>
    </TableRow>
  );
}

/** Skeleton row — reuses the exact `<td>` layout of `PackageRow` so the loading
 * shape can never drift from the loaded one. `Skeleton` requires a className
 * carrying the final dimensions, which is what stops it from causing the layout
 * shift it exists to prevent. */
function SkeletonRow() {
  return (
    <TableRow aria-hidden="true">
      <TableCell>
        <Skeleton className="h-3 w-[58%]" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-3 w-11" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-5 w-16 rounded-sm" />
      </TableCell>
      <TableCell>
        <Skeleton className="h-3 w-18" />
      </TableCell>
    </TableRow>
  );
}

/** Reason-aware empty: a truly empty index reads differently from a filter that
 * hid everything. `read` is the proof the list was genuinely fetched — this
 * component is unreachable from a failed read because there is no token to pass.
 * Copy is specific per §3.4 ("No audited package matches …", never "No data"). */
function RegistryEmpty({
  read,
  totalCount,
  search,
  filtered,
  onLookup,
}: {
  read: Parameters<typeof EmptyState>[0]["read"];
  totalCount: number;
  search: string;
  filtered: boolean;
  onLookup: () => void;
}) {
  if (totalCount === 0) {
    return (
      <EmptyState
        read={read}
        message="No reports yet."
        hint="Audited packages appear here once a report is stored."
      />
    );
  }
  if (search) {
    return (
      <EmptyState
        read={read}
        message={`No audited package matches ${search}.`}
        action={
          <Button size="sm" onClick={onLookup}>
            Look up <span className="font-mono">{search}</span>
          </Button>
        }
      />
    );
  }
  return (
    <EmptyState
      read={read}
      message="None match this filter."
      hint={filtered ? "Try a different verdict." : undefined}
    />
  );
}

/** Lookup outcome for a term not (yet) in the index — resolve → "Audit" CTA. */
function LookupResult({
  lookup,
  starting,
  onAudit,
}: {
  lookup: LookupState;
  starting: boolean;
  onAudit: (name: string, version: string) => void;
}) {
  if (lookup.kind === "resolving") {
    return (
      <Card className="mt-4 flex items-center gap-3 px-4 py-3" role="status">
        <ProgressStamp state="running">Resolving</ProgressStamp>
        <span className="text-sm text-text-2">
          <span className="font-mono">{lookup.term}</span>…
        </span>
      </Card>
    );
  }
  if (lookup.kind === "notfound") {
    // Not a failure: the registry answered, and the answer was "no such package".
    // That is an honest negative result and must not wear the degraded hatch.
    return (
      <Card className="mt-4 flex items-center gap-3 px-4 py-3">
        <span className="text-sm text-text-2">
          No package named <span className="font-mono text-text">{lookup.term}</span> on the
          registry.
        </span>
      </Card>
    );
  }
  if (lookup.kind === "failed") {
    return <DegradedRegion failure={lookup.failure} className="mt-4" />;
  }
  if (lookup.kind === "idle") return null; // parent only mounts on non-idle
  // resolved
  return (
    <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="grid gap-1">
        <SectionLabel>Not audited yet</SectionLabel>
        <span className="font-mono text-sm font-medium text-text">
          {lookup.name}
          <span className="text-text-3"> @{lookup.version}</span>
        </span>
      </div>
      <Button
        disabled={starting}
        onClick={() => onAudit(lookup.name, lookup.version)}
        aria-label={`audit ${lookup.name} at ${lookup.version}`}
      >
        {starting ? (
          "Starting…"
        ) : (
          <>
            Audit{" "}
            <span className="font-mono">
              {lookup.name}@{lookup.version}
            </span>
          </>
        )}
      </Button>
    </Card>
  );
}
