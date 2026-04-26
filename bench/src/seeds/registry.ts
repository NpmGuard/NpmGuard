import { z } from "zod";

// ---------------------------------------------------------------------------
// Minimal npm registry client. Bench is its own workspace and avoids
// depending on engine internals — the methodology requires that re-runs
// in 5 years can verify the dataset without the rest of the codebase.
// ---------------------------------------------------------------------------

const NPM_REGISTRY = "https://registry.npmjs.org";

const NpmVersionResponse = z.object({
  version: z.string(),
  dist: z.object({
    tarball: z.string().url(),
    /** SRI string `sha512-<base64>`. Older versions may publish only `shasum` (sha-1). */
    integrity: z.string().optional(),
    shasum: z.string().optional(),
  }),
});
export type NpmVersionMetadata = z.infer<typeof NpmVersionResponse>;

/** Fetch the metadata for an exact `<name>@<version>` from the registry.
 *  Throws on HTTP errors — callers decide whether to retry. */
export async function fetchVersionMetadata(
  name: string,
  version: string,
): Promise<NpmVersionMetadata> {
  const url = `${NPM_REGISTRY}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) {
    throw new Error(`npm registry returned ${resp.status} for ${name}@${version}`);
  }
  return NpmVersionResponse.parse(await resp.json());
}

/** Download the tarball at `url` to `destPath`. Returns the SHA-512 SRI
 *  string of the bytes downloaded so the caller can verify against the
 *  catalogue's locked value. */
export async function downloadTarball(url: string, destPath: string): Promise<string> {
  const { createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  const { createHash } = await import("node:crypto");

  const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) throw new Error(`tarball download failed: HTTP ${resp.status}`);
  if (!resp.body) throw new Error("no response body");

  const hasher = createHash("sha512");
  const fileStream = createWriteStream(destPath);

  // Tee the stream: write to disk and feed the hasher simultaneously.
  // Convert WHATWG ReadableStream → Node Readable, then iterate chunks.
  const nodeStream = Readable.fromWeb(resp.body as import("node:stream/web").ReadableStream);

  nodeStream.on("data", (chunk: Buffer) => hasher.update(chunk));
  await pipeline(nodeStream, fileStream);

  return `sha512-${hasher.digest("base64")}`;
}
