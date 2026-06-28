import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as tar from "tar";
import type { AuditReport } from "../models.js";
import { publishEnsAuditRecord, type EnsPublishConfig, type EnsPublishResult } from "./ens.js";
import { fetchNpmTarball } from "./npm-tarball.js";
import {
  uploadBytesToPinata,
  uploadDirectoryToPinata,
  uploadJsonToPinata,
  type DirectoryFileEntry,
  type PinataNetwork,
  type PinataUploadResult,
} from "./pinata.js";

const DEFAULT_GATEWAY_HOST = "gateway.pinata.cloud";

interface StorageConfig {
  pinataJwt: string;
  pinataGatewayHost: string;
  pinataNetwork: PinataNetwork;
  ens: EnsPublishConfig | null;
}

export interface PublishAuditStorageOptions {
  packageName: string;
  version: string;
  report: AuditReport;
  tarballPath?: string;
  sourceDirectoryPath?: string;
  includeSource?: boolean;
  publishEns?: boolean;
}

export interface StorageManifest {
  schemaVersion: 1;
  packageName: string;
  version: string;
  publishedAt: string;
  audit: {
    verdict: string;
    riskScore: number;
    capabilities: string[];
    findings: number;
  };
  report: {
    cid: string;
    ipfsUri: string;
    gatewayUrl: string;
    sha256: string;
  };
  source: {
    cid: string;
    ipfsUri: string;
    gatewayUrl: string;
    sha256: string;
    pathUri: string;
    pathGatewayUrl: string;
    kind: "tarball" | "directory";
    origin: "npm" | "file" | "directory";
    files?: DirectoryFileEntry[];
    tarballUrl?: string;
    integrity?: string;
    shasum?: string;
  } | null;
}

export interface StoragePublishResult {
  packageName: string;
  version: string;
  publishedAt: string;
  report: PinataUploadResult & { sha256: string };
  source: (PinataUploadResult & {
    sha256: string;
    kind: "tarball" | "directory";
    origin: "npm" | "file" | "directory";
    tarballUrl?: string;
  }) | null;
  manifest: PinataUploadResult & { value: StorageManifest };
  ens: EnsPublishResult | null;
}

function requiredEnv(primary: string, fallback?: string): string {
  const value = process.env[primary] ?? (fallback ? process.env[fallback] : undefined);
  if (!value) {
    throw new Error(`Missing required environment variable ${fallback ? `${primary} or ${fallback}` : primary}`);
  }
  return value;
}

function readPinataNetwork(): PinataNetwork {
  const value = (process.env.NPMGUARD_PINATA_NETWORK ?? "public").toLowerCase();
  if (value !== "public" && value !== "private") {
    throw new Error("NPMGUARD_PINATA_NETWORK must be public or private");
  }
  return value;
}

function readStorageConfig(publishEns: boolean): StorageConfig {
  const pinataJwt = requiredEnv("NPMGUARD_PINATA_JWT", "PINATA_JWT");
  const pinataGatewayHost =
    process.env.NPMGUARD_PINATA_GATEWAY_HOST ??
    process.env.PINATA_GATEWAY_HOST ??
    DEFAULT_GATEWAY_HOST;
  const pinataNetwork = readPinataNetwork();

  let ens: EnsPublishConfig | null = null;
  if (publishEns) {
    const rpcUrl = process.env.NPMGUARD_ENS_RPC_URL ?? process.env.SEPOLIA_RPC_URL;
    const privateKey = process.env.NPMGUARD_ENS_PRIVATE_KEY ?? process.env.SEPOLIA_PRIVATE_KEY;
    const rootDomain =
      process.env.NPMGUARD_ENS_ROOT_DOMAIN ??
      process.env.NPMGUARD_BASE_DOMAIN ??
      "npmguard-demo.eth";

    if (rpcUrl || privateKey) {
      if (!rpcUrl) throw new Error("Missing NPMGUARD_ENS_RPC_URL or SEPOLIA_RPC_URL for ENS publish");
      if (!privateKey) throw new Error("Missing NPMGUARD_ENS_PRIVATE_KEY or SEPOLIA_PRIVATE_KEY for ENS publish");
      ens = {
        rpcUrl,
        privateKey,
        rootDomain,
        registryVersion: (process.env.NPMGUARD_ENS_REGISTRY_VERSION as EnsPublishConfig["registryVersion"]) ?? "auto",
        registryAddress: process.env.NPMGUARD_ENS_REGISTRY_ADDRESS ?? process.env.ENS_REGISTRY_ADDRESS,
        nameWrapperAddress: process.env.NPMGUARD_ENS_NAME_WRAPPER_ADDRESS ?? process.env.ENS_NAME_WRAPPER_ADDRESS,
        publicResolverAddress: process.env.NPMGUARD_ENS_PUBLIC_RESOLVER_ADDRESS ?? process.env.ENS_PUBLIC_RESOLVER_ADDRESS,
        universalResolverAddress:
          process.env.NPMGUARD_ENS_UNIVERSAL_RESOLVER_ADDRESS ??
          process.env.ENS_UNIVERSAL_RESOLVER_ADDRESS,
        v2RegistryAddress: process.env.NPMGUARD_ENS_V2_REGISTRY_ADDRESS ?? process.env.ENS_V2_REGISTRY_ADDRESS,
      };
    }
  }

  return { pinataJwt, pinataGatewayHost, pinataNetwork, ens };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactStem(packageName: string, version: string): string {
  const safePackage = packageName.replace(/^@/, "").replace(/[^a-z0-9._-]+/gi, "-");
  const safeVersion = version.replace(/[^a-z0-9._-]+/gi, "-");
  return `${safePackage}-${safeVersion}`;
}

function riskScore(report: AuditReport): number {
  return report.triage?.riskScore ?? 0;
}

async function withTempExtractedTarball<T>(
  tarballBytes: Uint8Array,
  callback: (directoryPath: string) => Promise<T>,
): Promise<T> {
  const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "npmguard-source-"));
  const tarballPath = path.join(tmpdir, "package.tgz");
  const extractedPath = path.join(tmpdir, "extracted");
  try {
    await fs.writeFile(tarballPath, tarballBytes);
    await fs.mkdir(extractedPath, { recursive: true });
    await tar.x({ file: tarballPath, cwd: extractedPath, strip: 1 });
    return await callback(extractedPath);
  } finally {
    await fs.rm(tmpdir, { recursive: true, force: true });
  }
}

export async function publishAuditStorage(
  options: PublishAuditStorageOptions,
): Promise<StoragePublishResult> {
  const publishEns = options.publishEns ?? true;
  const config = readStorageConfig(publishEns);
  const publishedAt = new Date().toISOString();
  const stem = artifactStem(options.packageName, options.version);

  const reportBytes = Buffer.from(JSON.stringify(options.report, null, 2));
  const reportUpload = await uploadBytesToPinata({
    jwt: config.pinataJwt,
    gatewayHost: config.pinataGatewayHost,
    network: config.pinataNetwork,
    bytes: reportBytes,
    name: `${stem}-audit-report.json`,
    mimeType: "application/json",
  });
  const reportHash = sha256(reportBytes);

  let sourceUpload: StoragePublishResult["source"] = null;
  let manifestSource: StorageManifest["source"] = null;
  if (options.includeSource ?? true) {
    if (options.sourceDirectoryPath) {
      const directoryUpload = await uploadDirectoryToPinata({
        jwt: config.pinataJwt,
        gatewayHost: config.pinataGatewayHost,
        directoryPath: options.sourceDirectoryPath,
        name: `${stem}-source-folder`,
      });
      sourceUpload = {
        ...directoryUpload,
        sha256: "",
        kind: "directory",
        origin: "directory",
      };
      manifestSource = {
        cid: directoryUpload.cid,
        ipfsUri: directoryUpload.ipfsUri,
        gatewayUrl: directoryUpload.gatewayUrl,
        sha256: "",
        pathUri: `${directoryUpload.ipfsUri}/`,
        pathGatewayUrl: `${directoryUpload.gatewayUrl}/`,
        kind: "directory",
        origin: "directory",
        files: directoryUpload.files,
      };
    } else if (options.tarballPath) {
      const bytes = await fs.readFile(options.tarballPath);
      const tarballHash = sha256(bytes);
      const directoryUpload = await withTempExtractedTarball(bytes, (directoryPath) =>
        uploadDirectoryToPinata({
          jwt: config.pinataJwt,
          gatewayHost: config.pinataGatewayHost,
          directoryPath,
          name: `${stem}-source-folder`,
        }),
      );
      sourceUpload = {
        ...directoryUpload,
        sha256: tarballHash,
        kind: "directory",
        origin: "file",
      };
      manifestSource = {
        cid: directoryUpload.cid,
        ipfsUri: directoryUpload.ipfsUri,
        gatewayUrl: directoryUpload.gatewayUrl,
        sha256: tarballHash,
        pathUri: `${directoryUpload.ipfsUri}/`,
        pathGatewayUrl: `${directoryUpload.gatewayUrl}/`,
        kind: "directory",
        origin: "file",
        files: directoryUpload.files,
      };
    } else {
      const tarball = await fetchNpmTarball(options.packageName, options.version);
      const tarballHash = sha256(tarball.bytes);
      const directoryUpload = await withTempExtractedTarball(tarball.bytes, (directoryPath) =>
        uploadDirectoryToPinata({
          jwt: config.pinataJwt,
          gatewayHost: config.pinataGatewayHost,
          directoryPath,
          name: `${stem}-source-folder`,
        }),
      );
      sourceUpload = {
        ...directoryUpload,
        sha256: tarballHash,
        kind: "directory",
        origin: "npm",
        tarballUrl: tarball.tarballUrl,
      };
      manifestSource = {
        cid: directoryUpload.cid,
        ipfsUri: directoryUpload.ipfsUri,
        gatewayUrl: directoryUpload.gatewayUrl,
        sha256: tarballHash,
        pathUri: `${directoryUpload.ipfsUri}/`,
        pathGatewayUrl: `${directoryUpload.gatewayUrl}/`,
        kind: "directory",
        origin: "npm",
        files: directoryUpload.files,
        tarballUrl: tarball.tarballUrl,
        integrity: tarball.integrity,
        shasum: tarball.shasum,
      };
    }
  }

  const manifestValue: StorageManifest = {
    schemaVersion: 1,
    packageName: options.packageName,
    version: options.version,
    publishedAt,
    audit: {
      verdict: options.report.verdict,
      riskScore: riskScore(options.report),
      capabilities: options.report.capabilities,
      findings: options.report.findings.length,
    },
    report: {
      cid: reportUpload.cid,
      ipfsUri: reportUpload.ipfsUri,
      gatewayUrl: reportUpload.gatewayUrl,
      sha256: reportHash,
    },
    source: manifestSource,
  };

  const manifestUpload = await uploadJsonToPinata({
    jwt: config.pinataJwt,
    gatewayHost: config.pinataGatewayHost,
    network: config.pinataNetwork,
    name: `${stem}-storage-manifest.json`,
    value: manifestValue,
  });

  const ens = config.ens
    ? await publishEnsAuditRecord(config.ens, {
      packageName: options.packageName,
      version: options.version,
      verdict: options.report.verdict,
      riskScore: riskScore(options.report),
      capabilities: options.report.capabilities,
      publishedAt,
      reportCid: reportUpload.cid,
      reportUri: reportUpload.gatewayUrl,
      sourceCid: sourceUpload?.cid,
      sourceUri: sourceUpload?.ipfsUri,
      sourcePath: manifestSource?.pathUri,
      fileIndexCid: manifestUpload.cid,
      fileIndexUri: manifestUpload.gatewayUrl,
      manifestCid: manifestUpload.cid,
      manifestUri: manifestUpload.gatewayUrl,
    })
    : null;

  return {
    packageName: options.packageName,
    version: options.version,
    publishedAt,
    report: { ...reportUpload, sha256: reportHash },
    source: sourceUpload,
    manifest: { ...manifestUpload, value: manifestValue },
    ens,
  };
}
