/** Per-billing-account plan cards: plan pill, allowance meters, and the
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
 * structurally — there is no `data` on the `failed` arm to render. */

import type { BillingResponse } from "@npmguard/shared";
import { CreditCard, Sparkles } from "lucide-react";
import { DegradedRegion } from "../../../components/ui/degraded-state.tsx";
import type { LoadState } from "../../../components/ui/load-state.ts";
import { useOpenBillingPortal, useStartProCheckout } from "../hooks.ts";
import { AllowanceMeter } from "./AllowanceMeter.tsx";

export function PlanLedger({ state }: { state: LoadState<BillingResponse> }) {
  const checkout = useStartProCheckout();
  const portal = useOpenBillingPortal();

  // Nothing is claimed while the read is in flight; a ledger is not urgent enough
  // to hold a skeleton in the page's flow.
  if (state.status === "loading") return null;

  if (state.status === "failed") {
    return (
      <section className="panel-section">
        <DegradedRegion failure={state.failure} title="Plan & usage" />
      </section>
    );
  }

  const billing = state.data;
  if (billing.accounts.length === 0) return null;

  return (
    <section className="panel-section" aria-label="Plan and usage">
      <div className="section-title">
        <span className="eyebrow eyebrow--faint">Plan &amp; usage</span>
      </div>
      <div className="panel-ledger">
        {billing.accounts.map((account) => {
          // Which row is busy comes from the mutation that is running, not from a
          // store field mirroring it: `variables` is the installation id this
          // very call was made with.
          const busy =
            (checkout.isPending && checkout.variables === account.installationId) ||
            (portal.isPending && portal.variables === account.installationId);
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
                  onClick={() => checkout.mutate(account.installationId)}
                >
                  <Sparkles size={13} />
                  {busy ? "Redirecting…" : "Upgrade to Pro"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => portal.mutate(account.installationId)}
                >
                  <CreditCard size={13} />
                  {busy ? "Opening…" : "Manage billing"}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
