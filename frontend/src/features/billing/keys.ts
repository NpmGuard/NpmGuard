/** Query keys for the billing / entitlements reads. See session/keys.ts for why
 * these are factories rather than inline arrays. */
export const billingKeys = {
  all: ["billing"] as const,
  /** GET /panel/billing — accounts, plan catalog, checkout availability, price. */
  overview: () => [...billingKeys.all, "overview"] as const,
};
