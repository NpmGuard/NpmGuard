import * as fs from "node:fs";
import * as path from "node:path";
import type { AuditCertificate } from "./certificates.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data/certificates");

function assertUnderDataDir(target: string): string {
  const resolved = path.resolve(target);
  const rel = path.relative(DATA_DIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Certificate path escapes data directory");
  }
  return resolved;
}

function certificateDir(packageName: string): string {
  return assertUnderDataDir(path.join(DATA_DIR, packageName));
}

function certificatePath(packageName: string, version: string): string {
  return assertUnderDataDir(path.join(certificateDir(packageName), `${version}.json`));
}

function certificateHistoryPath(packageName: string, version: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return assertUnderDataDir(
    path.join(certificateDir(packageName), ".history", version, `${timestamp}.json`),
  );
}

function archiveExistingCertificate(packageName: string, version: string): void {
  const current = certificatePath(packageName, version);
  if (!fs.existsSync(current)) return;

  const archived = certificateHistoryPath(packageName, version);
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.copyFileSync(current, archived);
}

export function saveCertificate(certificate: AuditCertificate): void {
  const dir = certificateDir(certificate.packageName);
  fs.mkdirSync(dir, { recursive: true });
  archiveExistingCertificate(certificate.packageName, certificate.version);
  fs.writeFileSync(
    certificatePath(certificate.packageName, certificate.version),
    JSON.stringify(certificate, null, 2),
  );
  console.log(`[certificate-store] saved ${certificate.packageName}@${certificate.version}`);
}

export function loadCertificate(
  packageName: string,
  version: string,
): AuditCertificate | null {
  const file = certificatePath(packageName, version);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8")) as AuditCertificate;
}

export function listCertificates(): AuditCertificate[] {
  if (!fs.existsSync(DATA_DIR)) return [];

  const certificates: AuditCertificate[] = [];

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = assertUnderDataDir(path.join(dir, entry.name));
      if (entry.isDirectory()) {
        if (entry.name === ".history") continue;
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        certificates.push(
          JSON.parse(fs.readFileSync(fullPath, "utf-8")) as AuditCertificate,
        );
      } catch {
        // Skip corrupted certificates.
      }
    }
  }

  walk(DATA_DIR);
  return certificates.sort((a, b) =>
    `${a.packageName}@${a.version}`.localeCompare(`${b.packageName}@${b.version}`),
  );
}

export function listUnanchoredCertificates(): AuditCertificate[] {
  return listCertificates().filter((certificate) => !certificate.anchor);
}
