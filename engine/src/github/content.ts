import type { Octokit } from "@octokit/rest";
import { LOCKFILE_CANDIDATES } from "../lockfile/index.js";

// Repo file access via the contents API (Contents:read App permission).

export interface FetchedFile {
  path: string;
  sha: string;
  content: string;
}

export interface RootLockfile {
  path: string;
  sha: string;
}

interface PublicRootFile {
  type: string;
  name: string;
  path: string;
  sha: string;
  download_url: string | null;
}

export interface PublicRepoInputs {
  lockfile: FetchedFile;
  manifest: Record<string, unknown> | null;
}

const MAX_PUBLIC_REPO_FILE_BYTES = 20 * 1024 * 1024;

export class PublicRepoFileTooLargeError extends Error {
  constructor(path: string) {
    super(`${path} exceeds the 20 MB public-audit file limit`);
    this.name = "PublicRepoFileTooLargeError";
  }
}

/**
 * Detect a supported lockfile at the repository root without downloading it.
 * This costs one Contents API request per repo instead of up to three file
 * requests and is used by the dashboard's cached auditability filter.
 */
export async function findRootLockfile(
  octo: Octokit,
  owner: string,
  repo: string,
  ref?: string,
): Promise<RootLockfile | null> {
  let data;
  try {
    ({ data } = await octo.rest.repos.getContent({
      owner,
      repo,
      path: "",
      ...(ref ? { ref } : {}),
    }));
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
  if (!Array.isArray(data)) return null;

  for (const candidate of LOCKFILE_CANDIDATES) {
    const entry = data.find((item) => item.type === "file" && item.name === candidate);
    if (entry) return { path: entry.path, sha: entry.sha };
  }
  return null;
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

async function downloadPublicRootFile(file: PublicRootFile): Promise<string> {
  if (!file.download_url) throw new Error(`GitHub did not provide a download URL for ${file.path}`);
  const url = new URL(file.download_url);
  if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com") {
    throw new Error(`GitHub returned an unsafe download URL for ${file.path}`);
  }
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) throw new Error(`GitHub raw download failed (${response.status})`);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PUBLIC_REPO_FILE_BYTES) {
    throw new PublicRepoFileTooLargeError(file.path);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_PUBLIC_REPO_FILE_BYTES) {
      await reader.cancel();
      throw new PublicRepoFileTooLargeError(file.path);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, received).toString("utf-8");
}

/**
 * Fetch a public repo's root once, then download the selected files from
 * GitHub's public raw host. This keeps anonymous API usage to one request and
 * cannot reveal private content because the Octokit client has no auth.
 */
export async function fetchPublicRepoInputs(
  octo: Octokit,
  owner: string,
  repo: string,
  ref?: string,
): Promise<PublicRepoInputs | null> {
  let data;
  try {
    ({ data } = await octo.rest.repos.getContent({
      owner,
      repo,
      path: "",
      ...(ref ? { ref } : {}),
    }));
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
  if (!Array.isArray(data)) return null;

  const files = data as PublicRootFile[];
  const lockfileEntry = LOCKFILE_CANDIDATES.map((name) =>
    files.find((item) => item.type === "file" && item.name === name),
  ).find((item): item is PublicRootFile => !!item);
  if (!lockfileEntry) return null;

  const manifestEntry = files.find(
    (item) => item.type === "file" && item.name === "package.json",
  );
  const [lockfileContent, manifestContent] = await Promise.all([
    downloadPublicRootFile(lockfileEntry),
    manifestEntry ? downloadPublicRootFile(manifestEntry) : Promise.resolve(null),
  ]);

  let manifest: Record<string, unknown> | null = null;
  if (manifestContent) {
    try {
      manifest = JSON.parse(manifestContent) as Record<string, unknown>;
    } catch {
      // A malformed package.json does not invalidate a parseable lockfile.
    }
  }

  return {
    lockfile: {
      path: lockfileEntry.path,
      sha: lockfileEntry.sha,
      content: lockfileContent,
    },
    manifest,
  };
}
