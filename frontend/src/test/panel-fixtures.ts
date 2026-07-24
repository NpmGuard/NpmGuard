/**
 * Typed fixture builders for the GitHub panel wire shapes (engine-types.ts).
 *
 * Every builder returns a fully-valid default and accepts a shallow `overrides`
 * patch — tests state only the field that matters to the class under test, so a
 * scenario reads as its equivalence class, not as a wall of boilerplate. The
 * defaults are deliberately BENIGN (a free plan with room, a clean SAFE repo)
 * so a test that forgets to set a field fails toward "nothing interesting",
 * never toward a fabricated threat.
 *
 * These mirror the shapes the REAL engine serialises (panel/routes/*.py); the
 * component-integration tests stand in for a hermetic panel e2e, which the live
 * GitHub-App + OAuth dependency makes impossible to run deterministically.
 */

import type {
  AccountEntitlements,
  Alert,
  BillingResponse,
  CapExceededBody,
  CapResource,
  DepDetail,
  Installation,
  OrgsResponse,
  PanelRepo,
  PanelVerdict,
  PlanLimits,
  PublicScan,
  PublicScanDep,
  PublicScanDetailResponse,
  RepoDetailResponse,
  Rollup,
  ScanSummary,
  SessionUser,
  UsageBucket,
} from "../lib/engine-types.ts";

export function makeUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 4242,
    login: "octocat",
    name: "Octo Cat",
    email: "octo@example.com",
    avatarUrl: "https://avatars.example.com/octocat.png",
    ...overrides,
  };
}

export function makeInstallation(overrides: Partial<Installation> = {}): Installation {
  return {
    id: 1001,
    accountLogin: "octo-org",
    accountType: "Organization",
    suspended: false,
    ...overrides,
  };
}

export function makeOrgs(overrides: Partial<OrgsResponse> = {}): OrgsResponse {
  return {
    installations: [makeInstallation()],
    installUrl: "https://github.com/apps/npmguard/installations/new",
    ...overrides,
  };
}

export function makeScan(overrides: Partial<ScanSummary> = {}): ScanSummary {
  return {
    id: 5001,
    status: "done",
    trigger: "manual",
    total: 12,
    cached: 8,
    audited: 4,
    failed: 0,
    startedAt: "2026-07-20T10:00:00Z",
    finishedAt: "2026-07-20T10:02:00Z",
    verdict: "SAFE",
    ...overrides,
  };
}

export function makeRepo(overrides: Partial<PanelRepo> = {}): PanelRepo {
  const owner = overrides.owner ?? "octo-org";
  const name = overrides.name ?? "web-app";
  return {
    id: 9001,
    installationId: 1001,
    owner,
    name,
    fullName: `${owner}/${name}`,
    private: false,
    defaultBranch: "main",
    protected: false,
    lastScan: null,
    ...overrides,
  };
}

export function makeDep(overrides: Partial<DepDetail> = {}): DepDetail {
  return {
    name: "left-pad",
    version: "1.3.0",
    direct: true,
    range: "^1.3.0",
    verdict: "SAFE",
    verdictReason: null,
    evidenceCount: 0,
    auditedAt: "2026-07-20T10:01:00Z",
    jobState: null,
    ...overrides,
  };
}

export function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 7001,
    org: "octo-org",
    repoId: 9001,
    packageName: "evil-pkg",
    version: "6.6.6",
    verdict: "DANGEROUS",
    kind: "scan",
    message: "Credential theft detected in postinstall",
    seen: false,
    createdAt: "2026-07-20T10:05:00Z",
    ...overrides,
  };
}

export function makeRollup(overrides: Partial<Rollup> = {}): Rollup {
  return {
    verdict: "SAFE",
    dangerous: 0,
    suspect: 0,
    unknown: 0,
    safe: 12,
    ...overrides,
  };
}

export function makeRepoDetail(overrides: Partial<RepoDetailResponse> = {}): RepoDetailResponse {
  const repo = overrides.repo ?? makeRepo();
  return {
    repo,
    deps: [makeDep()],
    rollup: makeRollup(),
    scan: makeScan(),
    alerts: [],
    ...overrides,
  };
}

export function makeBucket(overrides: Partial<UsageBucket> = {}): UsageBucket {
  const used = overrides.used ?? 1;
  const limit = overrides.limit ?? 5;
  // remaining === null means UNLIMITED (limit 0); otherwise limit - used floored at 0.
  const remaining =
    "remaining" in overrides ? (overrides.remaining as number | null) : Math.max(0, limit - used);
  return { used, limit, remaining };
}

/** A generous, non-exhausted free account. */
export function makeEntitlements(overrides: Partial<AccountEntitlements> = {}): AccountEntitlements {
  return {
    installationId: 1001,
    accountLogin: "octo-org",
    plan: "free",
    subscriptionStatus: "active",
    protectedRepos: makeBucket({ used: 1, limit: 3 }),
    publicRepoAudits: makeBucket({ used: 0, limit: 2 }),
    monthlyAudits: makeBucket({ used: 4, limit: 50 }),
    ...overrides,
  };
}

const FREE_LIMITS: PlanLimits = { protectedRepos: 3, publicRepoAudits: 2, monthlyAudits: 50 };
const PRO_LIMITS: PlanLimits = { protectedRepos: 0, publicRepoAudits: 0, monthlyAudits: 0 };

export function makeBilling(overrides: Partial<BillingResponse> = {}): BillingResponse {
  return {
    accounts: [makeEntitlements()],
    plans: { free: FREE_LIMITS, pro: PRO_LIMITS },
    checkoutEnabled: true,
    price: { amount: 1900, currency: "usd", interval: "month" },
    ...overrides,
  };
}

/** A 402 cap body — everything the paywall needs without a second request. */
export function makeCapBody(
  resource: CapResource = "protected_repos",
  overrides: Partial<CapExceededBody> = {},
): CapExceededBody {
  return {
    error: "Plan limit reached",
    cap: true,
    resource,
    installationId: 1001,
    entitlements: makeEntitlements({
      protectedRepos: makeBucket({ used: 3, limit: 3, remaining: 0 }),
    }),
    ...overrides,
  };
}

export function makePublicScan(overrides: Partial<PublicScan> = {}): PublicScan {
  const owner = overrides.owner ?? "some-org";
  const name = overrides.name ?? "public-lib";
  return {
    id: 3001,
    installationId: 1001,
    accountLogin: "octo-org",
    requestedBy: 4242,
    githubRepoId: 55555,
    owner,
    name,
    fullName: `${owner}/${name}`,
    htmlUrl: `https://github.com/${owner}/${name}`,
    defaultBranch: "main",
    commitSha: "abc1234",
    lockfilePath: "package-lock.json",
    lockfileSha: "def5678",
    status: "done",
    total: 20,
    cached: 15,
    audited: 5,
    failed: 0,
    error: null,
    startedAt: "2026-07-20T09:00:00Z",
    finishedAt: "2026-07-20T09:04:00Z",
    rollup: makeRollup({ safe: 20 }),
    ...overrides,
  };
}

export function makePublicScanDep(overrides: Partial<PublicScanDep> = {}): PublicScanDep {
  return {
    name: "chalk",
    version: "5.6.2",
    direct: true,
    range: "^5.6.0",
    cached: true,
    verdict: "SAFE",
    reason: null,
    evidenceCount: 0,
    auditedAt: "2026-07-20T09:03:00Z",
    active: false,
    ...overrides,
  };
}

export function makePublicScanDetail(
  overrides: Partial<PublicScanDetailResponse> = {},
): PublicScanDetailResponse {
  return {
    scan: makePublicScan(),
    dependenciesTruncated: false,
    dependencies: [makePublicScanDep()],
    ...overrides,
  };
}

/** Convenience: a DANGEROUS dep for review-queue / attention classes. */
export function dangerousDep(overrides: Partial<DepDetail> = {}): DepDetail {
  return makeDep({
    name: "evil-pkg",
    version: "6.6.6",
    verdict: "DANGEROUS" as PanelVerdict,
    verdictReason: "postinstall exfiltrates env",
    evidenceCount: 3,
    ...overrides,
  });
}

/** Convenience: a pending (queued/running) dep — verdict null, carried by jobState. */
export function pendingDep(overrides: Partial<DepDetail> = {}): DepDetail {
  return makeDep({
    name: "pending-pkg",
    version: "0.1.0",
    verdict: null,
    jobState: "queued",
    auditedAt: null,
    ...overrides,
  });
}
