import { describe, expect, it } from "vitest";
import { repairInvestigationExtraction } from "./extraction.js";

const AGENT_RESPONSE = `## Summary

The package contains a malicious credential theft payload.

## Findings

### Finding 1: Binary drop — downloads and executes a remote shell script

| Field | Value |
|-------|-------|
| **Capability** | NETWORK, PROCESS_SPAWN |
| **File** | \`setup_bun.js\` |
| **Lines** | 66–95 |
| **Confidence** | **CONFIRMED** |
| **Evidence** | The lifecycle trace recorded: |
| | \`{"type":"process","method":"execSync","cmd":"curl https://bun.sh/install \\| bash"}\` |
| | No checksum or signature is verified before execution. |
| **Reproduction** | Run the preinstall hook and assert the traced command. |

### Finding 2: Cloud credential theft

| Field | Value |
|-------|-------|
| **Capability** | CREDENTIAL_THEFT, ENV_VARS |
| **File** | \`bun_environment.js\` |
| **Offset** | ~offset=984432 |
| **Confidence** | **LIKELY** |
| **Evidence** | Reads \`AWS_SECRET_ACCESS_KEY\` from \`process.env\`. |
| **Reproduction** | Trace environment access without using real credentials. |
`;

describe("repairInvestigationExtraction", () => {
  it("recovers grounded problem, evidence, confidence, and summary from agent Markdown", () => {
    const repaired = repairInvestigationExtraction(
      {
        findings: [
          {
            capability: "NETWORK, PROCESS_SPAWN",
            confidence: "SUSPECTED",
            fileLine: "setup_bun.js:66-95",
            problem: "",
            evidence: "",
            reproductionStrategy: "Run the preinstall hook.",
          },
          {
            capability: "CREDENTIAL_THEFT, ENV_VARS",
            confidence: "SUSPECTED",
            fileLine: "bun_environment.js:984432",
            problem: "",
            evidence: "",
            reproductionStrategy: "",
          },
        ],
        summary: "",
      },
      AGENT_RESPONSE,
    );

    expect(repaired.summary).toContain("malicious credential theft");
    expect(repaired.findings[0]).toMatchObject({
      confidence: "CONFIRMED",
      problem: "Binary drop — downloads and executes a remote shell script",
      reproductionStrategy: "Run the preinstall hook.",
    });
    expect(repaired.findings[0]!.evidence).toContain("curl https://bun.sh/install | bash");
    expect(repaired.findings[0]!.evidence).toContain("No checksum");
    expect(repaired.findings[1]).toMatchObject({
      confidence: "LIKELY",
      fileLine: "bun_environment.js:984432",
      problem: "Cloud credential theft",
      evidence: "Reads `AWS_SECRET_ACCESS_KEY` from `process.env`.",
      reproductionStrategy: "Trace environment access without using real credentials.",
    });
  });

  it("can recover findings when structured extraction fails entirely", () => {
    const repaired = repairInvestigationExtraction(null, AGENT_RESPONSE);

    expect(repaired.findings).toHaveLength(2);
    expect(repaired.findings[0]!.fileLine).toBe("setup_bun.js:66-95");
    expect(repaired.findings[1]!.capability).toBe("CREDENTIAL_THEFT, ENV_VARS");
  });

  it("does not invent evidence when the response provides none", () => {
    const repaired = repairInvestigationExtraction(
      null,
      `## Findings

### Finding 1: Vague concern

| **Capability** | NETWORK |
| **File** | \`index.js\` |
| **Confidence** | **SUSPECTED** |
| **Reproduction** | Inspect the package. |
`,
    );

    expect(repaired.findings[0]!.problem).toBe("Vague concern");
    expect(repaired.findings[0]!.evidence).toBe("");
  });
});
