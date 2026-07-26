/**
 * `/scan` — paste any public GitHub repository, watch its supply chain resolve,
 * and convert into "protect this repo".
 *
 * ── ONE JOB: one repository in, its exact state, then its dependencies ──────
 *
 * The command is the page. It sits in the header, and everything under it is
 * either the scan's state or its outcome. The product explanation — what this
 * does not touch, why a clean result is not a guarantee — moves BELOW the
 * result and collapses once there is a result to read: a visitor who has just
 * pasted a repository is waiting for an answer, not reading a description of the
 * thing they already used.
 *
 * This is the funnel's front door, and the ONLY thing between a visitor and a
 * result is a GitHub sign-in (D-1 / F-F5): no App installation, no ownership of
 * the repo, no installation charged. There is deliberately no allowance-account
 * selector and no 402 paywall: either would gate the surface against exactly the
 * person it exists for.
 *
 * ── What this page does NOT own ─────────────────────────────────────────────
 *
 * The result. `PublicScanResult` is the same component the dashboard's snapshot
 * dialog renders, so a scan means one thing in both places — R-1's argument
 * applied one level up. Progress is `usePublicScanStream` over
 * `/panel/scan/:id/events`, the ONE progress transport for every audit-set
 * origin; there is no polling loop and no second fold here.
 *
 * ── Honesty, which is the whole point of the surface ────────────────────────
 *
 * §0 rule 1: `SAFE` means "this audit found nothing it could confirm", never
 * "this repository is safe" — and on a page aimed at strangers who have never
 * heard of us, overstating a clean result is the credibility failure that costs
 * the most. So the clean result is stated flatly and always beside its coverage
 * counts (`PublicScanResult` carries both, including the packages a cost-bound
 * scan did not audit), and the CTA below never congratulates: a repo whose
 * dependencies came back clean today is a repo whose NEXT lockfile change is
 * unaudited, which is the honest reason to protect it and also the true one.
 */

import { ArrowRight, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { SectionLabel } from "../components/panel/layout.tsx";
import {
  QuietGroup,
  WorkspaceBody,
  WorkspaceHeader,
  WorkspacePage,
} from "../components/shell/workspace.tsx";
import { ProgressStamp, VerdictStamp } from "../components/ui/verdict-stamp.tsx";
import { Button } from "../components/ui/button.tsx";
import { Card, CardBody } from "../components/ui/card.tsx";
import { FOCUS_RING } from "../components/ui/focus.ts";
import { PublicScanResult } from "../features/repos/components/PublicScanResult.tsx";
import { usePublicScanDetail, usePublicScanStream, useStartPublicScan } from "../features/repos/hooks.ts";
import { githubLoginUrl } from "../features/session/api.ts";
import { useSignedIn } from "../features/session/hooks.ts";
import { cn } from "../lib/cn.ts";
import { actionFailure } from "../lib/query-state.ts";
import { formatDate } from "../lib/format.ts";

const BOUNDARIES = [
  ["01", "Public repository contents only"],
  ["02", "Nothing is installed or executed on the target"],
  ["03", "No checks, no webhooks, no writes of any kind"],
] as const;

/** The live snapshot, once a scan id exists. Split out so the detail query and
 * its stream mount WITH the id rather than under a `scanId ?? 0` sentinel — a
 * query keyed on a fake id is a real request for a snapshot that isn't there. */
function ScanSnapshot({ scanId }: { scanId: number }) {
  const state = usePublicScanDetail(scanId);
  const scan = state.status === "ok" ? state.data.scan : null;
  const running = scan?.set.status === "running";
  usePublicScanStream(scanId, running === true);

  return (
    <section className="mt-8 flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col items-start gap-1">
          <SectionLabel>Snapshot #{scanId}</SectionLabel>
          <h2 className="text-xl font-semibold text-text">
            {/* Never "Loading" over a failed read — the body below already says
                what broke, and a heading claiming progress contradicts it. */}
            {scan
              ? scan.repo.fullName
              : state.status === "failed"
                ? "Snapshot unavailable"
                : "Reading snapshot"}
          </h2>
          {scan && (
            <p className="font-mono text-2xs text-text-3">
              {scan.repo.lockfilePath} · {scan.repo.defaultBranch} · {formatDate(scan.set.startedAt)}
            </p>
          )}
        </div>
        {scan &&
          (running ? (
            <ProgressStamp state="running">Running</ProgressStamp>
          ) : scan.set.rollup.outcome ? (
            <VerdictStamp outcome={scan.set.rollup.outcome} />
          ) : null)}
      </header>

      <PublicScanResult state={state} />

      {/* The conversion, and it is deliberately gated on a FINISHED scan: offering
          continuous monitoring beside a half-resolved posture asks for a decision
          on evidence that is still moving. */}
      {scan && !running && (
        <Card>
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-icon shrink-0 text-text-3" />
              <p className="max-w-xl text-sm text-text-2">
                This is one snapshot of one commit. Protecting a repository you own audits every
                lockfile change from here on, and tells you when a dependency you already have
                turns dangerous.
              </p>
            </div>
            <Button asChild>
              <Link to="/dashboard">
                Protect a repository <ArrowRight aria-hidden="true" className="size-icon-sm" />
              </Link>
            </Button>
          </CardBody>
        </Card>
      )}
    </section>
  );
}

export function Scan() {
  const signedIn = useSignedIn();
  const start = useStartPublicScan();
  const [repository, setRepository] = useState("");
  const [scanId, setScanId] = useState<number | null>(null);

  const busy = start.isPending;
  // No cap to filter out: nothing on this surface is billed, so every failure is
  // this form's own to show.
  const failure = actionFailure(start.error, "Starting the repository scan");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = repository.trim();
    if (!target || busy) return;
    // A 409 resolves to a success at the boundary (`startPublicRepoScan`): a set
    // for this repo is already live and streamable, so it lands here as an id.
    start.mutate({ repository: target }, { onSuccess: ({ scanId: id }) => setScanId(id) });
  };

  return (
    <WorkspacePage>
      <WorkspaceHeader
        title="Scan a repository"
        lede={
          scanId === null
            ? "Point NpmGuard at a public GitHub repository — yours or anyone's — and it resolves the root lockfile and audits every dependency it can."
            : undefined
        }
      >
        {signedIn ? (
          <form onSubmit={submit} className="flex w-full flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <span className="sr-only">Repository</span>
              <input
                placeholder="github.com/owner/repository"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                autoFocus
                className={cn(
                  "h-control min-w-0 flex-1 rounded-md border border-border-control bg-surface px-2.5",
                  // 16px below `md`, or iOS Safari zooms the viewport on focus.
                  "font-mono text-sm text-text placeholder:text-text-3 max-md:h-tap max-md:text-md",
                  "transition-colors duration-fast hover:border-border-strong",
                  FOCUS_RING,
                )}
              />
            </label>
            <Button type="submit" disabled={busy || !repository.trim()}>
              {busy ? "Reading public snapshot…" : "Scan repository"}
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-text-2">
              Sign in with GitHub to scan. That is the only requirement — NpmGuard is not
              installed on the repository, and nothing is charged.
            </p>
            {/* `asChild` keeps this an `<a>`: sign-in is a navigation, and a
                `<button>` that navigates loses middle-click, "open in new tab"
                and the screen-reader announcement. */}
            <Button asChild>
              <a href={githubLoginUrl()}>Sign in with GitHub</a>
            </Button>
          </div>
        )}
      </WorkspaceHeader>

      <WorkspaceBody>
        {failure && (
          // The `error` slot, not `danger`: a refused request is our plumbing
          // failing, and red is reserved for claims about packages.
          <p
            role="alert"
            className="mb-5 rounded-md border border-error-border bg-error-wash px-2.5 py-2 text-xs text-error-text"
          >
            {failure.detail ?? failure.what}
          </p>
        )}

        {scanId !== null ? (
          <ScanSnapshot scanId={scanId} />
        ) : (
          <p className="rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-text-2">
            Paste a repository above. The scan reads its root lockfile and audits every dependency
            it can reach.
          </p>
        )}

        {/* The explanation, demoted. It answers "what is this touching", which is
            a question people ask BEFORE they paste and stop asking after. */}
        <div className="mt-6">
          <QuietGroup
            label="What this scan does and does not touch"
            count={BOUNDARIES.length}
            defaultOpen={scanId === null}
          >
            <ol className="flex flex-col gap-2 p-3" aria-label="Scan boundary">
              {BOUNDARIES.map(([num, label]) => (
                <li key={num} className="flex items-center gap-2.5 text-xs text-text-2">
                  <span className="font-mono text-2xs text-accent-text tabular-nums">{num}</span>{" "}
                  {label}
                </li>
              ))}
            </ol>
          </QuietGroup>
        </div>
      </WorkspaceBody>
    </WorkspacePage>
  );
}
