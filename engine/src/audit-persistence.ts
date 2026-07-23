import type { AuditReport } from "./models.js";
import { anchorCertificateAfterAudit } from "./certificate-anchor.js";
import { buildAuditCertificate, type AuditCertificate } from "./certificates.js";
import { loadCertificate, saveCertificate } from "./certificate-store.js";
import { loadReport, saveReport } from "./report-store.js";
import { saveStoragePublication } from "./storage-store.js";
import { publishAuditStorage } from "./storage/publisher.js";

function storagePublishEnabled(): boolean {
  const flag = (process.env.NPMGUARD_STORAGE_PUBLISH ?? "auto").toLowerCase();
  if (flag === "false" || flag === "0" || flag === "off") return false;
  return !!(process.env.NPMGUARD_PINATA_JWT || process.env.PINATA_JWT);
}

export function persistAuditReport(
  packageName: string,
  requestedVersion: string,
  report: AuditReport,
  options: { anchor?: boolean } = {},
): string {
  const realVersion = saveReport(packageName, requestedVersion, report);
  const certificate = ensureAuditCertificate(packageName, realVersion);
  if (certificate && options.anchor !== false) {
    anchorCertificateAfterAudit(certificate);
  }
  return realVersion;
}

export function ensureAuditCertificate(
  packageName: string,
  version: string,
): AuditCertificate | null {
  const persisted = loadReport(packageName, version);
  if (!persisted) return null;

  const candidate = buildAuditCertificate({
    packageName,
    version: persisted.version,
    report: persisted.report,
  });
  const existing = loadCertificate(packageName, persisted.version);
  if (existing?.report.hash === candidate.report.hash) return existing;

  saveCertificate(candidate);
  return candidate;
}

export function publishStorageArtifactsAfterAudit(options: {
  packageName: string;
  version: string;
  report: AuditReport;
  packagePath?: string;
  cleanup: () => void;
}): void {
  if (!storagePublishEnabled()) {
    options.cleanup();
    return;
  }

  publishAuditStorage({
    packageName: options.packageName,
    version: options.version,
    report: options.report,
    sourceDirectoryPath: options.packageName.startsWith("test-pkg-") ? options.packagePath : undefined,
    includeSource: true,
    publishEns: true,
  })
    .then((result) => {
      saveStoragePublication(result);
      console.log(
        `[storage] published ${result.packageName}@${result.version}` +
          (result.ens ? ` via ENS ${result.ens.recordName}` : ""),
      );
    })
    .catch((err) => {
      console.warn(`[storage] publish failed: ${err instanceof Error ? err.message : err}`);
    })
    .finally(() => {
      options.cleanup();
    });
}
