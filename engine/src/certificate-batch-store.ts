import * as fs from "node:fs";
import * as path from "node:path";
import type { MerkleProofStep } from "./certificates.js";

const DATA_DIR = path.resolve(
  import.meta.dirname,
  "../../data/certificate-batches",
);

export interface CertificateBatchManifestEntry {
  packageName: string;
  version: string;
  certificateId: string;
  certificateHash: string;
  certificateUrlPath: string;
  leafHash: `0x${string}`;
  merkleProof: MerkleProofStep[];
}

export interface CertificateBatchManifest {
  schemaVersion: 1;
  batchKey: string;
  status: "pending" | "anchored";
  chain: "base-sepolia" | "base";
  contractAddress: `0x${string}`;
  batchId: string | null;
  transactionHash: `0x${string}` | null;
  blockNumber: string | null;
  createdAt: string;
  anchoredAt: string | null;
  merkleRoot: `0x${string}`;
  policyVersion: string;
  batchURI: string;
  entries: CertificateBatchManifestEntry[];
}

function assertUnderDataDir(target: string): string {
  const resolved = path.resolve(target);
  const rel = path.relative(DATA_DIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Certificate batch path escapes data directory");
  }
  return resolved;
}

function assertBatchKey(batchKey: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(batchKey)) {
    throw new Error("Invalid certificate batch key");
  }
  return batchKey;
}

function batchPath(batchKey: string): string {
  return assertUnderDataDir(
    path.join(DATA_DIR, `${assertBatchKey(batchKey)}.json`),
  );
}

export function saveCertificateBatchManifest(
  manifest: CertificateBatchManifest,
): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    batchPath(manifest.batchKey),
    JSON.stringify(manifest, null, 2),
  );
  console.log(`[certificate-batch-store] saved ${manifest.batchKey}`);
}

export function loadCertificateBatchManifest(
  batchKey: string,
): CertificateBatchManifest | null {
  const file = batchPath(batchKey);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8")) as CertificateBatchManifest;
}
