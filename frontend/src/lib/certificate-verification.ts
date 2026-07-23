import {
  concatHex,
  createPublicClient,
  decodeEventLog,
  http,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import { base, baseSepolia } from "viem/chains";

const CERTIFICATE_BATCH_EVENT_ABI = [
  {
    type: "event",
    name: "CertificateBatchPublished",
    inputs: [
      { name: "batchId", type: "uint256", indexed: true },
      { name: "merkleRoot", type: "bytes32", indexed: true },
      { name: "batchURI", type: "string", indexed: false },
      { name: "policyVersion", type: "string", indexed: false },
      { name: "publisher", type: "address", indexed: true },
      { name: "createdAt", type: "uint64", indexed: false },
    ],
    anonymous: false,
  },
] as const;

interface MerkleProofStep {
  position: "left" | "right";
  hash: Hex;
}

export interface AnchoredAuditCertificate {
  schemaVersion: 1;
  certificateId: string;
  certificateHash: string;
  packageName: string;
  version: string;
  verdict: string;
  status: "valid";
  auditedAt: string;
  validUntil: string;
  policyVersion: string;
  report: {
    hash: string;
    urlPath: string;
  };
  package: unknown;
  issuer: {
    name: string;
  };
  anchor: {
    chain: "base-sepolia" | "base";
    contractAddress: Hex;
    batchId: string;
    batchURI: string;
    transactionHash: Hex;
    blockNumber: string;
    anchoredAt: string;
    merkleRoot: Hex;
    leafHash: Hex;
    merkleProof: MerkleProofStep[];
  };
}

interface CertificateBatchManifest {
  status: "pending" | "anchored";
  batchId: string | null;
  transactionHash: Hex | null;
  merkleRoot: Hex;
  entries: Array<{
    packageName: string;
    version: string;
    certificateId: string;
    certificateHash: string;
    leafHash: Hex;
  }>;
}

export interface CertificateVerificationCheck {
  id: "report" | "certificate" | "merkle" | "manifest" | "chain";
  label: string;
  detail: string;
  passed: boolean;
}

export interface CertificateVerificationResult {
  valid: boolean;
  certificate: AnchoredAuditCertificate;
  checks: CertificateVerificationCheck[];
  explorerUrl: string;
}

function canonicalizeInner(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("The report contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new Error("The report contains an unsupported bigint");
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => canonicalizeInner(item === undefined ? null : item))
      .join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalizeInner(object[key])}`)
      .join(",")}}`;
  }
  throw new Error(`Unsupported report value: ${typeof value}`);
}

export function canonicalize(value: unknown): string {
  if (value === undefined) {
    throw new Error("A top-level undefined value cannot be verified");
  }
  return canonicalizeInner(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function certificateAnchorPayload(certificate: AnchoredAuditCertificate) {
  return {
    schemaVersion: certificate.schemaVersion,
    packageName: certificate.packageName,
    version: certificate.version,
    verdict: certificate.verdict,
    status: certificate.status,
    auditedAt: certificate.auditedAt,
    validUntil: certificate.validUntil,
    policyVersion: certificate.policyVersion,
    report: certificate.report,
    package: certificate.package,
    issuer: certificate.issuer,
  };
}

function rebuildMerkleRoot(leafHash: Hex, proof: MerkleProofStep[]): Hex {
  let cursor = leafHash;
  for (const step of proof) {
    cursor =
      step.position === "left"
        ? keccak256(concatHex([step.hash, cursor]))
        : keccak256(concatHex([cursor, step.hash]));
  }
  return cursor;
}

function equalHex(left: string | null | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function packageApiPath(
  apiBase: string,
  packageName: string,
  resource: "certificate" | "report",
): string {
  return `${apiBase.replace(/\/+$/, "")}/package/${encodeURIComponent(packageName)}/${resource}`;
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${label} could not be loaded (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function verifyPackageCertificate(
  packageName: string,
  version: string,
  options: { apiBase?: string } = {},
): Promise<CertificateVerificationResult> {
  const apiBase = options.apiBase ?? "/api";
  const query = `?version=${encodeURIComponent(version)}`;
  const [certificatePayload, reportPayload] = await Promise.all([
    fetch(`${packageApiPath(apiBase, packageName, "certificate")}${query}`).then(
      (response) =>
        readJson<{ certificate: AnchoredAuditCertificate }>(
          response,
          "Certificate",
        ),
    ),
    fetch(`${packageApiPath(apiBase, packageName, "report")}${query}`).then(
      (response) => readJson<{ report: unknown }>(response, "Report"),
    ),
  ]);

  const certificate = certificatePayload.certificate;
  if (!certificate?.anchor) {
    throw new Error("This certificate has not been anchored yet");
  }
  if (certificate.packageName !== packageName || certificate.version !== version) {
    throw new Error("The certificate does not match the requested package");
  }

  const reportHash = `sha256:${await sha256Hex(canonicalize(reportPayload.report))}`;
  const reportPassed = reportHash === certificate.report.hash;

  const computedLeaf = keccak256(
    toBytes(canonicalize(certificateAnchorPayload(certificate))),
  );
  const certificatePassed = equalHex(computedLeaf, certificate.anchor.leafHash);

  const computedRoot = rebuildMerkleRoot(
    computedLeaf,
    certificate.anchor.merkleProof,
  );
  const merklePassed = equalHex(computedRoot, certificate.anchor.merkleRoot);

  const manifest = await fetch(certificate.anchor.batchURI).then((response) =>
    readJson<CertificateBatchManifest>(response, "Batch manifest"),
  );
  const manifestEntry = manifest.entries.find(
    (entry) =>
      entry.certificateId === certificate.certificateId &&
      entry.packageName === packageName &&
      entry.version === version,
  );
  const manifestPassed =
    manifest.status === "anchored" &&
    manifest.batchId === certificate.anchor.batchId &&
    equalHex(manifest.transactionHash, certificate.anchor.transactionHash) &&
    equalHex(manifest.merkleRoot, certificate.anchor.merkleRoot) &&
    !!manifestEntry &&
    manifestEntry.certificateHash === certificate.certificateHash &&
    equalHex(manifestEntry.leafHash, computedLeaf);

  const client =
    certificate.anchor.chain === "base"
      ? createPublicClient({ chain: base, transport: http() })
      : createPublicClient({ chain: baseSepolia, transport: http() });
  const receipt = await client.getTransactionReceipt({
    hash: certificate.anchor.transactionHash,
  });

  let onChainRoot: Hex | null = null;
  let onChainBatchId: string | null = null;
  let onChainBatchURI: string | null = null;
  for (const log of receipt.logs) {
    if (!equalHex(log.address, certificate.anchor.contractAddress)) continue;
    try {
      const decoded = decodeEventLog({
        abi: CERTIFICATE_BATCH_EVENT_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName !== "CertificateBatchPublished") continue;
      onChainRoot = decoded.args.merkleRoot;
      onChainBatchId = decoded.args.batchId.toString();
      onChainBatchURI = decoded.args.batchURI;
      break;
    } catch {
      // Ignore unrelated logs emitted by the same transaction.
    }
  }

  const chainPassed =
    receipt.status === "success" &&
    onChainBatchId === certificate.anchor.batchId &&
    onChainBatchURI === certificate.anchor.batchURI &&
    equalHex(onChainRoot, certificate.anchor.merkleRoot);

  const checks: CertificateVerificationCheck[] = [
    {
      id: "report",
      label: "Report integrity",
      detail: reportPassed ? "SHA-256 matches the certificate" : "Report hash mismatch",
      passed: reportPassed,
    },
    {
      id: "certificate",
      label: "Certificate leaf",
      detail: certificatePassed ? "Canonical payload matches the leaf" : "Leaf hash mismatch",
      passed: certificatePassed,
    },
    {
      id: "merkle",
      label: "Merkle path",
      detail: merklePassed
        ? `${certificate.anchor.merkleProof.length} proof steps reconstruct the root`
        : "Merkle proof does not reconstruct the root",
      passed: merklePassed,
    },
    {
      id: "manifest",
      label: `Batch #${certificate.anchor.batchId}`,
      detail: manifestPassed
        ? "Manifest entry matches the certificate"
        : "Batch manifest mismatch",
      passed: manifestPassed,
    },
    {
      id: "chain",
      label: "Base transaction",
      detail: chainPassed
        ? `Root confirmed at block ${certificate.anchor.blockNumber}`
        : "Published on-chain root does not match",
      passed: chainPassed,
    },
  ];

  const explorerUrl =
    certificate.anchor.chain === "base"
      ? `https://basescan.org/tx/${certificate.anchor.transactionHash}`
      : `https://sepolia.basescan.org/tx/${certificate.anchor.transactionHash}`;

  return {
    valid: checks.every((check) => check.passed),
    certificate,
    checks,
    explorerUrl,
  };
}
