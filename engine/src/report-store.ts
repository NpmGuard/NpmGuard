import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditReport } from "./models.js";
import { assessAuditReport } from "./proof-quality.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data/reports");

function assertUnderDataDir(target: string): string {
  const resolved = path.resolve(target);
  const rel = path.relative(DATA_DIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Report path escapes data directory");
  }
  return resolved;
}

function reportDir(packageName: string): string {
  return assertUnderDataDir(path.join(DATA_DIR, packageName));
}

function reportPath(packageName: string, version: string): string {
  return assertUnderDataDir(path.join(reportDir(packageName), `${version}.json`));
}

/**
 * Extract the authoritative version from an audit report by digging into
 * the inventory phase output, which reads it from the tarball's package.json.
 * Returns null if the report has no inventory phase or no metadata version.
 */
function extractReportVersion(report: unknown): string | null {
  if (!report || typeof report !== "object") return null;
  const r = report as {
    trace?: Array<{ phase?: string; output?: unknown }>;
  };
  const inventory = r.trace?.find((p) => p.phase === "inventory");
  if (!inventory?.output || typeof inventory.output !== "object") return null;
  const out = inventory.output as { metadata?: { version?: string | null } };
  const ver = out.metadata?.version;
  return typeof ver === "string" && ver.length > 0 ? ver : null;
}

/**
 * Optional observer invoked after every successful saveReport. Used by the
 * panel's verdict index (verdict-index.ts) to stay in sync without this
 * module depending on the DB — report files remain the source of truth.
 */
export type ReportSavedHook = (
  packageName: string,
  version: string,
  report: AuditReport,
) => void;

let reportSavedHook: ReportSavedHook | null = null;

/** Reclassify legacy two-state reports at the storage boundary. Historical
 * UNKNOWN/SUSPECT runs were persisted as DANGEROUS, so returning the raw field
 * would reintroduce false positives even after the four-state transport ships. */
export function normalizeReportVerdict(report: AuditReport): AuditReport {
  const classification = assessAuditReport(report).classification;
  return report.verdict === classification
    ? report
    : { ...report, verdict: classification };
}

export function setReportSavedHook(hook: ReportSavedHook | null): void {
  reportSavedHook = hook;
}

/**
 * Save a report under the package's real version. Preference order:
 *   1. Version extracted from report metadata (authoritative — read from tarball)
 *   2. Requested version passed by caller (may be "latest" or semver)
 *   3. "latest" as last resort
 * This avoids the old bug where reports were stored as `latest.json` when the
 * caller didn't pass a version, making version-specific lookups fail later.
 */
export function saveReport(
  packageName: string,
  requestedVersion: string,
  report: AuditReport,
): string {
  const normalizedReport = normalizeReportVerdict(report);
  const realVersion = extractReportVersion(normalizedReport) ?? requestedVersion ?? "latest";

  const dir = reportDir(packageName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath(packageName, realVersion), JSON.stringify(normalizedReport, null, 2));
  console.log(`[report-store] saved ${packageName}@${realVersion}`);

  try {
    reportSavedHook?.(packageName, realVersion, normalizedReport);
  } catch (err) {
    // Observer failures must never break report persistence
    console.error("[report-store] saved-hook failed:", err instanceof Error ? err.message : err);
  }

  // Backward compat: if caller passed a different version than what the
  // tarball actually contains, also clean up any stale file under the
  // legacy name so we don't serve inconsistent data from two paths.
  if (
    requestedVersion &&
    requestedVersion !== realVersion &&
    requestedVersion !== "latest"
  ) {
    const legacy = reportPath(packageName, requestedVersion);
    if (fs.existsSync(legacy)) {
      try {
        fs.unlinkSync(legacy);
        console.log(`[report-store] cleaned legacy ${packageName}@${requestedVersion}`);
      } catch {
        // non-fatal
      }
    }
  }

  return realVersion;
}

/**
 * Load a report for (packageName, version). Strategy:
 *   1. If version is provided and the exact file exists → return it
 *   2. If version is provided but not found, scan sibling files and match by
 *      metadata.version inside the report (handles legacy reports stored as
 *      `latest.json` but actually containing a specific version)
 *   3. If no version is provided, return the most recently modified report
 */
export function loadReport(
  packageName: string,
  version?: string,
): { report: AuditReport; version: string } | null {
  const dir = reportDir(packageName);
  if (!fs.existsSync(dir)) return null;

  if (version) {
    // Fast path: exact file match
    const p = reportPath(packageName, version);
    if (fs.existsSync(p)) {
      const report = JSON.parse(fs.readFileSync(p, "utf-8")) as AuditReport;
      return { report: normalizeReportVerdict(report), version };
    }

    // Slow path: scan all reports in the dir, return one whose embedded
    // metadata version matches the requested version. Useful for legacy
    // reports saved under `latest.json` before saveReport was fixed.
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const report = JSON.parse(fs.readFileSync(assertUnderDataDir(path.join(dir, file)), "utf-8"));
        const embeddedVersion = extractReportVersion(report);
        if (embeddedVersion === version) {
          return { report: normalizeReportVerdict(report), version };
        }
      } catch {
        // Skip corrupted files
      }
    }
    return null;
  }

  // No version specified — return the most recently modified report
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;

  const sorted = files
    .map((f) => ({ file: f, mtime: fs.statSync(assertUnderDataDir(path.join(dir, f))).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const latest = sorted[0]!;
  const rawReport = JSON.parse(
    fs.readFileSync(assertUnderDataDir(path.join(dir, latest.file)), "utf-8"),
  ) as AuditReport;
  const report = normalizeReportVerdict(rawReport);
  // Prefer embedded metadata version over filename (which may be "latest")
  const ver = extractReportVersion(report) ?? latest.file.replace(/\.json$/, "");
  return { report, version: ver };
}

export interface PackageSummary {
  packageName: string;
  version: string;
  verdict: string;
  reason: string;
  evidenceCount: number;
  auditedAt: string;
}

function isPublicPackageReport(packageName: string): boolean {
  return !(
    packageName.startsWith("test-pkg-") ||
    packageName.startsWith("test-package") ||
    packageName.includes("-bench-")
  );
}

export function listReports(): PackageSummary[] {
  if (!fs.existsSync(DATA_DIR)) return [];

  const results: PackageSummary[] = [];

  // Walk top-level dirs (handles scoped packages like @scope/pkg via nested dirs)
  function walkDir(dir: string, prefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        // If directory starts with @, it's a scope — recurse one level
        if (entry.name.startsWith("@")) {
          walkDir(path.join(dir, entry.name), entry.name);
        } else {
          // Package directory — find latest report
          const pkgDir = assertUnderDataDir(path.join(dir, entry.name));
          const files = fs.readdirSync(pkgDir).filter((f) => f.endsWith(".json"));
          if (files.length === 0) continue;

          const sorted = files
            .map((f) => {
              const stat = fs.statSync(assertUnderDataDir(path.join(pkgDir, f)));
              return { file: f, mtime: stat.mtimeMs, iso: stat.mtime.toISOString() };
            })
            .sort((a, b) => b.mtime - a.mtime);

          const latest = sorted[0]!;
          try {
            const report = JSON.parse(fs.readFileSync(assertUnderDataDir(path.join(pkgDir, latest.file)), "utf-8"));
            const embeddedVersion = extractReportVersion(report);
            if (!isPublicPackageReport(name)) continue;
            const assessment = assessAuditReport(report);
            results.push({
              packageName: name,
              version: embeddedVersion ?? latest.file.replace(/\.json$/, ""),
              verdict: assessment.classification,
              reason: assessment.summary,
              evidenceCount: assessment.evidence.length,
              auditedAt: latest.iso,
            });
          } catch {
            // Skip corrupted files
          }
        }
      }
    }
  }

  walkDir(DATA_DIR, "");
  // Sort by most recently audited
  results.sort((a, b) => new Date(b.auditedAt).getTime() - new Date(a.auditedAt).getTime());
  return results;
}

/**
 * Every report on disk — one entry per (package, version) file, unlike
 * listReports which returns only the latest per package. Feeds the panel's
 * verdict-index rebuild; includes test packages (the index is internal).
 */
export function listAllReports(): Array<{
  packageName: string;
  version: string;
  verdict: string;
  reason: string;
  evidenceCount: number;
  auditedAt: string;
}> {
  if (!fs.existsSync(DATA_DIR)) return [];
  const results: Array<{
    packageName: string;
    version: string;
    verdict: string;
    reason: string;
    evidenceCount: number;
    auditedAt: string;
  }> = [];

  function walkAll(dir: string, prefix: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.name.startsWith("@")) {
        walkAll(path.join(dir, entry.name), entry.name);
        continue;
      }
      const pkgDir = assertUnderDataDir(path.join(dir, entry.name));
      for (const file of fs.readdirSync(pkgDir).filter((f) => f.endsWith(".json"))) {
        try {
          const filePath = assertUnderDataDir(path.join(pkgDir, file));
          const report = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          const assessment = assessAuditReport(report);
          results.push({
            packageName: name,
            version: extractReportVersion(report) ?? file.replace(/\.json$/, ""),
            verdict: assessment.classification,
            reason: assessment.summary,
            evidenceCount: assessment.evidence.length,
            auditedAt: fs.statSync(filePath).mtime.toISOString(),
          });
        } catch {
          // Skip corrupted files
        }
      }
    }
  }

  walkAll(DATA_DIR, "");
  return results;
}
