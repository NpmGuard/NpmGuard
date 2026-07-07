import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

// AES-256-GCM for secrets at rest (user OAuth tokens — spec §5.9). The DB
// file must never be a credential dump. Key: NPMGUARD_ENCRYPTION_KEY, 32
// bytes hex. Blob format: base64(iv).base64(tag).base64(ciphertext).

function key(): Buffer {
  if (!config.encryptionKey) {
    throw new Error("NPMGUARD_ENCRYPTION_KEY is required to store secrets");
  }
  return Buffer.from(config.encryptionKey, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 3) throw new Error("Malformed encrypted blob");
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf-8");
}
