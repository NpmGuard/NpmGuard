/** Start a read-only public repository audit: owner/repo (or github.com
 * URL) input, and the trust-boundary list.
 *
 * The allowance-account selector is GONE (D-1 / F-F5). A public scan requires a
 * GitHub sign-in and nothing more — no App installation, none charged — so there
 * was no account to choose, and asking for one made this form unreachable for
 * every signed-in visitor who had not installed the App. So this dialog reads no
 * billing at all.
 *
 * ── PRESENTATION: what the recomposition changed ────────────────────────────
 *
 * Nothing about what this form submits or when. Two things about what it says:
 *
 * 1. **A refused mutation rendered `banner--danger` — RED.** "We could not start
 *    your audit" is our plumbing failing, not a claim about a package, and §0
 *    rule 3 keeps red for the latter. It is the `error` slot now. No hatch: hatch
 *    means "no signal here", and a refusal is a signal — the request was answered.

 * There is no input primitive in `components/ui/`, so the repository field carries
 * token classes inline — the same call the two page-level search boxes made, and
 * reported as a gap rather than fixed by adding one. `FOCUS_RING` is explicit on
 * it and is NOT optional here: a dialog is portalled outside the `.ng-root`
 * subtree that the global `:focus-visible` rule is scoped to, so a hand-rolled
 * control inside one has no ring unless it says so. */

import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PanelDialog } from "../../../components/panel/PanelDialog.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { DialogFooter, DialogHeader } from "../../../components/ui/dialog.tsx";
import { FOCUS_RING } from "../../../components/ui/focus.ts";
import { cn } from "../../../lib/cn.ts";
import { actionFailure } from "../../../lib/query-state.ts";
import { useStartPublicScan } from "../hooks.ts";

const BOUNDARIES = [
  ["01", "Public contents only"],
  ["02", "No install on target"],
  ["03", "No checks or webhooks"],
] as const;

/** Field label: the metadata voice, in sans. Deliberately not `SectionLabel` —
 * that is mono uppercase and marks a page SECTION; a form field's label is
 * ordinary interface language and §2.7 keeps mono for machine-authored facts. */
const FIELD_LABEL = "text-2xs font-medium text-text-2";

export function PublicAuditDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  onStarted: (scanId: number) => void;
}) {
  const scan = useStartPublicScan();
  const busy = scan.isPending;
  // This form reads no billing at all: nothing here is billed, so there is no
  // cap to filter out and every failure is this form's own to show.
  const failure = actionFailure(scan.error, "Starting the repository audit");

  const [repository, setRepository] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = repository.trim();
    if (!target || busy) return;
    scan.mutate({ repository: target }, { onSuccess: ({ scanId }) => onStarted(scanId) });
  };

  return (
    <PanelDialog ariaLabel="Audit a public repository" onClose={onClose}>
      <form onSubmit={submit}>
        <DialogHeader className="flex-row items-start justify-between gap-3 pr-5">
          <div className="flex min-w-0 flex-col items-start gap-1">
            {/* Accent, not muted: this label is the one place the dialog states
                the guarantee that makes the whole flow safe to offer, and §2.2
                permits accent on a thing that is genuinely load-bearing rather
                than decorative chrome. */}
            <span className="font-mono text-2xs font-medium tracking-wide text-accent-text uppercase">
              Read-only audit
            </span>
            <h2 className="text-xl font-semibold text-text">Audit a public repository</h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Close"
            className="size-control-sm shrink-0 px-0"
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-icon" />
          </Button>
        </DialogHeader>

        <div className="flex flex-col gap-3.5 px-5 py-4">
          <label className="flex flex-col items-start gap-1.5">
            <span className={FIELD_LABEL}>Repository</span>
            <input
              placeholder="github.com/owner/repository"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              autoFocus
              className={cn(
                "h-control w-full rounded-md border border-border-control bg-surface px-2.5",
                // 16px below `md`, or iOS Safari zooms the viewport on focus (§2.7).
                "font-mono text-sm text-text placeholder:text-text-3 max-md:h-tap max-md:text-md",
                "transition-colors duration-fast hover:border-border-strong",
                FOCUS_RING,
              )}
            />
            <span className="text-2xs text-text-3">Accepted: owner/repo or a github.com URL.</span>
          </label>

          <ol className="flex flex-col gap-2" aria-label="Audit boundary">
            {BOUNDARIES.map(([num, label]) => (
              <li key={num} className="flex items-center gap-2.5 text-xs text-text-2">
                <span className="font-mono text-2xs tabular-nums text-accent-text">{num}</span>{" "}
                {label}
              </li>
            ))}
          </ol>

          {failure && (
            <p
              role="alert"
              className="rounded-md border border-error-border bg-error-wash px-2.5 py-2 text-xs text-error-text"
            >
              {failure.detail ?? failure.what}
            </p>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <span className="max-w-60 text-2xs text-text-3">
            Manual result only · findings never write to the target repository.
          </span>
          <span className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !repository.trim()}>
              {busy ? "Reading public snapshot…" : "Audit snapshot"}
            </Button>
          </span>
        </DialogFooter>
      </form>
    </PanelDialog>
  );
}
