import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateText } from "ai";

import { config } from "../config.js";
import { getModel } from "../llm.js";
import { dockerExec } from "../sandbox/docker.js";
import type { Proof, Finding } from "../models.js";
import type { EmitFn } from "../events.js";
import { TESTGEN_SYSTEM_PROMPT } from "./test-gen-prompt.js";
import { readPackageSource, readExampleTest } from "./test-gen-helpers.js";

const HARNESS_DIR = resolve(import.meta.dirname, "../../../sandbox/harness");

const MAX_RETRY_ATTEMPTS = 3;

/** vitest.config.js for running generated tests. */
const VITEST_CONFIG = `const { defineConfig } = require("vitest/config");

module.exports = defineConfig({
  test: {
    include: ["generated/**/*.test.{js,ts}"],
    setupFiles: ["./harness/setup.js"],
    restoreMocks: true,
    testTimeout: 15000,
    pool: "forks",
    reporters: ["json"],
    globals: true,
  },
});
`;

interface VitestResult {
  testResults?: Array<{
    name: string;
    status: string;
    assertionResults?: Array<{
      ancestorTitles: string[];
      title: string;
      status: string;
      failureMessages?: string[];
    }>;
  }>;
}

function parseVitestOutput(stdout: string): VitestResult | null {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return null;

  try {
    return JSON.parse(stdout.slice(jsonStart)) as VitestResult;
  } catch {
    const lines = stdout.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]!.trim().startsWith("{")) {
        try {
          return JSON.parse(lines.slice(i).join("\n")) as VitestResult;
        } catch { continue; }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test regeneration with error feedback
// ---------------------------------------------------------------------------

function isValidSyntax(code: string): boolean {
  // CRITICAL: never use `tsx --eval import(...)` here — `import()` is a dynamic
  // import that EXECUTES module top-level code on the host. LLM-generated tests
  // can include `import "<malware-path>"` which would run the malware OUTSIDE
  // the Docker sandbox, with full host credentials. (Confirmed exfil incident:
  // Shai-Hulud worm escaped via this path on 2026-04-30.)
  //
  // Structural checks only — the Docker verify phase catches real errors.
  return code.includes("describe(") && (code.includes("runPackage(") || code.includes("runInChildProcess("));
}

async function regenerateTestWithError(
  finding: Finding,
  packageName: string,
  packageSource: string,
  previousTestCode: string,
  errorMessage: string,
  attempt: number,
): Promise<string | null> {
  const example = readExampleTest(finding.capability);

  const retryPrompt = `## Finding
- Capability: ${finding.capability}
- Confidence: ${finding.confidence}
- Location: ${finding.fileLine}
- Problem: ${finding.problem}
- Evidence: ${finding.evidence}

## REPRODUCTION STRATEGY (follow this closely!)
${finding.reproductionStrategy || "Load the package and observe side effects."}

## Package Source Code
${packageSource}

## Reference Example Test
${example}

## PREVIOUS TEST (attempt ${attempt}/${MAX_RETRY_ATTEMPTS}) — FAILED
The following test was generated but FAILED when run in the sandbox:

\`\`\`javascript
${previousTestCode}
\`\`\`

## ERROR OUTPUT
${errorMessage}

## WHAT WENT WRONG — FIX IT
Analyze the error above and fix the test. Common issues:
- runPackage() returns module.exports DIRECTLY. If the module exports { init, track, flush }, then \`const pkg = await runPackage(...)\` gives you those functions directly as \`pkg.init()\`, \`pkg.track()\`, etc.
- If the error says "expected null not to be null" or "expected undefined", the malicious behavior was never triggered. You MUST call the package's exported API functions (init, create, setup, etc.) to trigger it.
- If assertions about HTTP captures fail, the package may need API calls (not just require) before it makes network requests.
- Do NOT use vi.useFakeTimers() BEFORE runPackage() if the package sets up real timers.
- Instead of fake timers, prefer calling the API methods that trigger the behavior directly.

The package name for runPackage() is: "${packageName}"
Output ONLY the fixed JavaScript test code.`;

  try {
    console.log(`[verify:retry] regenerating test for ${finding.capability} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`);

    const result = await generateText({
      model: getModel(config.testGenModel),
      system: TESTGEN_SYSTEM_PROMPT,
      prompt: retryPrompt,
      temperature: 0.3,
      maxOutputTokens: 8192,
    });

    let code = result.text.trim();
    code = code.replace(/^```(?:javascript|js|typescript|ts)?\n?/m, "").replace(/\n?```\s*$/m, "");

    if (!isValidSyntax(code)) {
      console.error(`[verify:retry] regenerated code has invalid syntax, skipping`);
      return null;
    }

    if (!code.includes("runPackage(") && !code.includes("runInChildProcess(")) {
      console.error(`[verify:retry] regenerated code doesn't use runPackage(), skipping`);
      return null;
    }

    // Auto-fix server.listen/close
    if (code.includes("server.listen(") || code.includes("server.close(")) {
      code = code.replace(/^\s*server\.listen\(.*\);?\s*$/gm, "");
      code = code.replace(/^\s*server\.close\(.*\);?\s*$/gm, "");
    }

    console.log(`[verify:retry] regenerated ${code.length} bytes`);
    return code;
  } catch (err) {
    console.error(`[verify:retry] LLM call failed: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Run vitest and parse results
// ---------------------------------------------------------------------------

async function runVitest(
  containerName: string,
  npxPath: string,
  timeoutMs: number,
  workDir: string,
): Promise<VitestResult | null> {
  // Clear previous results
  const resultsPath = join(workDir, "vitest-results.json");
  try { rmSync(resultsPath, { force: true }); } catch { /* ok */ }

  const vitestResult = await dockerExec(
    ["exec", containerName, "sh", "-c",
      // Dual reporter: verbose to stdout (so console.error from sandbox-runner is visible),
      // json to file (so we can parse structured results).
      `cd /workspace && ${npxPath} run --reporter=verbose --reporter=json --outputFile.json=/workspace/vitest-results.json 2>&1; echo VITEST_EXIT=$?`],
    timeoutMs,
  );

  console.log(`[verify] vitest exited with code ${vitestResult.exitCode}`);
  if (vitestResult.stdout) {
    // On failure, surface lines that point at the actual cause (sandbox-runner
    // require errors, assertion failures, thrown errors). Helps a test author
    // see WHY a test failed without parsing the full vitest output.
    const dbg = vitestResult.stdout
      .split("\n")
      .filter((l) => /sandbox-runner|FAIL|AssertionError|Error:|throw/i.test(l))
      .slice(0, 30)
      .join("\n");
    if (dbg) console.log(`[verify] vitest dbg lines:\n${dbg}`);
  }

  let parsed: VitestResult | null = null;
  try {
    const resultsJson = readFileSync(resultsPath, "utf-8");
    parsed = JSON.parse(resultsJson) as VitestResult;
  } catch {
    parsed = parseVitestOutput(vitestResult.stdout);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Main verify function with retry loop
// ---------------------------------------------------------------------------

/** Phase 2: Verify proofs by running generated Vitest tests in a Docker sandbox.
 *  Includes retry loop: failed tests are regenerated with error feedback up to 3 times. */
export async function verifyProofs(
  proofs: Proof[],
  packagePath: string,
  emit?: EmitFn,
  findings?: Finding[],
): Promise<Proof[]> {
  const proofsWithTests = proofs.filter((p) => p.testFile);

  if (proofsWithTests.length === 0) {
    console.log("[verify] no proofs with test files, returning unchanged");
    return proofs;
  }

  console.log(`[verify] verifying ${proofsWithTests.length} proofs with tests`);
  emit?.("verify_started", { totalTests: proofsWithTests.length });

  // 1. Create temp workspace on host
  const workDir = mkdtempSync(join(tmpdir(), "npmguard-verify-"));
  const harnessDir = join(workDir, "harness");
  const generatedDir = join(workDir, "generated");
  const testPkgDir = join(workDir, "test-packages");
  mkdirSync(harnessDir, { recursive: true });
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(testPkgDir, { recursive: true });

  const containerName = `npmguard-verify-${randomUUID().slice(0, 12)}`;
  const timeoutMs = config.verifyTimeoutSec * 1000;
  const packageDirName = basename(packagePath);
  const packageSource = findings ? readPackageSource(packagePath) : "";

  try {
    // Copy all harness files verbatim — runners read PACKAGES_DIR from
    // NPMGUARD_PACKAGES_DIR env var (set on the docker invocation below),
    // so no per-audit code generation is needed.
    for (const file of ["setup.js", "server.js", "sandbox-runner.js", "child-process-runner.js"]) {
      copyFileSync(join(HARNESS_DIR, file), join(harnessDir, file));
    }

    // Write vitest config
    writeFileSync(join(workDir, "vitest.config.js"), VITEST_CONFIG, "utf-8");

    // Copy the package into test-packages/
    execFileSync("cp", ["-r", packagePath, join(testPkgDir, packageDirName)], { timeout: 10_000 });

    // Copy generated test files
    const testFileMap = new Map<string, number>();
    for (let i = 0; i < proofs.length; i++) {
      const proof = proofs[i]!;
      if (!proof.testFile) continue;

      const testFileName = `finding-${i}.test.ts`;
      try {
        copyFileSync(proof.testFile, join(generatedDir, testFileName));
        testFileMap.set(testFileName, i);
      } catch (err) {
        console.error(`[verify] failed to copy test file for proof ${i}: ${err}`);
      }
    }

    if (testFileMap.size === 0) {
      console.log("[verify] no test files could be copied, returning unchanged");
      return proofs;
    }

    // 2. Start Docker container
    const verifyImage = "npmguard-verify";
    const hasVerifyImage = (await dockerExec(["image", "inspect", verifyImage], 5000)).exitCode === 0;
    const image = hasVerifyImage ? verifyImage : config.sandboxImage;
    const network = hasVerifyImage ? "none" : "bridge";

    console.log(`[verify] starting container ${containerName} (image=${image})`);
    const startResult = await dockerExec([
      "run", "-d",
      "--name", containerName,
      `--network=${network}`,
      "--cap-drop=ALL",
      `--memory=${config.sandboxMemoryMb}m`,
      `--cpus=${config.sandboxCpus}`,
      // NOTE: do NOT set --user. Mapping the host's UID (501 on macOS, 1000 on
      // Linux) into the container would point at a UID with no entry in the
      // container's /etc/passwd, causing `os.userInfo()` to throw
      // "uv_os_get_passwd returned ENOENT". Many malware samples call userInfo()
      // at module load time, so the entire setup.js never executes and tests
      // see zero observable behaviour. Run as the image's default user (root
      // for node:22-slim). The other isolation primitives — cap-drop=ALL,
      // network=none, memory cap, pids-limit — are the actual sandbox.
      "--pids-limit", "128",
      "-e", "NPMGUARD_PACKAGES_DIR=/workspace/test-packages",
      "-v", `${workDir}:/workspace`,
      "-w", "/workspace",
      image,
      "sleep", "infinity",
    ], 30_000);

    if (startResult.exitCode !== 0) {
      console.error(`[verify] failed to start container: ${startResult.stderr}`);
      for (let i = 0; i < proofs.length; i++) {
        if (proofs[i]!.testFile) {
          emit?.("verify_test_result", { proofIndex: i, testFile: `finding-${i}.test.ts`, status: "infra_error", error: "container_start_failed" });
        }
      }
      return proofs.map((proof) =>
        proof.testFile ? { ...proof, kind: "TEST_UNCONFIRMED" as const, verifyError: "container_start_failed" } : proof,
      );
    }
    console.log(`[verify] container started`);

    try {
      // 3. Make vitest + msw available
      let depsReady = false;
      if (hasVerifyImage) {
        const symlinkResult = await dockerExec(
          ["exec", containerName, "ln", "-s", "/opt/verify/node_modules", "/workspace/node_modules"],
          10_000,
        );
        if (symlinkResult.exitCode !== 0) {
          console.error(`[verify] symlink failed (exit=${symlinkResult.exitCode}): ${symlinkResult.stderr}`);
        } else {
          depsReady = true;
        }
      }
      if (!depsReady) {
        console.log("[verify] installing vitest and msw (no pre-built image)...");
        const installResult = await dockerExec(
          ["exec", containerName, "sh", "-c", "cd /workspace && npm init -y > /dev/null 2>&1 && npm install --no-save vitest msw 2>&1 | tail -5"],
          timeoutMs,
        );
        if (installResult.exitCode !== 0) {
          console.error(`[verify] npm install failed (exit=${installResult.exitCode}):`);
          console.error(installResult.stderr.slice(0, 500));
          for (let i = 0; i < proofs.length; i++) {
            if (proofs[i]!.testFile) {
              emit?.("verify_test_result", { proofIndex: i, testFile: `finding-${i}.test.ts`, status: "infra_error", error: "npm_install_failed" });
            }
          }
          return proofs.map((proof) =>
            proof.testFile ? { ...proof, kind: "TEST_UNCONFIRMED" as const, verifyError: "npm_install_failed" } : proof,
          );
        }
      }
      console.log("[verify] dependencies ready");

      const npxPath = hasVerifyImage ? "/opt/verify/node_modules/.bin/vitest" : "npx vitest";

      // Track current proof state across retries
      let currentProofs = [...proofs];

      // ── Retry loop ──
      for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        console.log(`\n[verify] ── attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS} ──`);
        emit?.("verify_attempt", { attempt: attempt + 1, maxAttempts: MAX_RETRY_ATTEMPTS });

        // 4. Run vitest
        const parsed = await runVitest(containerName, npxPath, timeoutMs, workDir);

        if (!parsed?.testResults) {
          console.log("[verify] could not parse vitest results");
          if (attempt === MAX_RETRY_ATTEMPTS - 1) {
            for (let i = 0; i < currentProofs.length; i++) {
              if (currentProofs[i]!.testFile && currentProofs[i]!.kind !== "TEST_CONFIRMED") {
                emit?.("verify_test_result", { proofIndex: i, testFile: `finding-${i}.test.ts`, status: "infra_error", error: "results_parse_failed" });
              }
            }
            return currentProofs.map((proof) =>
              proof.testFile && proof.kind !== "TEST_CONFIRMED"
                ? { ...proof, kind: "TEST_UNCONFIRMED" as const, verifyError: "results_parse_failed" }
                : proof,
            );
          }
          continue;
        }

        // 5. Map results and collect failures
        const failedTests: Array<{ proofIndex: number; errorMsg: string }> = [];
        let allPassed = true;

        currentProofs = currentProofs.map((proof, i) => {
          if (!proof.testFile) return proof;
          if (proof.kind === "TEST_CONFIRMED") return proof; // already confirmed

          const testFileName = `finding-${i}.test.ts`;
          const testResult = parsed!.testResults?.find((r) =>
            r.name.includes(testFileName),
          );

          if (testResult?.status === "passed") {
            console.log(`[verify] finding-${i}: PASSED -> TEST_CONFIRMED`);
            emit?.("verify_test_result", { proofIndex: i, testFile: testFileName, status: "confirmed" });
            return {
              ...proof,
              kind: "TEST_CONFIRMED" as const,
              reproducible: true,
              confidence: "CONFIRMED" as const,
            };
          }

          const failureMsg = testResult?.assertionResults
            ?.filter((a) => a.status === "failed")
            ?.flatMap((a) => a.failureMessages ?? [])
            ?.join("\n")
            ?.slice(0, 1000) ?? "Test did not pass (no detailed failure message)";

          console.log(`[verify] finding-${i}: ${testResult?.status ?? "NOT_FOUND"} -> FAILED (attempt ${attempt + 1})`);
          console.log(`[verify] finding-${i} failure message:\n${failureMsg.slice(0, 600)}`);

          allPassed = false;
          failedTests.push({ proofIndex: i, errorMsg: failureMsg });

          return proof;
        });

        if (allPassed) {
          console.log(`[verify] all tests passed on attempt ${attempt + 1}`);
          break;
        }

        if (attempt >= MAX_RETRY_ATTEMPTS - 1) {
          console.log(`[verify] max retries reached, marking remaining as TEST_UNCONFIRMED`);
          currentProofs = currentProofs.map((proof, i) => {
            if (proof.testFile && proof.kind !== "TEST_CONFIRMED") {
              emit?.("verify_test_result", { proofIndex: i, testFile: `finding-${i}.test.ts`, status: "unconfirmed" });
              return { ...proof, kind: "TEST_UNCONFIRMED" as const };
            }
            return proof;
          });
          break;
        }

        // 6. Regenerate failed tests with error feedback
        if (!findings || findings.length === 0) {
          console.log(`[verify] no findings provided for retry, marking as TEST_UNCONFIRMED`);
          currentProofs = currentProofs.map((proof, i) => {
            if (proof.testFile && proof.kind !== "TEST_CONFIRMED") {
              emit?.("verify_test_result", { proofIndex: i, testFile: `finding-${i}.test.ts`, status: "unconfirmed" });
              return { ...proof, kind: "TEST_UNCONFIRMED" as const };
            }
            return proof;
          });
          break;
        }

        console.log(`[verify] regenerating ${failedTests.length} failed tests with error feedback...`);
        emit?.("verify_regenerating", { count: failedTests.length, attempt: attempt + 1 });

        for (const { proofIndex, errorMsg } of failedTests) {
          const proof = currentProofs[proofIndex]!;
          const finding = findings[proofIndex];
          if (!finding || !proof.testCode) continue;

          const newCode = await regenerateTestWithError(
            finding,
            packageDirName,
            packageSource,
            proof.testCode,
            errorMsg,
            attempt + 1,
          );

          if (newCode) {
            const testFileName = `finding-${proofIndex}.test.ts`;
            writeFileSync(join(generatedDir, testFileName), newCode, "utf-8");
            const hash = createHash("sha256").update(newCode).digest("hex");
            currentProofs[proofIndex] = { ...proof, testCode: newCode, testHash: hash };
            console.log(`[verify:retry] updated ${testFileName} (${newCode.length} bytes, hash=${hash.slice(0, 12)})`);
          }
        }
      }

      return currentProofs;
    } finally {
      await dockerExec(["rm", "-f", containerName], 10_000).catch(() => {});
      console.log("[verify] container stopped");
    }
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}
