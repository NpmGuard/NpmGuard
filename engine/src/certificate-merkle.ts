import { concatHex, keccak256, toBytes, type Hex } from "viem";
import {
  certificateAnchorPayload,
  type AuditCertificate,
  type MerkleProofStep,
} from "./certificates.js";
import { canonicalize } from "./evidence/canonical-json.js";

export interface CertificateMerkleEntry {
  certificate: AuditCertificate;
  leafHash: Hex;
  proof: MerkleProofStep[];
}

export interface CertificateMerkleBatch {
  merkleRoot: Hex;
  entries: CertificateMerkleEntry[];
}

function hashPair(left: Hex, right: Hex): Hex {
  return keccak256(concatHex([left, right]));
}

export function certificateLeafHash(certificate: AuditCertificate): Hex {
  return keccak256(toBytes(canonicalize(certificateAnchorPayload(certificate))));
}

export function buildCertificateMerkleBatch(
  certificates: AuditCertificate[],
): CertificateMerkleBatch {
  if (certificates.length === 0) {
    throw new Error("Cannot build a Merkle batch with no certificates");
  }

  const entries: CertificateMerkleEntry[] = certificates.map((certificate) => ({
    certificate,
    leafHash: certificateLeafHash(certificate),
    proof: [],
  }));

  let level = entries.map((entry, index) => ({
    hash: entry.leafHash,
    indices: [index],
  }));
  while (level.length > 1) {
    const next: Array<{ hash: Hex; indices: number[] }> = [];

    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left;
      const parentHash = hashPair(left.hash, right.hash);

      for (const index of left.indices) {
        entries[index]!.proof.push({ position: "right", hash: right.hash });
      }
      if (right !== left) {
        for (const index of right.indices) {
          entries[index]!.proof.push({ position: "left", hash: left.hash });
        }
      }

      next.push({
        hash: parentHash,
        indices: right === left ? left.indices : [...left.indices, ...right.indices],
      });
    }

    level = next;
  }

  return {
    merkleRoot: level[0]!.hash,
    entries,
  };
}

export function verifyCertificateMerkleProof(
  leafHash: Hex,
  proof: readonly MerkleProofStep[],
  expectedRoot: Hex,
): boolean {
  let cursor = leafHash;
  for (const step of proof) {
    cursor =
      step.position === "left"
        ? hashPair(step.hash, cursor)
        : hashPair(cursor, step.hash);
  }
  return cursor.toLowerCase() === expectedRoot.toLowerCase();
}
