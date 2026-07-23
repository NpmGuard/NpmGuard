import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditReport } from "./models.js";
import {
  anchorCertificateBatch,
  prepareCertificateBatch,
  readCertificateAnchorMode,
} from "./certificate-anchor.js";
import { verifyCertificateMerkleProof } from "./certificate-merkle.js";
import {
  buildAuditCertificate,
  type AuditCertificate,
} from "./certificates.js";

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

function certificate(): AuditCertificate {
  return buildAuditCertificate({
    packageName: "react",
    version: "19.2.4",
    report: report("SAFE"),
    auditedAt: new Date("2026-07-06T12:00:00.000Z"),
  });
}

describe("certificate anchoring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prepares a single-certificate batch with an empty Merkle proof", () => {
    const prepared = prepareCertificateBatch([certificate()], {
      chain: "base-sepolia",
      now: new Date("2026-07-06T12:05:00.000Z"),
      publicBaseUrl: "https://npmguard.com/",
      getRegistryAddress: () =>
        "0x7CE5589dA2ea066983801c7693a6de2923a3E538",
    });

    expect(prepared.manifest.entries).toHaveLength(1);
    expect(prepared.manifest.batchKey).toMatch(
      /^batch-2026-07-06T12-05-00-000Z-[0-9a-f]{8}$/,
    );
    expect(prepared.batchURI).toBe(
      `https://npmguard.com/certificate-batches/${prepared.manifest.batchKey}.json`,
    );
    expect(prepared.manifest.entries[0]!.merkleProof).toEqual([]);
    expect(prepared.merkleRoot).toBe(
      prepared.manifest.entries[0]!.leafHash,
    );
  });

  it("anchors one certificate via an injected publisher", async () => {
    const savedManifests: unknown[] = [];
    const savedCertificates: AuditCertificate[] = [];
    const cert = certificate();

    const result = await anchorCertificateBatch({
      certificates: [cert],
      chain: "base-sepolia",
      now: new Date("2026-07-06T12:05:00.000Z"),
      publicBaseUrl: "https://npmguard.com",
      getRegistryAddress: () =>
        "0x7CE5589dA2ea066983801c7693a6de2923a3E538",
      saveManifest: (manifest) => {
        savedManifests.push(manifest);
      },
      saveAnchoredCertificate: (certificate) => {
        savedCertificates.push(certificate);
      },
      publishRoot: async ({ chain }) => ({
        chain,
        contractAddress:
          "0x7CE5589dA2ea066983801c7693a6de2923a3E538",
        batchId: "7",
        transactionHash: `0x${"1".repeat(64)}` as `0x${string}`,
        blockNumber: "12345",
      }),
    });

    expect(savedManifests).toHaveLength(2);
    expect(savedCertificates).toHaveLength(1);
    expect(result.manifest.status).toBe("anchored");
    expect(savedCertificates[0]!.anchor).toMatchObject({
      chain: "base-sepolia",
      batchId: "7",
      transactionHash: `0x${"1".repeat(64)}`,
      blockNumber: "12345",
      merkleRoot: result.manifest.merkleRoot,
    });
    expect(
      verifyCertificateMerkleProof(
        savedCertificates[0]!.anchor!.leafHash,
        savedCertificates[0]!.anchor!.merkleProof,
        savedCertificates[0]!.anchor!.merkleRoot,
      ),
    ).toBe(true);
  });

  it("uses immediate mode when configured", () => {
    vi.stubEnv("NPMGUARD_CERTIFICATE_ANCHOR_MODE", "immediate");
    expect(readCertificateAnchorMode()).toBe("immediate");
  });
});
