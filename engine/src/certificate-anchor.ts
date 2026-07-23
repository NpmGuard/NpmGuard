import type { Hex } from "viem";
import type { SupportedChain } from "./chain.js";
import {
  getCertificateRegistryAddress,
  publishCertificateBatchRoot,
  type PublishedCertificateBatch,
} from "./certificate-anchor-chain.js";
import {
  saveCertificateBatchManifest,
  type CertificateBatchManifest,
} from "./certificate-batch-store.js";
import { buildCertificateMerkleBatch } from "./certificate-merkle.js";
import {
  listUnanchoredCertificates,
  saveCertificate,
} from "./certificate-store.js";
import type { AuditCertificate } from "./certificates.js";

export const DEFAULT_CERTIFICATE_POLICY_VERSION = "npmguard-audit-v1";

export type CertificateAnchorMode = "manual" | "immediate" | "off";

export interface PreparedCertificateBatch {
  manifest: CertificateBatchManifest;
  merkleRoot: Hex;
  batchURI: string;
  contractAddress: `0x${string}`;
}

export interface AnchorCertificateBatchOptions {
  certificates: AuditCertificate[];
  chain?: SupportedChain;
  policyVersion?: string;
  publicBaseUrl?: string;
  now?: Date;
  batchKey?: string;
  getRegistryAddress?: (chain: SupportedChain) => `0x${string}`;
  publishRoot?: typeof publishCertificateBatchRoot;
  saveManifest?: typeof saveCertificateBatchManifest;
  saveAnchoredCertificate?: typeof saveCertificate;
}

export interface AnchorCertificateBatchResult {
  manifest: CertificateBatchManifest;
  published: PublishedCertificateBatch;
  certificates: AuditCertificate[];
}

export function readCertificateAnchorMode(): CertificateAnchorMode {
  const raw = (
    process.env.NPMGUARD_CERTIFICATE_ANCHOR_MODE ?? "manual"
  ).toLowerCase();
  if (raw === "immediate" || raw === "auto" || raw === "true" || raw === "1") {
    return "immediate";
  }
  if (raw === "off" || raw === "false" || raw === "0") return "off";
  if (raw === "manual" || raw === "batch") return "manual";
  console.warn(
    `[certificate-anchor] unknown NPMGUARD_CERTIFICATE_ANCHOR_MODE=${raw}; using manual`,
  );
  return "manual";
}

export function readCertificateAnchorChain(): SupportedChain {
  const value =
    process.env.NPMGUARD_CERTIFICATE_CHAIN ?? "base-sepolia";
  if (value !== "base-sepolia" && value !== "base") {
    throw new Error(
      "NPMGUARD_CERTIFICATE_CHAIN must be base-sepolia or base",
    );
  }
  return value;
}

export function certificatePublicBaseUrl(): string {
  return (
    process.env.NPMGUARD_PUBLIC_BASE_URL ?? "https://npmguard.com"
  ).replace(/\/+$/, "");
}

function certificateUrlPath(packageName: string, version: string): string {
  return `/package/${encodeURIComponent(packageName)}/certificate?version=${encodeURIComponent(version)}`;
}

function makeBatchKey(now: Date, merkleRoot: Hex): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return `batch-${timestamp}-${merkleRoot.slice(2, 10)}`;
}

export function prepareCertificateBatch(
  certificates: AuditCertificate[],
  options: Omit<
    AnchorCertificateBatchOptions,
    "certificates" | "publishRoot" | "saveManifest" | "saveAnchoredCertificate"
  > = {},
): PreparedCertificateBatch {
  if (certificates.length === 0) {
    throw new Error("Cannot anchor an empty certificate batch");
  }

  const chain = options.chain ?? readCertificateAnchorChain();
  const policyVersion =
    options.policyVersion ??
    process.env.NPMGUARD_CERTIFICATE_POLICY_VERSION ??
    DEFAULT_CERTIFICATE_POLICY_VERSION;
  const now = options.now ?? new Date();
  const publicBaseUrl = (
    options.publicBaseUrl ?? certificatePublicBaseUrl()
  ).replace(/\/+$/, "");
  const getRegistryAddress =
    options.getRegistryAddress ?? getCertificateRegistryAddress;
  const contractAddress = getRegistryAddress(chain);
  const merkle = buildCertificateMerkleBatch(certificates);
  const batchKey =
    options.batchKey ?? makeBatchKey(now, merkle.merkleRoot);
  const batchURI = `${publicBaseUrl}/certificate-batches/${batchKey}.json`;

  return {
    merkleRoot: merkle.merkleRoot,
    batchURI,
    contractAddress,
    manifest: {
      schemaVersion: 1,
      batchKey,
      status: "pending",
      chain,
      contractAddress,
      batchId: null,
      transactionHash: null,
      blockNumber: null,
      createdAt: now.toISOString(),
      anchoredAt: null,
      merkleRoot: merkle.merkleRoot,
      policyVersion,
      batchURI,
      entries: merkle.entries.map((entry) => ({
        packageName: entry.certificate.packageName,
        version: entry.certificate.version,
        certificateId: entry.certificate.certificateId,
        certificateHash: entry.certificate.certificateHash,
        certificateUrlPath: certificateUrlPath(
          entry.certificate.packageName,
          entry.certificate.version,
        ),
        leafHash: entry.leafHash,
        merkleProof: entry.proof,
      })),
    },
  };
}

export async function anchorCertificateBatch(
  options: AnchorCertificateBatchOptions,
): Promise<AnchorCertificateBatchResult> {
  const prepared = prepareCertificateBatch(options.certificates, options);
  const saveManifest =
    options.saveManifest ?? saveCertificateBatchManifest;
  const publishRoot = options.publishRoot ?? publishCertificateBatchRoot;
  const saveAnchoredCertificate =
    options.saveAnchoredCertificate ?? saveCertificate;

  saveManifest(prepared.manifest);

  const published = await publishRoot({
    chain: prepared.manifest.chain,
    merkleRoot: prepared.merkleRoot,
    batchURI: prepared.batchURI,
    policyVersion: prepared.manifest.policyVersion,
  });

  const anchoredAt = new Date().toISOString();
  const anchoredManifest: CertificateBatchManifest = {
    ...prepared.manifest,
    status: "anchored",
    batchId: published.batchId,
    transactionHash: published.transactionHash,
    blockNumber: published.blockNumber,
    anchoredAt,
  };
  saveManifest(anchoredManifest);

  const anchoredCertificates = options.certificates.map(
    (certificate, index) => {
      const entry = prepared.manifest.entries[index]!;
      const anchoredCertificate: AuditCertificate = {
        ...certificate,
        anchor: {
          chain: prepared.manifest.chain,
          contractAddress: prepared.contractAddress,
          batchId: published.batchId,
          batchURI: prepared.batchURI,
          transactionHash: published.transactionHash,
          blockNumber: published.blockNumber,
          anchoredAt,
          merkleRoot: prepared.merkleRoot,
          leafHash: entry.leafHash,
          merkleProof: entry.merkleProof,
        },
      };
      saveAnchoredCertificate(anchoredCertificate);
      return anchoredCertificate;
    },
  );

  return {
    manifest: anchoredManifest,
    published,
    certificates: anchoredCertificates,
  };
}

export function anchorCertificateAfterAudit(
  certificate: AuditCertificate,
): void {
  if (readCertificateAnchorMode() !== "immediate") return;

  const label = `${certificate.packageName}@${certificate.version}`;
  anchorCertificateBatch({ certificates: [certificate] })
    .then((result) => {
      console.log(
        `[certificate-anchor] anchored ${label} in batch ${result.published.batchId} (${result.published.transactionHash})`,
      );
    })
    .catch((err) => {
      console.warn(
        `[certificate-anchor] immediate anchor failed for ${label}: ${err instanceof Error ? err.message : err}`,
      );
    });
}

let backgroundBatchRunning = false;
let backgroundBatchRequested = false;

/**
 * Background repository audits persist certificates without publishing one
 * transaction per dependency. Call this once a scan finishes to anchor every
 * pending certificate in a single Merkle batch.
 */
export function anchorPendingCertificatesAfterScan(): void {
  if (readCertificateAnchorMode() !== "immediate") return;

  backgroundBatchRequested = true;
  if (backgroundBatchRunning) return;
  backgroundBatchRunning = true;

  void (async () => {
    try {
      while (backgroundBatchRequested) {
        backgroundBatchRequested = false;
        const certificates = listUnanchoredCertificates();
        if (certificates.length === 0) continue;

        const result = await anchorCertificateBatch({ certificates });
        console.log(
          `[certificate-anchor] anchored ${certificates.length} repository-audit certificate(s) in batch ${result.published.batchId} (${result.published.transactionHash})`,
        );
      }
    } catch (err) {
      console.warn(
        `[certificate-anchor] repository batch failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      backgroundBatchRunning = false;
    }
  })();
}
