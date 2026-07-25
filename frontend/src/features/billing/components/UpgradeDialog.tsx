/** Paywall dialog driven by the one cross-page UI fact in the store.
 *
 * The 402 cap body carries FRESH entitlements, so the exhausted meter renders
 * from the response that opened this dialog — no second request, no stale quota.
 * The offer beside it comes from the same body (`upgradeOffers`), so the whole
 * dialog survives a failed billing read; what the ledger adds is price and
 * whether checkout is configured, and each of those is guarded on its own.
 *
 * An account already holding the top offer has an empty `upgradeOffers`, and is
 * shown its exhausted allowance with nothing to buy rather than a purchase it
 * cannot make.
 *
 * ── PRESENTATION ────────────────────────────────────────────────────────────
 *
 * `PanelDialog` is the shell and stays the shell: it is already an adapter over
 * `ui/dialog`, so the focus trap, the portal, the restore-on-close shim and the
 * aria-hidden treatment are inherited and none of it is re-expressed here. What
 * this file owns is the BODY, which is what `dialog__header/__body/__footer` used
 * to dress.
 *
 * `DialogHeader` and `DialogFooter` are used; `DialogBody` deliberately is NOT.
 * `DialogBody` is the scroll row of a `layout="scroll"` dialog and carries
 * `tabIndex={0}` so a keyboard user can scroll it — inside `PanelDialog`, which
 * pins `layout="fit"` and scrolls its whole content box, that tabbable div would
 * be a focus stop in front of the first real control while never scrolling
 * anything. A plain padded div is the honest composition until `PanelDialog`
 * exposes `layout` (noted there as the thing to switch on when the callers are
 * recomposed — which is now).
 *
 * DECISION the brief left open: the legacy eyebrow above the title was
 * `eyebrow--danger` — RED for the word "Allowance". §0 rule 3 reserves red for a
 * claim about a package, and a spent quota is not one; it is "we could not check",
 * which is the `error` slot. The label is now the muted `SectionLabel`, and the
 * hue that carries the state is the one `Meter` puts on the exhausted bar itself.
 * Colour here would have been decoration on a word that is already a heading. */

import type { CapResource, UsageBucket } from "@npmguard/shared";
import { Sparkles, X } from "lucide-react";
import { SectionLabel } from "../../../components/panel/layout.tsx";
import { PanelDialog } from "../../../components/panel/PanelDialog.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Card, CardBody } from "../../../components/ui/card.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import { DialogFooter, DialogHeader } from "../../../components/ui/dialog.tsx";
import { formatCents } from "../../../lib/format.ts";
import { usePanelUi } from "../../../stores/panelStore.ts";
import { useBilling, useStartProCheckout } from "../hooks.ts";
import { AllowanceMeter } from "./AllowanceMeter.tsx";

const RESOURCE_META: Record<
  CapResource,
  { title: string; meterLabel: string; copy: (limit: number) => string }
> = {
  protected_repos: {
    title: "Protection limit reached",
    meterLabel: "Protected repositories",
    copy: (limit) =>
      `Your plan protects up to ${limit} ${limit === 1 ? "repository" : "repositories"} with continuous monitoring. Unprotect one, or upgrade for more.`,
  },
  monthly_audits: {
    title: "Monthly audit budget reached",
    meterLabel: "Audits this month",
    copy: () =>
      "New package audits pause until the next billing month, or upgrade for a larger budget.",
  },
};

function limitLabel(limit: number): string {
  return limit === 0 ? "Unlimited" : String(limit);
}

export function UpgradeDialog() {
  const paywall = usePanelUi((s) => s.paywall);
  const closePaywall = usePanelUi((s) => s.closePaywall);
  const billing = useBilling();
  const checkout = useStartProCheckout();
  if (!paywall) return null;

  const meta = RESOURCE_META[paywall.resource];
  const entitlements = paywall.entitlements;
  const bucket: UsageBucket =
    paywall.resource === "protected_repos"
      ? entitlements.protectedRepos
      : entitlements.monthlyAudits;
  // The dialog's OWN subject — the exhausted bucket and what can be bought to
  // relieve it — comes from the 402 body, so it renders in full even when the
  // billing read failed. What that read adds is price and checkout availability.
  const offer = entitlements.upgradeOffers[0] ?? null;
  const catalog = billing.status === "ok" ? billing.data : null;
  const price = catalog?.price ?? null;
  const checkoutEnabled = catalog?.checkoutEnabled ?? false;
  // Three separate reasons the button can be dead, kept apart because the copy
  // below has to name the right one.
  const canCheckout = checkoutEnabled && offer !== null;
  const busy = checkout.isPending && checkout.variables === paywall.installationId;

  return (
    <PanelDialog ariaLabel={meta.title} onClose={closePaywall}>
      {/* `flex-row` over `DialogHeader`'s stacked default, because the close
          button is the header's second child rather than a caption. `pr-5`
          restores the symmetric padding `DialogHeader` reserves for the built-in
          close that `PanelDialog` turns off. */}
      <DialogHeader className="flex-row items-start justify-between gap-3 pr-5">
        <div className="flex min-w-0 flex-col items-start gap-1">
          <SectionLabel>Allowance</SectionLabel>
          <h2 className="text-xl font-semibold text-text">{meta.title}</h2>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close"
          className="size-control-sm shrink-0 px-0"
          onClick={closePaywall}
        >
          <X aria-hidden="true" className="size-icon" />
        </Button>
      </DialogHeader>

      <div className="flex flex-col gap-3.5 px-5 py-4">
        <p className="text-sm text-text-2">{meta.copy(bucket.limit)}</p>
        <div className="flex flex-col gap-2 rounded-md border border-border bg-sunken px-3.5 py-3">
          <span className="font-mono text-2xs text-text-3">{entitlements.accountLogin}</span>
          <AllowanceMeter label={meta.meterLabel} bucket={bucket} />
        </div>
        {offer && (
        <Card>
          <CardBody className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2.5">
              {/* `accent` names the one thing being sold, not a tier the account
                  is or is not on — so it survives an open-ended catalog. */}
              <Badge tone="accent">{offer.label}</Badge>
              {price?.amount != null && (
                <span className="text-sm text-text-2">
                  {/* `currency` is nullable on the wire (the schema is right and the
                      old hand-written `string` was wrong — Stripe can omit it), so
                      the display default lives here rather than in a cast. */}
                  <strong className="font-medium text-text">
                    {formatCents(price.amount, price.currency ?? undefined)}
                  </strong>
                  {price.interval ? ` / ${price.interval}` : ""}
                </span>
              )}
            </div>
            <ul className="flex flex-col gap-1.5 text-xs text-text-2">
              <li>
                <span className="font-mono tabular-nums text-text">
                  {limitLabel(offer.limits.protectedRepos)}
                </span>{" "}
                protected repositories
              </li>
              <li>
                <span className="font-mono tabular-nums text-text">
                  {limitLabel(offer.limits.monthlyAudits)}
                </span>{" "}
                package audits per month
              </li>
              {/* Public repository scans are deliberately NOT listed as a plan
                  perk: they are free for any signed-in user and billed to
                  nobody (D-1), so selling them here would be selling something
                  the baseline plan already has. */}
            </ul>
            <p className="text-2xs text-text-3">
              Only DANGEROUS blocks an install; audits that could not conclude are reported,
              never hidden.
            </p>
          </CardBody>
        </Card>
        )}
        {/* "Nothing to sell you", "not configured" and "we could not find out"
            are three different facts, and the button is disabled for all three —
            so naming the wrong one would send the reader somewhere useless. */}
        {billing.status === "failed" ? (
          <DegradedRegion failure={billing.failure} title="Plan" />
        ) : offer === null ? (
          <p className="text-2xs text-text-3">
            {entitlements.accountLogin} is already on {entitlements.plan}, the highest plan
            available.
          </p>
        ) : !checkoutEnabled ? (
          <p className="text-2xs text-text-3">Checkout is not configured on this server.</p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={closePaywall}>
          Not now
        </Button>
        <Button
          disabled={!canCheckout || busy}
          onClick={() => checkout.mutate(paywall.installationId)}
        >
          <Sparkles aria-hidden="true" className="size-icon-sm" />
          {busy ? "Redirecting…" : "Continue to Stripe"}
        </Button>
      </DialogFooter>
    </PanelDialog>
  );
}
