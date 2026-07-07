import type { AuditReport } from "./models.js";
import { saveReport } from "./report-store.js";
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
): string {
  return saveReport(packageName, requestedVersion, report);
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
