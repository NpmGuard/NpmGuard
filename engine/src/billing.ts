import { getDb, nowIso } from "./db.js";

export interface BillingAccountRow {
  installation_id: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string;
}

export function getBillingAccount(installationId: number): BillingAccountRow | null {
  return (
    (getDb()
      .prepare("SELECT * FROM billing_accounts WHERE installation_id = ?")
      .get(installationId) as BillingAccountRow | undefined) ?? null
  );
}

export function findInstallationForSubscription(subscriptionId: string): number | null {
  const row = getDb()
    .prepare("SELECT installation_id FROM billing_accounts WHERE stripe_subscription_id = ?")
    .get(subscriptionId) as { installation_id: number } | undefined;
  return row?.installation_id ?? null;
}

export function upsertSubscription(params: {
  installationId: number;
  customerId: string | null;
  subscriptionId: string;
  status: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO billing_accounts (
         installation_id, stripe_customer_id, stripe_subscription_id,
         subscription_status, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(installation_id) DO UPDATE SET
         stripe_customer_id = COALESCE(excluded.stripe_customer_id, billing_accounts.stripe_customer_id),
         stripe_subscription_id = excluded.stripe_subscription_id,
         subscription_status = excluded.subscription_status,
         updated_at = excluded.updated_at`,
    )
    .run(
      params.installationId,
      params.customerId,
      params.subscriptionId,
      params.status,
      nowIso(),
    );
}

export function updateSubscriptionStatus(subscriptionId: string, status: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE billing_accounts
       SET subscription_status = ?, updated_at = ?
       WHERE stripe_subscription_id = ?`,
    )
    .run(status, nowIso(), subscriptionId);
  return result.changes > 0;
}
