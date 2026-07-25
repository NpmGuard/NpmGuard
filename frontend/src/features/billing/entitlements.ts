/** The entitlements patch, kept separate from `hooks.ts` so the global 402
 * policy in `lib/query-client.ts` can reach it without importing React hooks. */

import type { AccountEntitlements, BillingResponse } from "@npmguard/shared";

/**
 * Replace one account's entitlements in place, preserving order.
 *
 * A 402 carries the account's FRESH entitlements, so the paywall's exhausted
 * meter renders from the very response that opened it — no second request, no
 * stale quota render (F-E3). `undefined` in and out because the billing read may
 * not have happened (or may have failed): patching a ledger we do not hold is a
 * no-op, never a fabricated one-account ledger.
 */
export function patchEntitlements(
  billing: BillingResponse | undefined,
  entitlements: AccountEntitlements,
): BillingResponse | undefined {
  if (!billing) return billing;
  return {
    ...billing,
    accounts: billing.accounts.map((account) =>
      account.installationId === entitlements.installationId ? entitlements : account,
    ),
  };
}
