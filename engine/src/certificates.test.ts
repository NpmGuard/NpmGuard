import { describe, expect, it } from "vitest";
import type { AuditReport } from "./models.js";
import { buildAuditCertificate, extractPackageProof } from "./certificates.js";

function makeReport(): AuditReport {
  return {
    verdict: "SAFE",
    capabilities: [],
    proofs: [],
    triage: null,
    findings: [],
    runtimeEvidence: null,
    trace: [
      {
        phase: "resolve",
        durationMs: 12,
        input: { packageName: "react", version: "19.2.4" },
        output: {
          packageProof: {
            registry: "npm",
            resolvedVersion: "19.2.4",
            tarballUrl:
              "https://registry.npmjs.org/react/-/react-19.2.4.tgz",
            integrity: "sha512-test",
            shasum: "abc123",
            tarballSha256: "def456",
          },
        },
      },
    ],
  };
}

describe("audit certificates", () => {
  it("extracts the npm package proof from the resolve phase", () => {
    expect(extractPackageProof(makeReport())).toEqual({
      registry: "npm",
      resolvedVersion: "19.2.4",
      tarballUrl: "https://registry.npmjs.org/react/-/react-19.2.4.tgz",
      integrity: "sha512-test",
      shasum: "abc123",
      tarballSha256: "def456",
    });
  });

  it("builds a stable certificate for the same report and audit time", () => {
    const auditedAt = new Date("2026-07-06T12:00:00.000Z");
    const a = buildAuditCertificate({
      packageName: "react",
      version: "19.2.4",
      report: makeReport(),
      auditedAt,
    });
    const b = buildAuditCertificate({
      packageName: "react",
      version: "19.2.4",
      report: makeReport(),
      auditedAt,
    });

    expect(a).toEqual(b);
    expect(a.certificateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.certificateId).toBe(
      `npmguard:v1:${a.certificateHash.replace("sha256:", "")}`,
    );
    expect(a.report.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.report.urlPath).toBe(
      "/package/react/report?version=19.2.4",
    );
    expect(a.validUntil).toBe("2026-10-04T12:00:00.000Z");
  });
});
