import { config } from "./config.js";
import { getDb } from "./db.js";

// Beta soft caps (spec decision 9): per-org limits on protected repos and
// monthly package-audits, with a friendly "talk to us" wall. Hitting a cap
// is a sales signal, not an error. Watch-triggered audits are NOT charged —
// they fill the shared report cache and benefit every org.

export class CapExceededError extends Error {
  readonly cap = true;
  constructor(message: string) {
    super(message);
    this.name = "CapExceededError";
  }
}

function monthKey(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

export function protectedRepoCount(org: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM repos r
       JOIN installations i ON i.id = r.installation_id
       WHERE i.account_login = ? AND r.protected_at IS NOT NULL`,
    )
    .get(org) as { c: number };
  return row.c;
}

export function assertProtectCap(org: string): void {
  const max = config.betaMaxProtectedRepos;
  if (max > 0 && protectedRepoCount(org) >= max) {
    throw new CapExceededError(
      `Beta limit reached: ${max} protected repos for ${org}`,
    );
  }
}

export function auditsUsedThisMonth(org: string): number {
  const row = getDb()
    .prepare("SELECT audits FROM org_usage WHERE org = ? AND month = ?")
    .get(org, monthKey()) as { audits: number } | undefined;
  return row?.audits ?? 0;
}

export function assertAuditBudget(org: string, count: number): void {
  const max = config.betaMaxAuditsMonth;
  if (max > 0 && auditsUsedThisMonth(org) + count > max) {
    throw new CapExceededError(
      `Beta limit reached: this scan needs ${count} new audits but ${org} has ` +
        `${Math.max(0, max - auditsUsedThisMonth(org))} of ${max} left this month`,
    );
  }
}

export function consumeAuditBudget(org: string, count: number): void {
  if (count <= 0) return;
  getDb()
    .prepare(
      `INSERT INTO org_usage (org, month, audits) VALUES (?, ?, ?)
       ON CONFLICT(org, month) DO UPDATE SET audits = audits + excluded.audits`,
    )
    .run(org, monthKey(), count);
}
