/** Per-billing-account plan cards: plan pill, allowance meters, and the
 * upgrade / manage-billing action. Degrades to the billing error line when
 * the billing fetch failed. */

import { CreditCard, Sparkles } from "lucide-react";
import { usePanelStore } from "../../stores/panelStore.ts";
import { AllowanceMeter } from "./AllowanceMeter.tsx";

export function PlanLedger() {
  const billing = usePanelStore((s) => s.billing);
  const billingError = usePanelStore((s) => s.billingError);
  const busyInstallationId = usePanelStore((s) => s.billingBusyInstallationId);
  const startProCheckout = usePanelStore((s) => s.startProCheckout);
  const openBillingPortal = usePanelStore((s) => s.openBillingPortal);

  if (!billing && !billingError) return null;

  return (
    <section className="panel-section" aria-label="Plan and usage">
      <div className="section-title">
        <span className="eyebrow eyebrow--faint">Plan &amp; usage</span>
      </div>
      {billing && billing.accounts.length > 0 && (
        <div className="panel-ledger">
          {billing.accounts.map((account) => {
            const busy = busyInstallationId === account.installationId;
            return (
              <article key={account.installationId} className="card panel-account">
                <header className="panel-account__head">
                  <span className="mono panel-account__login">{account.accountLogin}</span>
                  <span className={`pill${account.plan === "pro" ? " pill--violet" : ""}`}>
                    {account.plan}
                  </span>
                </header>
                <AllowanceMeter label="Protected repositories" bucket={account.protectedRepos} />
                <AllowanceMeter label="Public repository audits" bucket={account.publicRepoAudits} />
                <p className="microtext">
                  Re-auditing the same public repository never consumes another slot.
                </p>
                {account.plan === "free" ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--violet"
                    disabled={busy || !billing.checkoutEnabled}
                    onClick={() => void startProCheckout(account.installationId)}
                  >
                    <Sparkles size={13} />
                    {busy ? "Redirecting…" : "Upgrade to Pro"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => void openBillingPortal(account.installationId)}
                  >
                    <CreditCard size={13} />
                    {busy ? "Opening…" : "Manage billing"}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
      {billingError && (
        <p className="banner banner--danger panel-banner-gap" role="alert">
          {billingError}
        </p>
      )}
    </section>
  );
}
