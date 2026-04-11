import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditReport } from "./models.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data/reports");

function reportDir(packageName: string): string {
  return path.join(DATA_DIR, packageName);
}

function reportPath(packageName: string, version: string): string {
  return path.join(reportDir(packageName), `${version}.json`);
}

export function saveReport(packageName: string, version: string, report: AuditReport): void {
  const dir = reportDir(packageName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath(packageName, version), JSON.stringify(report, null, 2));
  console.log(`[report-store] saved ${packageName}@${version}`);
}

export function loadReport(packageName: string, version?: string): { report: AuditReport; version: string } | null {
  if (version) {
    const p = reportPath(packageName, version);
    if (!fs.existsSync(p)) return null;
    return { report: JSON.parse(fs.readFileSync(p, "utf-8")), version };
  }

  // No version specified — return most recently modified
  const dir = reportDir(packageName);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;

  // Sort by mtime descending
  const sorted = files
    .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const latest = sorted[0];
  const ver = latest.file.replace(/\.json$/, "");
  return { report: JSON.parse(fs.readFileSync(path.join(dir, latest.file), "utf-8")), version: ver };
}

export interface PackageSummary {
  packageName: string;
  version: string;
  verdict: string;
  auditedAt: string;
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
          const pkgDir = path.join(dir, entry.name);
          const files = fs.readdirSync(pkgDir).filter((f) => f.endsWith(".json"));
          if (files.length === 0) continue;

          const sorted = files
            .map((f) => {
              const stat = fs.statSync(path.join(pkgDir, f));
              return { file: f, mtime: stat.mtimeMs, iso: stat.mtime.toISOString() };
            })
            .sort((a, b) => b.mtime - a.mtime);

          const latest = sorted[0];
          try {
            const report = JSON.parse(fs.readFileSync(path.join(pkgDir, latest.file), "utf-8"));
            results.push({
              packageName: name,
              version: latest.file.replace(/\.json$/, ""),
              verdict: report.verdict ?? "UNKNOWN",
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
