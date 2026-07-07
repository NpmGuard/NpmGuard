export interface NpmTarball {
  fileName: string;
  tarballUrl: string;
  bytes: Uint8Array;
  integrity?: string;
  shasum?: string;
}

interface NpmVersionMetadata {
  dist?: {
    tarball?: unknown;
    integrity?: unknown;
    shasum?: unknown;
  };
}

interface NpmPackageMetadata {
  versions?: Record<string, NpmVersionMetadata>;
}

function packageMetadataUrl(packageName: string): string {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
}

function fileNameFromTarballUrl(packageName: string, version: string, tarballUrl: string): string {
  const parsed = new URL(tarballUrl);
  const candidate = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (candidate) return candidate;
  const safeName = packageName.replace(/^@/, "").replace(/[^a-z0-9._-]+/gi, "-");
  return `${safeName}-${version}.tgz`;
}

export async function fetchNpmTarball(packageName: string, version: string): Promise<NpmTarball> {
  const metadataResponse = await fetch(packageMetadataUrl(packageName), {
    headers: { Accept: "application/json" },
  });

  if (!metadataResponse.ok) {
    throw new Error(
      `Could not read npm metadata for ${packageName}: ${metadataResponse.status} ${metadataResponse.statusText}`,
    );
  }

  const metadata = (await metadataResponse.json()) as NpmPackageMetadata;
  const versionMetadata = metadata.versions?.[version];
  const dist = versionMetadata?.dist;
  const tarballUrl = dist?.tarball;
  if (typeof tarballUrl !== "string" || tarballUrl.length === 0) {
    throw new Error(`npm metadata for ${packageName}@${version} does not include a tarball URL`);
  }

  const tarballResponse = await fetch(tarballUrl);
  if (!tarballResponse.ok) {
    throw new Error(
      `Could not download ${packageName}@${version} tarball: ${tarballResponse.status} ${tarballResponse.statusText}`,
    );
  }

  return {
    fileName: fileNameFromTarballUrl(packageName, version, tarballUrl),
    tarballUrl,
    bytes: new Uint8Array(await tarballResponse.arrayBuffer()),
    integrity: typeof dist?.integrity === "string" ? dist.integrity : undefined,
    shasum: typeof dist?.shasum === "string" ? dist.shasum : undefined,
  };
}
