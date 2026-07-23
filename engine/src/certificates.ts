import type { AuditReport } from "./models.js";
import { contentHashOf } from "./evidence/hashing.js";

export interface PackageVersionProof {
  registry: "npm";
  resolvedVersion: string;
  tarballUrl: string;
  integrity: string | null;
  shasum: string | null;
  tarballSha256: string;
}

export interface AuditCertificate {
  schemaVersion: 1;
  certificateId: string;
  certificateHash: string;
  packageName: string;
  version: string;
  verdict: AuditReport["verdict"];
  status: "valid";
  auditedAt: string;
  validUntil: string;
  policyVersion: string;
  report: {
    hash: string;
    urlPath: string;
  };
  package: PackageVersionProof | null;
  issuer: {
    name: "NpmGuard";
  };
  anchor?: CertificateAnchor;
}

export interface MerkleProofStep {
  position: "left" | "right";
  hash: `0x${string}`;
}

export interface CertificateAnchor {
  chain: "base-sepolia" | "base";
  contractAddress: `0x${string}`;
  batchId: string;
  batchURI: string;
  transactionHash: `0x${string}`;
  blockNumber: string;
  anchoredAt: string;
  merkleRoot: `0x${string}`;
  leafHash: `0x${string}`;
  merkleProof: MerkleProofStep[];
}

const DEFAULT_VALIDITY_DAYS = 90;
const DEFAULT_POLICY_VERSION = "npmguard-audit-v1";

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function reportUrlPath(packageName: string, version: string): string {
  return `/package/${encodeURIComponent(packageName)}/report?version=${encodeURIComponent(version)}`;
}

function isPackageVersionProof(value: unknown): value is PackageVersionProof {
  if (!value || typeof value !== "object") return false;
  const proof = value as Partial<PackageVersionProof>;
  return (
    proof.registry === "npm" &&
    typeof proof.resolvedVersion === "string" &&
    typeof proof.tarballUrl === "string" &&
    (typeof proof.integrity === "string" || proof.integrity === null) &&
    (typeof proof.shasum === "string" || proof.shasum === null) &&
    typeof proof.tarballSha256 === "string"
  );
}

export function extractPackageProof(report: AuditReport): PackageVersionProof | null {
  const resolvePhase = report.trace.find((phase) => phase.phase === "resolve");
  const output = resolvePhase?.output;
  if (!output || typeof output !== "object") return null;
  const proof = (output as { packageProof?: unknown }).packageProof;
  return isPackageVersionProof(proof) ? proof : null;
}

export function buildAuditCertificate(options: {
  packageName: string;
  version: string;
  report: AuditReport;
  auditedAt?: Date;
  validityDays?: number;
  policyVersion?: string;
}): AuditCertificate {
  const auditedAt = options.auditedAt ?? new Date();
  const validityDays = options.validityDays ?? DEFAULT_VALIDITY_DAYS;
  const policyVersion = options.policyVersion ?? DEFAULT_POLICY_VERSION;

  const unsigned = {
    schemaVersion: 1 as const,
    packageName: options.packageName,
    version: options.version,
    verdict: options.report.verdict,
    status: "valid" as const,
    auditedAt: auditedAt.toISOString(),
    validUntil: addDays(auditedAt, validityDays).toISOString(),
    policyVersion,
    report: {
      hash: `sha256:${contentHashOf(options.report)}`,
      urlPath: reportUrlPath(options.packageName, options.version),
    },
    package: extractPackageProof(options.report),
    issuer: {
      name: "NpmGuard" as const,
    },
  };

  const hash = contentHashOf(unsigned);
  return {
    ...unsigned,
    certificateHash: `sha256:${hash}`,
    certificateId: `npmguard:v1:${hash}`,
  };
}

export function certificateAnchorPayload(certificate: AuditCertificate) {
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
