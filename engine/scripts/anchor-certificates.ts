import "dotenv/config";
import type { SupportedChain } from "../src/chain.js";
import {
  anchorCertificateBatch,
  certificatePublicBaseUrl,
  DEFAULT_CERTIFICATE_POLICY_VERSION,
  prepareCertificateBatch,
} from "../src/certificate-anchor.js";
import { listUnanchoredCertificates } from "../src/certificate-store.js";
import { ensureAuditCertificate } from "../src/audit-persistence.js";
import {
  isPublicPackageReport,
  listAllReports,
} from "../src/report-store.js";

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function readChain(): SupportedChain {
  const value =
    readFlag("--chain") ??
    process.env.NPMGUARD_CERTIFICATE_CHAIN ??
    "base-sepolia";
  if (value !== "base-sepolia" && value !== "base") {
    throw new Error("--chain must be base-sepolia or base");
  }
  return value;
}

function readLimit(): number | null {
  const value = readFlag("--limit");
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive integer");
  }
  return parsed;
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(
      "Usage: npm run certificates:anchor -- [--chain base-sepolia] [--limit 100] [--apply]",
    );
    return;
  }

  const apply = hasFlag("--apply");
  const chain = readChain();
  const limit = readLimit();
  const policyVersion =
    readFlag("--policy-version") ??
    process.env.NPMGUARD_CERTIFICATE_POLICY_VERSION ??
    DEFAULT_CERTIFICATE_POLICY_VERSION;

  if (apply) {
    let certificatesReady = 0;
    for (const report of listAllReports()) {
      if (
        isPublicPackageReport(report.packageName) &&
        ensureAuditCertificate(report.packageName, report.version)
      ) {
        certificatesReady += 1;
      }
    }
    console.log(
      `[certificate-anchor] prepared certificates for ${certificatesReady} persisted report(s)`,
    );
  }

  const all = listUnanchoredCertificates();
  const selected = limit ? all.slice(0, limit) : all;

  if (selected.length === 0) {
    console.log("No unanchored certificates found.");
    return;
  }

  const now = new Date();
  const publicBaseUrl = certificatePublicBaseUrl();
  const prepared = prepareCertificateBatch(selected, {
    chain,
    policyVersion,
    publicBaseUrl,
    now,
  });

  console.log(`${apply ? "Anchoring" : "Dry-run:"} ${selected.length} certificate(s)`);
  console.log(`- chain: ${chain}`);
  console.log(`- contract: ${prepared.contractAddress}`);
  console.log(`- merkleRoot: ${prepared.merkleRoot}`);
  console.log(`- batchURI: ${prepared.batchURI}`);

  if (!apply) {
    console.log("Run again with --apply to publish this root on-chain.");
    return;
  }

  const result = await anchorCertificateBatch({
    certificates: selected,
    chain,
    policyVersion,
    publicBaseUrl,
    now,
    batchKey: prepared.manifest.batchKey,
  });

  console.log(
    `[certificate-anchor] published batch ${result.published.batchId} in ${result.published.transactionHash}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
