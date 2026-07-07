import * as fs from "node:fs";
import * as path from "node:path";
import type { StoragePublishResult } from "./storage/publisher.js";

const STORAGE_DIR = path.resolve(import.meta.dirname, "../../data/storage");

function assertUnderStorageDir(target: string): string {
  const resolved = path.resolve(target);
  const rel = path.relative(STORAGE_DIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Storage path escapes data directory");
  }
  return resolved;
}

function storageDir(packageName: string): string {
  return assertUnderStorageDir(path.join(STORAGE_DIR, packageName));
}

function storagePath(packageName: string, version: string): string {
  return assertUnderStorageDir(path.join(storageDir(packageName), `${version}.json`));
}

export function saveStoragePublication(result: StoragePublishResult): void {
  const dir = storageDir(result.packageName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storagePath(result.packageName, result.version), JSON.stringify(result, null, 2));
  console.log(`[storage-store] saved ${result.packageName}@${result.version}`);
}

export function loadStoragePublication(
  packageName: string,
  version: string,
): StoragePublishResult | null {
  const file = storagePath(packageName, version);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf-8")) as StoragePublishResult;
}
