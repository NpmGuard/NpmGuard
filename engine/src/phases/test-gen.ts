import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateText } from "ai";

import { config } from "../config.js";
import { getModel } from "../llm.js";
import { dockerExec } from "../sandbox/docker.js";
import { canaryEnvFlags, canaryPlantedFiles } from "../sandbox/canaries.js";
import type { Proof, Finding } from "../models.js";
import type { InvestigationResult } from "./investigate.js";
import {
  TESTGEN_SYSTEM_PROMPT,
  buildTestGenUserPrompt,
} from "./test-gen-prompt.js";
import { readPackageSource, readExampleTest } from "./test-gen-helpers.js";

const MAX_RETRIES = 3;
const HARNESS_DIR = resolve(import.meta.dirname, "../../../sandbox/harness");
const VALIDATE_TIMEOUT_MS = 30_000;

// Same vitest config as verify.ts, kept in sync intentionally.
const VITEST_CONFIG = `const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    include: ["generated/**/*.test.{js,ts}"],
    setupFiles: ["./harness/setup.js"],
    restoreMocks: true,
    testTimeout: 30000,
    pool: "forks",
    reporters: ["json"],
    globals: true,
  },
});
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Docker-based vitest preflight (replaces the host-side validateTestWithVitest
// that was removed in PR #13 after the 2026-05-08 sandbox-escape incident).
//
// The previous implementation ran `npx vitest run` on the host. Vitest loads
// the test module, which imports the audited package via runPackage(...);
// for malicious bench fixtures (test-pkg-bench-dd-*) the package's
// module-load code executed with root privileges and wiped
// /root/.ssh/authorized_keys.
//
// This implementation runs the same vitest command inside a one-shot
// `docker run --rm` container with:
//   --cap-drop=ALL    no Linux capabilities
//   --network=none    no network at all
//   --memory=Xm       memory cap
//   --pids-limit=64   no fork bombs
//   -v workDir:/workspace   only the test workdir is bind-mounted, NOT /root
//
// Same isolation profile as verify.ts. The host remains unreachable from the
// audited package's code.
// ---------------------------------------------------------------------------

interface ValidationResult {
  valid: boolean;
  errorType: "runtime" | "assertion" | "timeout" | null;
  errorMessage: string | null;
}

const RUNTIME_ERROR_PATTERNS = [
  "TypeError",
  "ReferenceError",
  "is not a function",
  "is not defined",
  "Cannot find module",
  "Cannot read propert",
  "is not a constructor",
  "SyntaxError",
];

function classifyFailureMessages(messages: string[]): "runtime" | "assertion" {
  const joined = messages.join("\n");
  for (const pattern of RUNTIME_ERROR_PATTERNS) {
    if (joined.includes(pattern)) return "runtime";
  }
  return "assertion";
}

async function validateTestInDocker(
  testCode: string,
  packagePath: string,
): Promise<ValidationResult> {
  const workDir = mkdtempSync(join(tmpdir(), "npmguard-validate-"));
  chmodSync(workDir, 0o777);
  const harnessDir = join(workDir, "harness");
  const generatedDir = join(workDir, "generated");
  const testPkgDir = join(workDir, "test-packages");
  mkdirSync(harnessDir, { recursive: true, mode: 0o777 });
  mkdirSync(generatedDir, { recursive: true, mode: 0o777 });
  mkdirSync(testPkgDir, { recursive: true, mode: 0o777 });
  chmodSync(harnessDir, 0o777);
  chmodSync(generatedDir, 0o777);
  chmodSync(testPkgDir, 0o777);

  try {
    for (const file of ["setup.js", "server.js", "sandbox-runner.js", "child-process-runner.js"]) {
      copyFileSync(join(HARNESS_DIR, file), join(harnessDir, file));
    }
    writeFileSync(join(workDir, "vitest.config.js"), VITEST_CONFIG, "utf-8");

    const packageDirName = basename(packagePath);
    execFileSync("cp", ["-r", packagePath, join(testPkgDir, packageDirName)], { timeout: 10_000 });
    writeFileSync(join(generatedDir, "preflight.test.ts"), testCode, "utf-8");

    // Plant canary credentials so the preflight environment matches verify.
    // Keeps test-gen retries focused on real failures instead of "no canary
    // present" assertion mismatches that would resolve themselves in verify.
    for (const planted of canaryPlantedFiles()) {
      const dest = join(workDir, planted.relativePath);
      mkdirSync(join(dest, ".."), { recursive: true, mode: 0o777 });
      writeFileSync(dest, planted.content, { mode: 0o644 });
    }

    // Confirm npmguard-verify image exists (already used by verify phase).
    const verifyImage = "npmguard-verify";
    const imageInspect = await dockerExec(["image", "inspect", verifyImage], 5_000);
    if (imageInspect.exitCode !== 0) {
      // Image missing — skip preflight rather than fall back to host execution.
      // Docker verify phase will validate later.
      console.log(`[test-gen:validate] ${verifyImage} image not present, skipping preflight`);
      return { valid: true, errorType: null, errorMessage: null };
    }

    const runCmd = [
      "run", "--rm",
      "--name", `npmguard-validate-${randomUUID().slice(0, 12)}`,
      "--network=none",
      "--cap-drop=ALL",
      `--memory=${config.sandboxMemoryMb}m`,
      `--cpus=${config.sandboxCpus}`,
      "--pids-limit", "64",
      "-e", "NPMGUARD_PACKAGES_DIR=/workspace/test-packages",
      ...canaryEnvFlags(),
      "-v", `${workDir}:/workspace`,
      "-w", "/workspace",
      verifyImage,
      "sh", "-c",
      "ln -s /opt/verify/node_modules /workspace/node_modules 2>/dev/null; /opt/verify/node_modules/.bin/vitest run --reporter=json --outputFile.json=/workspace/results.json 2>&1; echo EXIT=$?",
    ];

    const result = await dockerExec(runCmd, VALIDATE_TIMEOUT_MS);

    if (result.timedOut) {
      return { valid: false, errorType: "timeout", errorMessage: `Preflight timed out after ${VALIDATE_TIMEOUT_MS}ms` };
    }

    // Parse vitest JSON output (last { in stdout — vitest reporter prints it inline).
    const stdout = result.stdout || "";
    const jsonStart = stdout.lastIndexOf('{"numTotalTestSuites"');
    if (jsonStart === -1) {
      const combined = stdout + (result.stderr || "");
      const isRuntime = RUNTIME_ERROR_PATTERNS.some((p) => combined.includes(p));
      if (isRuntime) {
        const errorLine = combined.split("\n").find((l) => RUNTIME_ERROR_PATTERNS.some((p) => l.includes(p))) ?? combined.slice(0, 300);
        return { valid: false, errorType: "runtime", errorMessage: errorLine.slice(0, 500) };
      }
      // Could not parse — treat as inconclusive (let Docker verify make the call).
      return { valid: true, errorType: null, errorMessage: null };
    }

    let parsed: {
      numPassedTests: number;
      numFailedTests: number;
      testResults?: Array<{
        assertionResults?: Array<{
          status: string;
          failureMessages?: string[];
        }>;
      }>;
    };
    try {
      parsed = JSON.parse(stdout.slice(jsonStart));
    } catch {
      return { valid: true, errorType: null, errorMessage: null };
    }

    if (parsed.numFailedTests === 0 && parsed.numPassedTests > 0) {
      return { valid: true, errorType: null, errorMessage: null };
    }

    const allFailureMessages = parsed.testResults
      ?.flatMap((r) => r.assertionResults ?? [])
      ?.filter((a) => a.status === "failed")
      ?.flatMap((a) => a.failureMessages ?? []) ?? [];

    const errorType = classifyFailureMessages(allFailureMessages);
    const errorMessage = allFailureMessages.join("\n").slice(0, 500);

    if (errorType === "assertion") {
      // Test is structurally correct, just doesn't observe the malicious
      // behavior in the sandbox (often expected with --network=none and
      // sandbox-detection). Keep the test; Docker verify gets the final say.
      return { valid: true, errorType: "assertion", errorMessage };
    }
    return { valid: false, errorType: "runtime", errorMessage };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}


// ---------------------------------------------------------------------------
// Test generation with retry loop
// ---------------------------------------------------------------------------

function cleanGeneratedCode(raw: string): string {
  let code = raw.trim();
  // Strip markdown fences
  code = code.replace(/^```(?:javascript|js|typescript|ts)?\n?/m, "").replace(/\n?```\s*$/m, "");
  // Strip server.listen/close (harness handles this)
  code = code.replace(/^\s*server\.listen\(.*\);?\s*$/gm, "");
  code = code.replace(/^\s*server\.close\(.*\);?\s*$/gm, "");
  code = code.replace(/^\s*(before|after)(All|Each)\(\(\)\s*=>\s*\{\s*\}\);?\s*$/gm, "");
  return code;
}

async function generateTestDirect(
  finding: Finding,
  packageName: string,
  packageSource: string,
  packagePath: string,
): Promise<string | null> {
  const example = readExampleTest(finding.capability);
  let lastError: string | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Build prompt — on retry, append the error from the previous attempt
    let userPrompt = buildTestGenUserPrompt(finding, packageName, packageSource, example);
    if (lastError && attempt > 0) {
      userPrompt += `\n\n## Previous Attempt Failed (attempt ${attempt}/${MAX_RETRIES})\nYour generated test had a runtime error:\n\`\`\`\n${lastError}\n\`\`\`\nFix the error and regenerate. Common fixes:\n- If "X is not a function": check the module's actual exports in the source code above\n- If "Cannot find module": check the entry point path\n- runPackage() returns module.exports directly — destructure what you need from it`;
    }

    try {
      const result = await generateText({
        model: getModel(config.testGenModel),
        system: TESTGEN_SYSTEM_PROMPT,
        prompt: userPrompt,
        temperature: 0.2 + (attempt * 0.1), // nudge creativity on retries
        maxOutputTokens: 8192,
      });

      const code = cleanGeneratedCode(result.text);

      console.log(`[test-gen] attempt ${attempt + 1}/${MAX_RETRIES}: LLM returned ${code.length} bytes for ${finding.fileLine}`);

      // Structural check (fast)
      if (!code.includes("runPackage(") && !code.includes("runInChildProcess(")) {
        console.error(`[test-gen] attempt ${attempt + 1}: no runPackage/runInChildProcess call, retrying`);
        lastError = "Test must use runPackage() or runInChildProcess() to load the package. Do not use require() directly.";
        continue;
      }

      // Preflight in Docker (sandboxed). Replaces the previous host-side
      // vitest run that was responsible for the 2026-05-08 escape.
      console.log(`[test-gen] attempt ${attempt + 1}: validating in Docker preflight...`);
      const validation = await validateTestInDocker(code, packagePath);

      if (validation.valid) {
        if (validation.errorType === "assertion") {
          console.log(`[test-gen] attempt ${attempt + 1}: VALID (assertion mismatch — structurally correct, kept)`);
        } else {
          console.log(`[test-gen] attempt ${attempt + 1}: VALID (passed in preflight)`);
        }
        return code;
      }

      lastError = validation.errorMessage?.slice(0, 500) ?? "Unknown runtime error";
      console.log(`[test-gen] attempt ${attempt + 1}: ${validation.errorType} error, retrying — ${lastError.slice(0, 200)}`);
      if (attempt < MAX_RETRIES - 1) await sleep(1000);
    } catch (err) {
      console.error(`[test-gen] attempt ${attempt + 1}: LLM call failed for ${finding.fileLine}: ${err}`);
      lastError = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  console.error(`[test-gen] all ${MAX_RETRIES} attempts failed for ${finding.fileLine}`);
  return null;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Phase 1c: Auto-generate Vitest proof tests from investigation findings. */
export async function generateTests(
  investigation: InvestigationResult,
  packagePath: string,
): Promise<Proof[]> {
  if (investigation.findings.length === 0) {
    console.log("[test-gen] no findings to generate tests for");
    return investigation.proofs;
  }

  const packageName = basename(packagePath);
  const packageSource = readPackageSource(packagePath);
  const testDir = mkdtempSync(join(tmpdir(), "npmguard-tests-"));

  // Selection policy (Phase C — Finding 4):
  // - No capability dedup. Two findings with the same capability enum are
  //   distinct hypotheses (different sites, different trigger conditions)
  //   and both deserve a reproducer.
  // - `config.maxFindingsToProve` caps how many findings we actually
  //   generate tests for. 0 = unlimited (production default). Tests /
  //   cost-constrained runs can set e.g. NPMGUARD_MAX_FINDINGS_TO_PROVE=2.
  const cap = config.maxFindingsToProve;
  const selectedFindings: Array<{ index: number; finding: Finding }> =
    investigation.findings.map((finding, index) => ({ index, finding }));
  const limited = cap > 0 ? selectedFindings.slice(0, cap) : selectedFindings;

  console.log(
    `[test-gen] generating tests for ${limited.length}/${investigation.findings.length} findings${cap > 0 ? ` (capped by NPMGUARD_MAX_FINDINGS_TO_PROVE=${cap})` : ""}`,
  );

  // Staggered parallel: launch one request per 2s, run concurrently.
  const testResultPromises = limited.map(({ index: i, finding }, j) =>
    sleep(j * 2000).then(async () => {
      console.log(`[test-gen] generating test ${j + 1}/${limited.length}: ${finding.capability} @ ${finding.fileLine}`);
      const testCode = await generateTestDirect(finding, packageName, packageSource, packagePath);
      return { index: i, finding, testCode };
    }),
  );
  const testResults = await Promise.all(testResultPromises);

  // Write test files and update proofs
  const updatedProofs = investigation.proofs.map((proof, i) => {
    const result = testResults.find((r) => r.index === i);
    if (!result?.testCode) return proof;

    const testPath = join(testDir, `finding-${i}.test.ts`);
    writeFileSync(testPath, result.testCode, "utf-8");
    const hash = createHash("sha256").update(result.testCode).digest("hex");

    console.log(`[test-gen] wrote ${testPath} (${result.testCode.length} bytes, hash=${hash.slice(0, 12)})`);

    return {
      ...proof,
      testFile: testPath,
      testHash: hash,
      testCode: result.testCode,
    };
  });

  const withTests = updatedProofs.filter((p) => p.testFile).length;
  console.log(`[test-gen] generated ${withTests}/${investigation.findings.length} test files`);

  return updatedProofs;
}
