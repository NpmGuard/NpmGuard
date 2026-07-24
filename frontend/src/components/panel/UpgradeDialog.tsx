/** Paywall dialog driven by store.paywall (the 402 cap body carries fresh
 * entitlements, so the exhausted meter renders without a second request). */

import { Sparkles, X } from "lucide-react";
import type { CapResource, UsageBucket } from "../../lib/engine-types.ts";
import { formatCents } from "../../lib/format.ts";
import { usePanelStore } from "../../stores/panelStore.ts";
import { AllowanceMeter } from "./AllowanceMeter.tsx";
import { PanelDialog } from "./PanelDialog.tsx";

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
  const paywall = usePanelStore((s) => s.paywall);
  const billing = usePanelStore((s) => s.billing);
  const busyInstallationId = usePanelStore((s) => s.billingBusyInstallationId);
  const startProCheckout = usePanelStore((s) => s.startProCheckout);
  const closePaywall = usePanelStore((s) => s.closePaywall);

  if (!paywall) return null;

  const meta = RESOURCE_META[paywall.resource];
  const entitlements = paywall.entitlements;
  const bucket: UsageBucket =
    paywall.resource === "protected_repos"
      ? entitlements.protectedRepos
      : paywall.resource === "public_repo_audits"
        ? entitlements.publicRepoAudits
        : entitlements.monthlyAudits;
  const pro = billing?.plans.pro ?? null;
  const price = billing?.price ?? null;
  const checkoutEnabled = billing?.checkoutEnabled ?? false;
  const busy = busyInstallationId === paywall.installationId;

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
                <strong className="panel-strong">{formatCents(price.amount, price.currency)}</strong>
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
          <p className="microtext">SUSPECT and UNKNOWN findings remain non-blocking.</p>
        </div>
        {!checkoutEnabled && (
          <p className="microtext">Checkout is not configured on this server.</p>
        )}
      </div>
      <div className="dialog__footer">
        <button type="button" className="btn" onClick={closePaywall}>
          Not now
        </button>
        <button
          type="button"
          className="btn btn--violet"
          disabled={!checkoutEnabled || busy}
          onClick={() => void startProCheckout(paywall.installationId)}
        >
          <Sparkles size={13} />
          {busy ? "Redirecting…" : "Continue to Stripe"}
        </button>
      </div>
    </PanelDialog>
  );
}
