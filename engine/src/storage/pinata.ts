import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PINATA_LEGACY_FILE_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";
const DEFAULT_TIMEOUT_MS = 60_000;
export type PinataNetwork = "public" | "private";

export interface PinataUploadResult {
  cid: string;
  ipfsUri: string;
  gatewayUrl: string;
  name: string;
  size: number;
  raw: unknown;
}

interface UploadBytesOptions {
  jwt: string;
  gatewayHost: string;
  network?: PinataNetwork;
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  timeoutMs?: number;
}

interface UploadFileOptions {
  jwt: string;
  gatewayHost: string;
  network?: PinataNetwork;
  filePath: string;
  name?: string;
  timeoutMs?: number;
}

export interface DirectoryFileEntry {
  path: string;
  size: number;
  sha256: string;
}

interface UploadDirectoryOptions {
  jwt: string;
  gatewayHost: string;
  directoryPath: string;
  name: string;
  timeoutMs?: number;
}

interface UploadJsonOptions {
  jwt: string;
  gatewayHost: string;
  network?: PinataNetwork;
  name: string;
  value: unknown;
  timeoutMs?: number;
}

export function normalizeGatewayHost(gatewayHost: string): string {
  return gatewayHost
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .trim();
}

export function pinataGatewayUrl(cid: string, gatewayHost: string): string {
  return `https://${normalizeGatewayHost(gatewayHost)}/ipfs/${cid}`;
}

function inferMimeType(filePath: string): string {
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".tgz")) return "application/gzip";
  if (filePath.endsWith(".tar.gz")) return "application/gzip";
  return "application/octet-stream";
}

function parseJsonPayload(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { body: text };
  }
}

function cidFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object"
    ? (record.data as Record<string, unknown>)
    : null;

  for (const source of [record, data]) {
    if (!source) continue;
    for (const key of ["cid", "IpfsHash", "ipfsHash"]) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }

  return null;
}

function pinSizeFromPayload(payload: unknown, fallback: number): number {
  if (!payload || typeof payload !== "object") return fallback;
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object"
    ? (record.data as Record<string, unknown>)
    : null;

  for (const source of [record, data]) {
    if (!source) continue;
    for (const key of ["size", "PinSize"]) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }

  return fallback;
}

async function listDirectoryFiles(root: string): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const resolvedRoot = path.resolve(root);
  const files: Array<{ absolutePath: string; relativePath: string }> = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relative = path.relative(resolvedRoot, absolutePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Directory upload path escaped root: ${absolutePath}`);
      }
      files.push({
        absolutePath,
        relativePath: relative.split(path.sep).join("/"),
      });
    }
  }

  await walk(resolvedRoot);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function multipartHeader(boundary: string, name: string, extra: string): Buffer {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n`);
}

function multipartField(boundary: string, name: string, value: string): Buffer {
  return Buffer.concat([
    multipartHeader(boundary, name, ""),
    Buffer.from(value),
    Buffer.from("\r\n"),
  ]);
}

function escapeDispositionValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function uploadBytesToPinata(options: UploadBytesOptions): Promise<PinataUploadResult> {
  const form = new FormData();
  const bodyBytes = Uint8Array.from(options.bytes);
  const bodyBuffer = bodyBytes.buffer.slice(
    bodyBytes.byteOffset,
    bodyBytes.byteOffset + bodyBytes.byteLength,
  ) as ArrayBuffer;
  form.append("network", options.network ?? "public");
  form.append("name", options.name);
  form.append("file", new Blob([bodyBuffer], { type: options.mimeType }), options.name);

  const response = await fetch(PINATA_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.jwt}`,
    },
    body: form,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const text = await response.text();
  const payload = parseJsonPayload(text);
  if (!response.ok) {
    throw new Error(`Pinata upload failed (${response.status} ${response.statusText}): ${text}`);
  }

  const cid = cidFromPayload(payload);
  if (!cid) {
    throw new Error(`Pinata response did not include a CID: ${JSON.stringify(payload)}`);
  }

  return {
    cid,
    ipfsUri: `ipfs://${cid}`,
    gatewayUrl: pinataGatewayUrl(cid, options.gatewayHost),
    name: options.name,
    size: options.bytes.byteLength,
    raw: payload,
  };
}

export async function uploadJsonToPinata(options: UploadJsonOptions): Promise<PinataUploadResult> {
  const bytes = Buffer.from(JSON.stringify(options.value, null, 2));
  return uploadBytesToPinata({
    jwt: options.jwt,
    gatewayHost: options.gatewayHost,
    network: options.network,
    bytes,
    name: options.name,
    mimeType: "application/json",
    timeoutMs: options.timeoutMs,
  });
}

export async function uploadFileToPinata(options: UploadFileOptions): Promise<PinataUploadResult> {
  const bytes = await fs.readFile(options.filePath);
  return uploadBytesToPinata({
    jwt: options.jwt,
    gatewayHost: options.gatewayHost,
    network: options.network,
    bytes,
    name: options.name ?? path.basename(options.filePath),
    mimeType: inferMimeType(options.filePath),
    timeoutMs: options.timeoutMs,
  });
}

export async function uploadDirectoryToPinata(
  options: UploadDirectoryOptions,
): Promise<PinataUploadResult & { files: DirectoryFileEntry[] }> {
  const files = await listDirectoryFiles(options.directoryPath);
  if (files.length === 0) {
    throw new Error(`Directory ${options.directoryPath} does not contain files to upload`);
  }

  const boundary = `npmguard-${randomUUID()}`;
  const chunks: Buffer[] = [
    multipartField(boundary, "pinataMetadata", JSON.stringify({ name: options.name })),
    multipartField(boundary, "pinataOptions", JSON.stringify({ cidVersion: 1 })),
  ];
  let totalSize = 0;
  const fileEntries: DirectoryFileEntry[] = [];

  for (const file of files) {
    const bytes = await fs.readFile(file.absolutePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    totalSize += bytes.byteLength;
    fileEntries.push({
      path: file.relativePath,
      size: bytes.byteLength,
      sha256: digest,
    });
    chunks.push(
      multipartHeader(
        boundary,
        "file",
        `; filename="${escapeDispositionValue(path.basename(file.relativePath))}"; filepath="${escapeDispositionValue(file.relativePath)}"`,
      ),
      bytes,
      Buffer.from("\r\n"),
    );
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));

  const response = await fetch(PINATA_LEGACY_FILE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.jwt}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body: Buffer.concat(chunks),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const text = await response.text();
  const payload = parseJsonPayload(text);
  if (!response.ok) {
    throw new Error(`Pinata directory upload failed (${response.status} ${response.statusText}): ${text}`);
  }

  const cid = cidFromPayload(payload);
  if (!cid) {
    throw new Error(`Pinata directory response did not include a CID: ${JSON.stringify(payload)}`);
  }

  return {
    cid,
    ipfsUri: `ipfs://${cid}`,
    gatewayUrl: pinataGatewayUrl(cid, options.gatewayHost),
    name: options.name,
    size: pinSizeFromPayload(payload, totalSize),
    raw: payload,
    files: fileEntries,
  };
}
