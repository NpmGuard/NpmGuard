import { createPublicClient, http, parseAbi, toHex, zeroAddress } from "viem";
import { sepolia } from "viem/chains";
import { namehash, packetToBytes } from "viem/ens";
import * as api from "./api.js";

export type InstallSource = "npm" | "pinata" | "ens";

const DEFAULT_ENS_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
const DEFAULT_ENS_ROOT_DOMAIN = "npmguard-demo.eth";
const UNIVERSAL_RESOLVER = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";

const universalResolverAbi = parseAbi([
  "function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)",
]);

const resolverAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
]);

export interface InstallSourceOptions {
  source: InstallSource;
  apiUrl: string;
  ensRootDomain: string;
  ensRpcUrl: string;
}

export function normalizeInstallSource(value: string | undefined): InstallSource {
  const source = (value ?? "npm").toLowerCase();
  if (source === "npm" || source === "pinata" || source === "ens") return source;
  throw new Error(`Invalid install source "${value}". Expected npm, pinata, or ens.`);
}

export function defaultEnsRootDomain(): string {
  return process.env.NPMGUARD_ENS_ROOT_DOMAIN ?? DEFAULT_ENS_ROOT_DOMAIN;
}

export function defaultEnsRpcUrl(): string {
  return process.env.NPMGUARD_ENS_RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? DEFAULT_ENS_RPC_URL;
}

function ensSafeLabel(value: string): string {
  const label = value
    .replace(/^@/, "")
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  if (!label) throw new Error(`Cannot derive an ENS label from "${value}"`);
  return label.slice(0, 63);
}

function tarballFromStorage(storage: api.StoragePublication): string | null {
  return (
    storage.storage.tarball?.gatewayUrl ??
    storage.storage.manifest?.value?.tarball?.gatewayUrl ??
    null
  );
}

export async function resolvePinataInstallSpec(
  apiUrl: string,
  packageName: string,
  version: string,
): Promise<{ spec: string; detail: string }> {
  const publication = await api.getPackageStorage(apiUrl, packageName, version);
  if (!publication) {
    throw new Error(`No Pinata publication found for ${packageName}@${version}`);
  }

  const tarballUrl = tarballFromStorage(publication);
  if (!tarballUrl) {
    throw new Error(`Pinata publication for ${packageName}@${version} has no installable tarball URL`);
  }

  return {
    spec: tarballUrl,
    detail: publication.storage.ens?.recordName
      ? `Pinata tarball announced by ${publication.storage.ens.recordName}`
      : "Pinata tarball from NpmGuard storage API",
  };
}

async function readTextRecords(
  name: string,
  keys: string[],
  rpcUrl: string,
): Promise<Record<string, string>> {
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const found = await client.readContract({
    address: UNIVERSAL_RESOLVER,
    abi: universalResolverAbi,
    functionName: "findResolver",
    args: [toHex(packetToBytes(name))],
  }) as { resolver?: `0x${string}`; 0?: `0x${string}` };

  const resolver = found.resolver ?? found[0] ?? zeroAddress;
  if (!resolver || resolver === zeroAddress) return {};

  const node = namehash(name);
  const records: Record<string, string> = {};
  for (const key of keys) {
    try {
      const value = await client.readContract({
        address: resolver,
        abi: resolverAbi,
        functionName: "text",
        args: [node, key],
      }) as string;
      if (value) records[key] = value;
    } catch {
      // Some resolvers throw for missing keys; treat that as an empty record.
    }
  }
  return records;
}

async function tarballFromManifest(manifestUrl: string): Promise<string | null> {
  const res = await fetch(manifestUrl);
  if (!res.ok) return null;
  const manifest = await res.json() as { tarball?: { gatewayUrl?: string } | null };
  return manifest.tarball?.gatewayUrl ?? null;
}

export async function resolveEnsInstallSpec(options: {
  packageName: string;
  version: string;
  rootDomain: string;
  rpcUrl: string;
}): Promise<{ spec: string; detail: string }> {
  const packageLabel = ensSafeLabel(options.packageName);
  const versionLabel = ensSafeLabel(options.version || "latest");
  const root = options.rootDomain.replace(/\.+$/, "");
  const candidates = [
    `${versionLabel}.${packageLabel}.${root}`,
    `${packageLabel}.${root}`,
    root,
  ];
  const keys = [
    "npmguard.tarball_uri",
    "npmguard.latest_tarball_uri",
    "npmguard.manifest_uri",
    "npmguard.latest_manifest_uri",
    "npmguard.package",
    "npmguard.version",
    "npmguard.latest_version",
  ];

  for (const name of candidates) {
    const records = await readTextRecords(name, keys, options.rpcUrl);
    const recordPackage = records["npmguard.package"];
    const recordVersion = records["npmguard.version"] ?? records["npmguard.latest_version"];
    const packageMatches = !recordPackage || recordPackage === options.packageName;
    const versionMatches = !recordVersion || recordVersion === options.version;
    if (!packageMatches || !versionMatches) continue;

    const directTarball = records["npmguard.tarball_uri"] ?? records["npmguard.latest_tarball_uri"];
    if (directTarball) return { spec: directTarball, detail: `ENS ${name} → Pinata tarball` };

    const manifestUrl = records["npmguard.manifest_uri"] ?? records["npmguard.latest_manifest_uri"];
    if (manifestUrl) {
      const tarballUrl = await tarballFromManifest(manifestUrl);
      if (tarballUrl) return { spec: tarballUrl, detail: `ENS ${name} → manifest → Pinata tarball` };
    }
  }

  throw new Error(`No installable ENS tarball record found for ${options.packageName}@${options.version}`);
}
