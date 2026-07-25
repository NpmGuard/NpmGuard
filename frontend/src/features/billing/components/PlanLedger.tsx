/** Per-billing-account plan cards: plan chip, allowance meters, and the
 * upgrade / manage-billing action.
 *
 * Renders a `LoadState`, not a `billing | null` plus a `billingError` string.
 * Those two fields could both be set, or neither, and the component had to guess
 * which one to believe — `if (!billing && !billingError) return null` was that
 * guess. The three arms below are mutually exclusive by construction.
 *
 * Not a `<DataRegion>`: the honest empty rendering here is *nothing* (an identity
 * with no installations has no plan to show), and `DataRegion` requires empty
 * copy it would then never display. The failed≠empty guarantee still holds
 * structurally — there is no `data` on the `failed` arm to render.
 *
 * The two controls are composed from the entitlements projection rather than
 * switched on a plan name (F-E5): one upgrade control per entry in
 * `upgradeOffers`, and a manage control when a subscription is live. A third
 * product is a third offer from the engine and renders here with no edit.
 *
 * ── PRESENTATION ────────────────────────────────────────────────────────────
 *
 * DECISION the brief left open — it specifies no treatment for a plan name.
 * `Badge`, always `neutral`. §3.2's rule is that chips are metadata and almost
 * never coloured, and a plan is metadata about the account, not an outcome about
 * a package — so neither hue in the semantic set is available to it. The accent
 * hue this chip used to carry was justified only by there being exactly two
 * tiers, one of which was "the row with something the others do not"; with an
 * open-ended catalog that reading is not available, and the label carries the
 * fact on its own. */

import type { BillingResponse } from "@npmguard/shared";
import { CreditCard, Sparkles } from "lucide-react";
import { PanelSection } from "../../../components/panel/layout.tsx";
import { Badge } from "../../../components/ui/badge.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Card, CardBody } from "../../../components/ui/card.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import type { LoadState } from "../../../components/ui/load-state.ts";
import { useOpenBillingPortal, useStartProCheckout } from "../hooks.ts";
import { AllowanceMeter } from "./AllowanceMeter.tsx";

/** Account cards hold a login, two meters and one control. 18rem is the point
 * below which a meter's `label / value` head wraps onto two lines. */
const LEDGER_GRID = "grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-6";

export function PlanLedger({ state }: { state: LoadState<BillingResponse> }) {
  const checkout = useStartProCheckout();
  const portal = useOpenBillingPortal();

  // Nothing is claimed while the read is in flight; a ledger is not urgent enough
  // to hold a skeleton in the page's flow.
  if (state.status === "loading") return null;

  if (state.status === "failed") {
    // Deliberately NOT wrapped in `PanelSection`: `DegradedRegion` renders its own
    // titled frame, and a second heading above it would name the section twice —
    // once as present and once as missing.
    return (
      <div className="mt-12">
        <DegradedRegion failure={state.failure} title="Plan & usage" />
      </div>
    );
  }

  const billing = state.data;
  if (billing.accounts.length === 0) return null;

  return (
    <PanelSection label="Plan & usage">
      <div className={LEDGER_GRID}>
        {billing.accounts.map((account) => {
          // Which row is busy comes from the mutation that is running, not from a
          // store field mirroring it: `variables` is the installation id this
          // very call was made with.
          const busy =
            (checkout.isPending && checkout.variables === account.installationId) ||
            (portal.isPending && portal.variables === account.installationId);
          return (
            // `Card` renders a `<div>` and takes no `asChild`, so the legacy
            // `<article>` element is gone rather than nested. No loss: an
            // `<article>` is for independently distributable content, and a plan
            // card is a fragment of this account's settings. The accessible name
            // it needed came from the section heading either way.
            <Card key={account.installationId}>
              <CardBody className="flex flex-col items-start gap-3">
                <header className="flex w-full items-center justify-between gap-2.5">
                  <span className="min-w-0 truncate font-mono text-sm font-medium text-text">
                    {account.accountLogin}
                  </span>
                  <Badge tone="neutral">{account.plan}</Badge>
                </header>
                <AllowanceMeter label="Protected repositories" bucket={account.protectedRepos} />
                <AllowanceMeter label="Audits this month" bucket={account.monthlyAudits} />
                <p className="text-2xs text-text-3">
                  Public repository scans are not billed to this account — they are free per
                  signed-in user and never consume an allowance here.
                </p>
                {account.upgradeOffers.map((offer) => (
                  <Button
                    key={offer.id}
                    size="sm"
                    disabled={busy || !billing.checkoutEnabled}
                    onClick={() => checkout.mutate(account.installationId)}
                  >
                    <Sparkles aria-hidden="true" className="size-icon-sm" />
                    {busy ? "Redirecting…" : `Upgrade to ${offer.label}`}
                  </Button>
                ))}
                {account.subscriptionActive && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => portal.mutate(account.installationId)}
                  >
                    <CreditCard aria-hidden="true" className="size-icon-sm" />
                    {busy ? "Opening…" : "Manage billing"}
                  </Button>
                )}
              </CardBody>
            </Card>
          );
        })}
      </div>
    </PanelSection>
  );
}
