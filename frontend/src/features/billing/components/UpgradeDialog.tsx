/** Paywall dialog driven by the one cross-page UI fact in the store.
 *
 * The 402 cap body carries FRESH entitlements, so the exhausted meter renders
 * from the response that opened this dialog — no second request, no stale quota.
 * That is also why the dialog survives a failed billing read: its subject comes
 * from the 402, and only the Pro offer beside it needs the ledger. */

import type { CapResource, UsageBucket } from "@npmguard/shared";
import { Sparkles, X } from "lucide-react";
import { PanelDialog } from "../../../components/panel/PanelDialog.tsx";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
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
      `The Free plan protects up to ${limit} ${limit === 1 ? "repository" : "repositories"} with continuous monitoring. Unprotect one, or upgrade for more.`,
  },
  public_repo_audits: {
    title: "Free repository allowance used",
    meterLabel: "Public repository audits",
    copy: (limit) =>
      `Free includes ${limit} distinct public ${limit === 1 ? "repository" : "repositories"}. Re-auditing one you already scanned remains free.`,
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
      : paywall.resource === "public_repo_audits"
        ? entitlements.publicRepoAudits
        : entitlements.monthlyAudits;
  // The dialog's OWN subject — the exhausted bucket — comes from the 402 body, so
  // it renders in full even when the billing read failed. What the billing read
  // adds is the Pro offer beside it, and each of those is guarded on its own.
  const catalog = billing.status === "ok" ? billing.data : null;
  const pro = catalog?.plans.pro ?? null;
  const price = catalog?.price ?? null;
  const checkoutEnabled = catalog?.checkoutEnabled ?? false;
  const busy = checkout.isPending && checkout.variables === paywall.installationId;

  return (
    <PanelDialog ariaLabel="Upgrade to Pro" onClose={closePaywall}>
      <div className="dialog__header">
        <div>
          <span className="eyebrow eyebrow--danger">Allowance</span>
          <h2 className="headline panel-dialog-sub">{meta.title}</h2>
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={closePaywall}>
          <X size={15} />
        </button>
      </div>
      <div className="dialog__body panel-paywall">
        <p className="subtext">{meta.copy(bucket.limit)}</p>
        <div className="panel-paywall__usage">
          <span className="microtext mono">{entitlements.accountLogin}</span>
          <AllowanceMeter label={meta.meterLabel} bucket={bucket} />
        </div>
        <div className="card panel-paywall__offer">
          <div className="panel-paywall__offerhead">
            <span className="pill pill--violet">Pro</span>
            {price?.amount != null && (
              <span className="subtext">
                {/* `currency` is nullable on the wire (the schema is right and the
                    old hand-written `string` was wrong — Stripe can omit it), so
                    the display default lives here rather than in a cast. */}
                <strong className="panel-strong">
                  {formatCents(price.amount, price.currency ?? undefined)}
                </strong>
                {price.interval ? ` / ${price.interval}` : ""}
              </span>
            )}
          </div>
          {pro && (
            <ul className="panel-paywall__limits">
              <li>
                <span className="mono">{limitLabel(pro.protectedRepos)}</span> protected
                repositories
              </li>
              <li>
                <span className="mono">{limitLabel(pro.publicRepoAudits)}</span> public repository
                audits
              </li>
              <li>
                <span className="mono">{limitLabel(pro.monthlyAudits)}</span> package audits per
                month
              </li>
            </ul>
          )}
          <p className="microtext">
            Only DANGEROUS blocks an install; audits that could not conclude are
            reported, never hidden.
          </p>
        </div>
        {/* "Not configured" and "we could not find out" are different facts, and
            the button is disabled either way — so saying the first when the second
            is true would send the reader to the wrong place. */}
        {billing.status === "failed" ? (
          <DegradedRegion failure={billing.failure} title="Pro plan" />
        ) : !checkoutEnabled ? (
          <p className="microtext">Checkout is not configured on this server.</p>
        ) : null}
      </div>
      <div className="dialog__footer">
        <button type="button" className="btn" onClick={closePaywall}>
          Not now
        </button>
        <button
          type="button"
          className="btn btn--violet"
          disabled={!checkoutEnabled || busy}
          onClick={() => checkout.mutate(paywall.installationId)}
        >
          <Sparkles size={13} />
          {busy ? "Redirecting…" : "Continue to Stripe"}
        </button>
      </div>
    </PanelDialog>
  );
}
