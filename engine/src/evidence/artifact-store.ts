import * as fs from "node:fs";
import * as path from "node:path";
import { RunArtifact } from "@npmguard/shared";
import type { RunArtifact as RunArtifactType } from "@npmguard/shared";
import { canonicalize } from "./canonical-json.js";
import { sha256Hex, contentHashOf } from "./hashing.js";

/**
 * Content-addressed store for Phase A evidence artifacts.
 *
 * Layout under `rootDir`:
 *   artifacts/
 *     <hash>                    # raw blob (no extension)
 *     <hash>.<ext>              # raw blob with extension (pcap, txt, json, ...)
 *     <hash>.runartifact.json   # serialized RunArtifact
 *
 * Blobs are written once per content hash — re-writing the same bytes is a no-op.
 */
export class ArtifactStore {
  private readonly artifactsDir: string;

  constructor(rootDir: string) {
    this.artifactsDir = path.join(rootDir, "artifacts");
  }

  private blobPath(hash: string, extension?: string): string {
    const name = extension ? `${hash}.${extension}` : hash;
    return path.join(this.artifactsDir, name);
  }

  /** Write a raw blob; returns the sha256 of its bytes. Idempotent on content. */
  writeBlob(data: Buffer | string, extension?: string): string {
    const hash = sha256Hex(data);
    const target = this.blobPath(hash, extension);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, data);
    }
    return hash;
  }

  readBlob(hash: string, extension?: string): Buffer {
    return fs.readFileSync(this.blobPath(hash, extension));
  }

  hasBlob(hash: string, extension?: string): boolean {
    return fs.existsSync(this.blobPath(hash, extension));
  }

  /**
   * Serialize a RunArtifact canonically, embed its contentHash, validate the
   * schema at the write boundary, and write to disk. Returns the content hash.
   *
   * The hash covers the whole record EXCEPT the contentHash field itself
   * (which starts empty, receives the computed value, and gets written).
   */
  writeArtifact(partial: Omit<RunArtifactType, "contentHash">): string {
    const parsedNoHash = RunArtifact.parse({ ...partial, contentHash: "" });
    const contentHash = contentHashOf({ ...parsedNoHash, contentHash: "" });
    const parsed: RunArtifactType = { ...parsedNoHash, contentHash };
    const canonical = canonicalize(parsed);

    const target = this.blobPath(contentHash, "runartifact.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, canonical, "utf-8");

    return contentHash;
  }

  /** Read and validate a RunArtifact by content hash. Throws on schema violation. */
  readArtifact(contentHash: string): RunArtifactType {
    const raw = fs.readFileSync(this.blobPath(contentHash, "runartifact.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return RunArtifact.parse(parsed);
  }

  /**
   * Verify a stored RunArtifact's declared contentHash matches its canonical bytes.
   * Returns true if the hash is valid; false if the file has been tampered with.
   */
  verifyArtifact(contentHash: string): boolean {
    const artifact = this.readArtifact(contentHash);
    const hashInput = { ...artifact, contentHash: "" };
    return contentHashOf(hashInput) === contentHash;
  }
}
