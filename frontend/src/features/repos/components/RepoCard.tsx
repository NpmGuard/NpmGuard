/** Repository card for the dashboard grid. A severity rule follows the last
 * scan's tone; action errors render inline and dismissible so a single failure
 * never poisons the whole dashboard.
 *
 * Both mutations are instantiated PER CARD, which is what deleted the store's
 * `repoActionErrors: Record<number, RepoActionError>`. That map existed only
 * because the actions lived in one global object and their failures therefore
 * needed a key to tell them apart; here the failing mutation and the row that
 * owns it are the same object, and `reset()` is the dismiss.
 *
 * ── PRESENTATION: what the recomposition changed ────────────────────────────
 *
 * Nothing about what this card fetches or decides. Three things about what it
 * says, and two are honesty fixes:
 *
 * 1. **A refused mutation rendered `banner--danger` — RED.** §0 rule 3 reserves
 *    red for a claim NpmGuard is making about a package; "we could not start your
 *    audit" is our own plumbing failing. It is the `error` slot now, the same
 *    *we don't know* slot as audit ERROR and a failed fetch, and it carries no
 *    hatch — hatch means "no signal here", and a refusal is a signal.
 * 2. **The accent bar could be GREEN or BLUE.** `card--accent` took any tone from
 *    `toneAccent`, including `safe` and `running`. `Card severity` accepts
 *    `danger | error` and nothing else on purpose (§0 rule 1: SAFE is the
 *    quietest state, and a green-ruled card is a small green banner), so
 *    `toneSeverity` is the chokepoint and the safe/running/unknown cards simply
 *    wear no rule. That also retires this file's use of `toneAccent`.
 * 3. **The two navigations are real links.** They were `<button onClick={navigate}>`
 *    for a canonical repo URL, which cannot be middle-clicked, opened in a new
 *    tab, or announced as a link. `useNavigate` survives for exactly the one case
 *    that is not a navigation the user asked for: the redirect after a scan starts.
 *
 * `variant="interactive"` and `CardLinkOverlay` are deliberately NOT used. The
 * card holds three controls in its footer, and a stretched overlay covering them
 * would make the whole card one target — the primitive's own docblock warns about
 * exactly that. Two explicit links is the honest composition here. */

import type { PanelRepo } from "@npmguard/shared";
import { ArrowRight, Shield, ShieldCheck, X } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { scanTone, toneSeverity } from "../../../components/panel/tone.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Card, CardBody } from "../../../components/ui/card.tsx";
import { FOCUS_RING } from "../../../components/ui/focus.ts";
import { cn } from "../../../lib/cn.ts";
import { actionFailure } from "../../../lib/query-state.ts";
import { useSetProtect, useTriggerScan } from "../hooks.ts";
import { ScanStatus } from "./ScanStatus.tsx";

export function RepoCard({ repo }: { repo: PanelRepo }) {
  const navigate = useNavigate();
  const triggerScan = useTriggerScan();
  const setProtect = useSetProtect();

  const running = repo.lastScan?.status === "running";
  const detailPath = `/repo/${repo.owner}/${repo.name}`;

  // A cap is not shown here — the paywall dialog owns it, and rendering both
  // would read as two separate problems.
  const failure =
    actionFailure(triggerScan.error, "Starting the audit") ??
    actionFailure(setProtect.error, "Changing protection");
  const dismiss = () => {
    triggerScan.reset();
    setProtect.reset();
  };

  const runAudit = () => {
    triggerScan.mutate(repo.id, { onSuccess: () => navigate(detailPath) });
  };

  return (
    <Card severity={toneSeverity(scanTone(repo.lastScan))}>
      <CardBody className="flex h-full flex-col gap-3">
        <header className="flex items-start justify-between gap-2.5">
          <Link
            to={detailPath}
            aria-label={`Open ${repo.fullName}`}
            className={cn(
              "group flex min-w-0 flex-col items-start gap-px rounded-xs text-left",
              FOCUS_RING,
            )}
          >
            <span className="text-2xs text-text-3">{repo.owner}</span>
            <span
              className={cn(
                "text-lg font-semibold tracking-tight text-text [overflow-wrap:anywhere]",
                "transition-colors duration-fast group-hover:text-accent-text",
              )}
            >
              {repo.name}
            </span>
          </Link>
          <div className="flex flex-wrap justify-end gap-1">
            {/* Both neutral. Private and Protected are settings, not outcomes —
                §3.2 keeps chips uncoloured so the one coloured thing on a card is
                the verdict `ScanStatus` puts there. */}
            {repo.private && <Badge>Private</Badge>}
            {repo.protected && <Badge>Protected</Badge>}
          </div>
        </header>

        <ScanStatus scan={repo.lastScan} />

        {failure && (
          <div
            role="alert"
            className={cn(
              "flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs",
              "border-error-border bg-error-wash text-error-text",
            )}
          >
            <span>{`${failure.what} failed — ${failure.detail ?? "no detail"}`}</span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Dismiss error"
              className="size-control-sm shrink-0 px-0 text-error-text"
              onClick={dismiss}
            >
              <X aria-hidden="true" className="size-icon-sm" />
            </Button>
          </div>
        )}

        <dl className="flex gap-6">
          <div className="flex flex-col gap-0.5">
            <dt className="text-2xs font-medium text-text-3">Branch</dt>
            <dd className="font-mono text-xs text-text-2">{repo.defaultBranch}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-2xs font-medium text-text-3">Monitoring</dt>
            <dd className="text-xs text-text-2">{repo.protected ? "Continuous" : "Manual"}</dd>
          </div>
        </dl>

        <footer className="mt-auto flex items-center gap-2">
          <Button size="sm" disabled={running || triggerScan.isPending} onClick={runAudit}>
            {triggerScan.isPending ? "Starting…" : running ? "Scanning…" : "Run audit"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={setProtect.isPending}
            onClick={() => setProtect.mutate({ repoId: repo.id, on: !repo.protected })}
          >
            {repo.protected ? (
              <ShieldCheck aria-hidden="true" className="size-icon-sm" />
            ) : (
              <Shield aria-hidden="true" className="size-icon-sm" />
            )}
            {repo.protected ? "Protected" : "Protect"}
          </Button>
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="ms-auto size-control-sm shrink-0 px-0"
          >
            <Link to={detailPath} aria-label={`Open details for ${repo.fullName}`}>
              <ArrowRight aria-hidden="true" className="size-icon" />
            </Link>
          </Button>
        </footer>
      </CardBody>
    </Card>
  );
}
