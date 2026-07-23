import { describe, expect, it } from "vitest";
import type { AuditReport } from "./models.js";
import { buildAuditCertificate } from "./certificates.js";
import {
  buildCertificateMerkleBatch,
  certificateLeafHash,
  verifyCertificateMerkleProof,
} from "./certificate-merkle.js";

function report(verdict: AuditReport["verdict"]): AuditReport {
  return {
    verdict,
    capabilities: [],
    proofs: [],
    triage: null,
    findings: [],
    trace: [],
    runtimeEvidence: null,
  };
}

function certificate(
  packageName: string,
  version: string,
  verdict: AuditReport["verdict"] = "SAFE",
) {
  return buildAuditCertificate({
    packageName,
    version,
    report: report(verdict),
    auditedAt: new Date("2026-07-06T12:00:00.000Z"),
  });
}

describe("certificate Merkle batches", () => {
  it("builds verifiable proofs for every certificate", () => {
    const batch = buildCertificateMerkleBatch([
      certificate("a", "1.0.0"),
      certificate("b", "1.0.0"),
      certificate("c", "1.0.0", "DANGEROUS"),
    ]);

    expect(batch.merkleRoot).toMatch(/^0x[0-9a-f]{64}$/);
    for (const entry of batch.entries) {
      expect(
        verifyCertificateMerkleProof(
          entry.leafHash,
          entry.proof,
          batch.merkleRoot,
        ),
      ).toBe(true);
    }
  });

  it("is order-sensitive", () => {
    const certs = [
      certificate("a", "1.0.0"),
      certificate("b", "1.0.0"),
      certificate("c", "1.0.0"),
    ];

    expect(buildCertificateMerkleBatch(certs).merkleRoot).not.toBe(
      buildCertificateMerkleBatch([...certs].reverse()).merkleRoot,
    );
  });

  it("does not include anchor metadata in the leaf hash", () => {
    const cert = certificate("react", "19.2.4");
    const anchored = {
      ...cert,
      anchor: {
        chain: "base-sepolia" as const,
        contractAddress:
          "0x7CE5589dA2ea066983801c7693a6de2923a3E538" as const,
        batchId: "1",
        batchURI:
          "https://npmguard.com/certificate-batches/batch-1.json",
        transactionHash:
          "0x1111111111111111111111111111111111111111111111111111111111111111" as const,
        blockNumber: "123",
        anchoredAt: "2026-07-06T12:05:00.000Z",
        merkleRoot:
          "0x2222222222222222222222222222222222222222222222222222222222222222" as const,
        leafHash:
          "0x3333333333333333333333333333333333333333333333333333333333333333" as const,
        merkleProof: [],
      },
    };

    expect(certificateLeafHash(anchored)).toBe(certificateLeafHash(cert));
  });
});
