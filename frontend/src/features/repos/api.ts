/**
 * Repository + audit-set endpoints.
 *
 * Owned-repo scans and public-repo audits share this module because R-1 made
 * them one entity: `scanId` is an audit-set id on every route below, and
 * `scanEventsUrl` is the ONE progress transport for both (the public-scan
 * polling loop it replaced was the second progress implementation).
 */

import {
  OkResponseSchema,
  PublicRepoScanDetailResponseSchema,
  PublicRepoScansResponseSchema,
  RepoDetailResponseSchema,
  ReposResponseSchema,
  ScanStartedResponseSchema,
  type ScanStartedResponse,
} from "@npmguard/shared";
import { scanAlreadyRunning } from "../../lib/api-base.ts";
import { apiBase } from "../../lib/config.ts";
import { deleteWire, getWire, postWire } from "../../lib/wire.ts";

/** Slow: live GitHub pagination plus a lockfile probe per repo. Never poll it —
 * see the `staleTime` on `useRepos`. */
export function fetchRepos() {
  return getWire(`${apiBase()}/panel/repos`, ReposResponseSchema, "GET /panel/repos");
}

export function fetchRepoDetail(owner: string, name: string) {
  return getWire(
    `${apiBase()}/panel/repo/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    RepoDetailResponseSchema,
    `GET /panel/repo/${owner}/${name}`,
  );
}

export function triggerRepoScan(repoId: number) {
  return postWire(
    `${apiBase()}/panel/repo/${repoId}/scan`,
    ScanStartedResponseSchema,
    "POST /panel/repo/{id}/scan",
    undefined,
    "Could not start the audit",
  );
}

export function enableProtect(repoId: number) {
  return postWire(
    `${apiBase()}/panel/repo/${repoId}/protect`,
    OkResponseSchema,
    "POST /panel/repo/{id}/protect",
    undefined,
    "Could not enable protection",
  );
}

export function disableProtect(repoId: number) {
  return deleteWire(
    `${apiBase()}/panel/repo/${repoId}/protect`,
    OkResponseSchema,
    "DELETE /panel/repo/{id}/protect",
    "Could not disable protection",
  );
}

export function resyncRepo(repoId: number) {
  return postWire(
    `${apiBase()}/panel/repo/${repoId}/resync`,
    ScanStartedResponseSchema,
    "POST /panel/repo/{id}/resync",
    undefined,
    "Could not re-sync the lockfile",
  );
}

export function fetchPublicScans() {
  return getWire(
    `${apiBase()}/panel/public-repos`,
    PublicRepoScansResponseSchema,
    "GET /panel/public-repos",
  );
}

export function fetchPublicScanDetail(scanId: number) {
  return getWire(
    `${apiBase()}/panel/public-repos/${scanId}`,
    PublicRepoScanDetailResponseSchema,
    `GET /panel/public-repos/${scanId}`,
  );
}

/**
 * 201 {scanId} | 403 private | 404 | 409 already running | 422 no lockfile |
 * 429 (GitHub's rate limit, or this user's live-scan concurrency).
 *
 * No 402: a public scan is not billed (D-1), so its cost ceiling degrades what
 * the scan covers rather than opening a paywall.
 *
 * The 409 is resolved to a SUCCESS here, at the boundary, because that is what it
 * means: a set for this repo is already live and streamable, so the caller
 * streams `scanId` instead of showing a red banner. It is a schema parse
 * (`ScanAlreadyRunning`), not a `typeof body.scanId === "number"` sniff — naming
 * the body is what forces both scan-trigger call sites to agree that it is not a
 * failure.
 */
export async function startPublicRepoScan(vars: {
  repository: string;
}): Promise<ScanStartedResponse> {
  try {
    return await postWire(
      `${apiBase()}/panel/public-repos/scan`,
      ScanStartedResponseSchema,
      "POST /panel/public-repos/scan",
      vars,
      "Could not start the repository audit",
    );
  } catch (err) {
    const running = scanAlreadyRunning(err);
    if (running) return { scanId: running.scanId };
    throw err;
  }
}

/** Progress SSE for ANY audit set — an owned-repo scan and a public-repo audit
 * are the same entity after R-1, so `scanId` is a set id and this is the ONE
 * progress transport. */
export function scanEventsUrl(scanId: number): string {
  return `${apiBase()}/panel/scan/${scanId}/events`;
}
