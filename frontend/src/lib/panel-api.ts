/** GitHub panel endpoints (session-gated; cookie rides same-origin fetch). */

import { deleteJson, getJson, postJson } from "./api-base.ts";
import { apiBase } from "./config.ts";
import type {
  Alert,
  BillingResponse,
  OrgsResponse,
  PanelRepo,
  PublicScan,
  PublicScanDetailResponse,
  RepoDetailResponse,
  SessionUser,
} from "./engine-types.ts";

export function fetchMe(): Promise<{ user: SessionUser }> {
  return getJson(`${apiBase()}/me`);
}

export function logout(): Promise<{ ok: true }> {
  return postJson(`${apiBase()}/auth/logout`);
}

/** Full-page navigation target, not a fetch — the engine 302s to GitHub. */
export function githubLoginUrl(): string {
  return `${apiBase()}/auth/github/login`;
}

export function fetchOrgs(): Promise<OrgsResponse> {
  return getJson(`${apiBase()}/panel/orgs`);
}

/** Slow (live GitHub pagination + lockfile probes) — never poll this. */
export function fetchRepos(): Promise<{ repos: PanelRepo[] }> {
  return getJson(`${apiBase()}/panel/repos`);
}

export function fetchAlerts(): Promise<{ alerts: Alert[] }> {
  return getJson(`${apiBase()}/panel/alerts`);
}

export function markAlertsSeen(): Promise<{ ok: true }> {
  return postJson(`${apiBase()}/panel/alerts/seen`);
}

export function fetchBilling(): Promise<BillingResponse> {
  return getJson(`${apiBase()}/panel/billing`);
}

export function startProCheckout(installationId: number): Promise<{ url: string; sessionId: string }> {
  return postJson(`${apiBase()}/panel/billing/checkout`, { installationId }, "Could not start checkout");
}

export function openBillingPortal(installationId: number): Promise<{ url: string }> {
  return postJson(`${apiBase()}/panel/billing/portal`, { installationId }, "Could not open the billing portal");
}

export function triggerRepoScan(repoId: number): Promise<{ scanId: number }> {
  return postJson(`${apiBase()}/panel/repo/${repoId}/scan`, undefined, "Could not start the audit");
}

export function enableProtect(repoId: number): Promise<{ ok: true }> {
  return postJson(`${apiBase()}/panel/repo/${repoId}/protect`, undefined, "Could not enable protection");
}

export function disableProtect(repoId: number): Promise<{ ok: true }> {
  return deleteJson(`${apiBase()}/panel/repo/${repoId}/protect`, "Could not disable protection");
}

export function resyncRepo(repoId: number): Promise<{ scanId: number }> {
  return postJson(`${apiBase()}/panel/repo/${repoId}/resync`, undefined, "Could not re-sync the lockfile");
}

export function fetchRepoDetail(owner: string, name: string): Promise<RepoDetailResponse> {
  return getJson(`${apiBase()}/panel/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
}

export function fetchPublicScans(): Promise<{ scans: PublicScan[] }> {
  return getJson(`${apiBase()}/panel/public-repos`);
}

export function fetchPublicScanDetail(scanId: number): Promise<PublicScanDetailResponse> {
  return getJson(`${apiBase()}/panel/public-repos/${scanId}`);
}

/** 201 {scanId} | 409 {error, scanId} already running (treated as success by
 * the store) | 402 cap | 403 private | 404 | 422 no lockfile | 429. */
export function startPublicRepoScan(
  repository: string,
  installationId: number,
): Promise<{ scanId: number }> {
  return postJson(
    `${apiBase()}/panel/public-repos/scan`,
    { repository, installationId },
    "Could not start the repository audit",
  );
}

export function scanEventsUrl(scanId: number): string {
  return `${apiBase()}/panel/scan/${scanId}/events`;
}
