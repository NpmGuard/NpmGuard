// Types for the repo panel API (engine/src/routes/panel.ts).
// Spec: docs/specs/2026-07-07-github-repo-panel.md

export interface PanelUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface Installation {
  id: number;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
}

export interface UsageAllowance {
  used: number;
  limit: number;
  remaining: number | null;
}

export interface BillingAccount {
  installationId: number;
  accountLogin: string;
  plan: "free" | "pro";
  subscriptionStatus: string;
  protectedRepos: UsageAllowance;
  publicRepoAudits: UsageAllowance;
  monthlyAudits: UsageAllowance;
}

export interface PlanLimits {
  protectedRepos: number;
  publicRepoAudits: number;
  monthlyAudits: number;
}

export interface BillingPrice {
  amount: number | null;
  currency: string;
  interval: string | null;
}

export interface BillingPayload {
  accounts: BillingAccount[];
  plans: { free: PlanLimits; pro: PlanLimits };
  checkoutEnabled: boolean;
  price: BillingPrice | null;
}

export interface PaywallReason {
  message: string;
  resource: "protected_repos" | "public_repo_audits" | "monthly_audits";
  installationId: number;
  entitlements: BillingAccount;
}

export interface ScanSummary {
  id: number;
  status: "running" | "done" | "failed";
  trigger: string;
  total: number;
  cached: number;
  audited: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  verdict?: string | null;
}

export interface RepoSummary {
  id: number;
  installationId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  protected: boolean;
  lastScan: ScanSummary | null;
}

export interface RepoDep {
  name: string;
  version: string;
  direct: boolean;
  range: string | null;
  verdict: string | null; // null = not audited yet (pending or queued)
  auditedAt: string | null;
  jobState: string | null; // 'queued' | 'running' | 'failed' when verdict is null
}

export interface RepoRollup {
  verdict: string | null; // DANGEROUS > SUSPECT > UNKNOWN > SAFE, null = no deps
  dangerous: number;
  suspect: number;
  unknown: number;
  safe: number;
}

export interface PublicRepoScanSummary {
  id: number;
  installationId: number;
  accountLogin: string;
  requestedBy: number;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  defaultBranch: string;
  commitSha: string | null;
  lockfilePath: string;
  lockfileSha: string;
  status: "running" | "done";
  total: number;
  cached: number;
  audited: number;
  failed: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  rollup: RepoRollup;
}

export interface PublicRepoScanDependency {
  name: string;
  version: string;
  direct: boolean;
  range: string | null;
  cached: boolean;
  verdict: string | null;
  reason: string | null;
  evidenceCount: number;
  auditedAt: string | null;
  active: boolean;
  certificate: {
    certificateHash: string;
    status: "pending" | "anchored";
    anchor: {
      chain: "base-sepolia" | "base";
      contractAddress: `0x${string}`;
      batchId: string;
      batchURI: string;
      transactionHash: `0x${string}`;
      blockNumber: string;
      anchoredAt: string;
      merkleRoot: `0x${string}`;
      leafHash: `0x${string}`;
      merkleProof: Array<{
        position: "left" | "right";
        hash: `0x${string}`;
      }>;
    } | null;
  } | null;
}

export interface PublicRepoScanDetailPayload {
  scan: PublicRepoScanSummary;
  dependencies: PublicRepoScanDependency[];
  dependenciesTruncated: boolean;
}

export interface PanelAlert {
  id: number;
  org: string;
  repoId: number | null;
  packageName: string;
  version: string;
  verdict: string;
  kind: string;
  message: string | null;
  seen: boolean;
  createdAt: string;
}

export interface RepoDetailPayload {
  repo: RepoSummary;
  deps: RepoDep[];
  rollup: RepoRollup;
  scan: ScanSummary | null;
  alerts: PanelAlert[];
}
