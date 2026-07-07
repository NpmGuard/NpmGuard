import type { Octokit } from "@octokit/rest";
import { LOCKFILE_CANDIDATES } from "../lockfile/index.js";

// Repo file access via the contents API (Contents:read App permission).

export interface FetchedFile {
  path: string;
  sha: string;
  content: string;
}

export async function fetchRepoFile(
  octo: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<FetchedFile | null> {
  let data;
  try {
    ({ data } = await octo.rest.repos.getContent({
      owner,
      repo,
      path,
      ...(ref ? { ref } : {}),
    }));
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
  if (Array.isArray(data) || data.type !== "file") return null;

  if (data.content && data.encoding === "base64") {
    return { path, sha: data.sha, content: Buffer.from(data.content, "base64").toString("utf-8") };
  }
  // Files >1MB come back without inline content (encoding "none") — big
  // monorepo package-lock.json files routinely exceed that. Fetch the blob.
  const { data: blob } = await octo.rest.git.getBlob({ owner, repo, file_sha: data.sha });
  return { path, sha: data.sha, content: Buffer.from(blob.content, "base64").toString("utf-8") };
}

/** First supported lockfile found at the repo root, or null. */
export async function fetchLockfile(
  octo: Octokit,
  owner: string,
  repo: string,
  ref?: string,
): Promise<FetchedFile | null> {
  for (const candidate of LOCKFILE_CANDIDATES) {
    const file = await fetchRepoFile(octo, owner, repo, candidate, ref);
    if (file) return file;
  }
  return null;
}

/** Parsed root package.json, or null when absent/unparseable. */
export async function fetchManifest(
  octo: Octokit,
  owner: string,
  repo: string,
  ref?: string,
): Promise<Record<string, unknown> | null> {
  const file = await fetchRepoFile(octo, owner, repo, "package.json", ref);
  if (!file) return null;
  try {
    return JSON.parse(file.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}
