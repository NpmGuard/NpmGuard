import { config } from "./config.js";
import { getDb } from "./db.js";

// Entitlements are enforced per GitHub App installation. That makes an
// organization (or a personal installation) the billing account shared by
// every member who can access it.

export type AccountPlan = "free" | "pro";
export type CapResource = "repositories" | "monthly_audits";

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

export interface AccountEntitlements {
  installationId: number;
  accountLogin: string;
  plan: AccountPlan;
  subscriptionStatus: string;
  repositories: { used: number; limit: number; remaining: number | null };
  monthlyAudits: { used: number; limit: number; remaining: number | null };
}

export interface PlanLimits {
  repositories: number;
  monthlyAudits: number;
}

export class CapExceededError extends Error {
  readonly cap = true;

  constructor(
    message: string,
    readonly installationId: number,
    readonly resource: CapResource,
    readonly entitlements: AccountEntitlements,
  ) {
    super(message);
    this.name = "CapExceededError";
  }
}

function monthKey(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function installationAccount(installationId: number): string {
  const row = getDb()
    .prepare("SELECT account_login FROM installations WHERE id = ?")
    .get(installationId) as { account_login: string } | undefined;
  if (!row) throw new Error(`GitHub installation ${installationId} not found`);
  return row.account_login;
}

export function accountPlan(installationId: number): {
  plan: AccountPlan;
  subscriptionStatus: string;
} {
  const row = getDb()
    .prepare("SELECT subscription_status FROM billing_accounts WHERE installation_id = ?")
    .get(installationId) as { subscription_status: string } | undefined;
  const subscriptionStatus = row?.subscription_status ?? "inactive";
  return {
    plan: ACTIVE_SUBSCRIPTION_STATUSES.has(subscriptionStatus) ? "pro" : "free",
    subscriptionStatus,
  };
}

function planLimits(plan: AccountPlan): PlanLimits {
  return plan === "pro"
    ? {
        repositories: config.proMaxRepositories,
        monthlyAudits: config.proMaxAuditsMonth,
      }
    : {
        repositories: config.freeMaxRepositories,
        monthlyAudits: config.freeMaxAuditsMonth,
      };
}

export function getPlanCatalog(): Record<AccountPlan, PlanLimits> {
  return { free: planLimits("free"), pro: planLimits("pro") };
}

function remaining(limit: number, used: number): number | null {
  return limit === 0 ? null : Math.max(0, limit - used);
}

export function repositoryCount(installationId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c
       FROM (
         SELECT id AS github_repo_id
         FROM repos
         WHERE installation_id = ? AND protected_at IS NOT NULL
         UNION
         SELECT github_repo_id
         FROM public_repo_scans
         WHERE installation_id = ?
       )`,
    )
    .get(installationId, installationId) as { c: number };
  return row.c;
}

function repositoryUsesAllowance(installationId: number, githubRepoId: number): boolean {
  return !!getDb()
    .prepare(
      `SELECT 1
       FROM (
         SELECT id AS github_repo_id
         FROM repos
         WHERE installation_id = ? AND protected_at IS NOT NULL
         UNION
         SELECT github_repo_id
         FROM public_repo_scans
         WHERE installation_id = ?
       )
       WHERE github_repo_id = ?
       LIMIT 1`,
    )
    .get(installationId, installationId, githubRepoId);
}

export function auditsUsedThisMonth(installationId: number): number {
  const row = getDb()
    .prepare("SELECT audits FROM account_usage WHERE installation_id = ? AND month = ?")
    .get(installationId, monthKey()) as { audits: number } | undefined;
  return row?.audits ?? 0;
}

export function getAccountEntitlements(installationId: number): AccountEntitlements {
  const accountLogin = installationAccount(installationId);
  const { plan, subscriptionStatus } = accountPlan(installationId);
  const limits = planLimits(plan);
  const repositories = repositoryCount(installationId);
  const monthlyAudits = auditsUsedThisMonth(installationId);
  return {
    installationId,
    accountLogin,
    plan,
    subscriptionStatus,
    repositories: {
      used: repositories,
      limit: limits.repositories,
      remaining: remaining(limits.repositories, repositories),
    },
    monthlyAudits: {
      used: monthlyAudits,
      limit: limits.monthlyAudits,
      remaining: remaining(limits.monthlyAudits, monthlyAudits),
    },
  };
}

export function assertRepositoryCap(installationId: number, githubRepoId: number): void {
  if (repositoryUsesAllowance(installationId, githubRepoId)) return;

  const entitlements = getAccountEntitlements(installationId);
  const { used, limit } = entitlements.repositories;
  if (limit > 0 && used >= limit) {
    throw new CapExceededError(
      `${entitlements.accountLogin} has used all ${limit} ${entitlements.plan.toUpperCase()} repositories. Re-auditing or protecting the same repository remains free.`,
      installationId,
      "repositories",
      entitlements,
    );
  }
}

export function assertAuditBudget(installationId: number, count: number): void {
  const entitlements = getAccountEntitlements(installationId);
  const { used, limit, remaining: available } = entitlements.monthlyAudits;
  if (limit > 0 && used + count > limit) {
    throw new CapExceededError(
      `This scan needs ${count} new package audits, but ${entitlements.accountLogin} has ${available ?? 0} of ${limit} left this month`,
      installationId,
      "monthly_audits",
      entitlements,
    );
  }
}

export function consumeAuditBudget(installationId: number, count: number): void {
  if (count <= 0) return;
  getDb()
    .prepare(
      `INSERT INTO account_usage (installation_id, month, audits) VALUES (?, ?, ?)
       ON CONFLICT(installation_id, month) DO UPDATE SET audits = audits + excluded.audits`,
    )
    .run(installationId, monthKey(), count);
}
