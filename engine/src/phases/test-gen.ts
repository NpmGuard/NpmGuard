import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateText } from "ai";

import { config } from "../config.js";
import { getModel } from "../llm.js";
import type { Proof, Finding } from "../models.js";
import type { InvestigationResult } from "./investigate.js";
import {
  TESTGEN_SYSTEM_PROMPT,
  buildTestGenUserPrompt,
} from "./test-gen-prompt.js";
import { readPackageSource, readExampleTest } from "./test-gen-helpers.js";

const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

      // CRITICAL: do NOT run vitest on the host to validate the test. The test
      // calls `runPackage(...)` which does `require(<entryPath>)` on the package,
      // EXECUTING its top-level code outside Docker — including any malware. This
      // is how the Shai-Hulud worm escaped on 2026-04-30, harvesting host creds.
      // Docker verify phase (with retry) is the single execution path.
      console.log(`[test-gen] attempt ${attempt + 1}: ACCEPTED (Docker verify will validate)`);
      return code;
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

  // Limit to top 5 findings to stay within rate limits and time budget.
  // 5 (was 3) lets multi-stage worms get tests on BOTH stages — e.g. Shai-Hulud
  // hits LIFECYCLE_HOOK/PROCESS_SPAWN/NETWORK on stage 1 (setup_bun.js) AND
  // CREDENTIAL_THEFT/ENV_VARS on stage 2 (bun_environment.js). Cap of 3 used to
  // dedup stage 2 out entirely.
  const seen = new Set<string>();
  const selectedFindings: Array<{ index: number; finding: Finding }> = [];
  for (let i = 0; i < investigation.findings.length && selectedFindings.length < 5; i++) {
    const finding = investigation.findings[i]!;
    const cap = finding.capability;
    if (seen.has(cap)) continue; // skip duplicate capabilities
    seen.add(cap);
    selectedFindings.push({ index: i, finding });
  }

  console.log(`[test-gen] generating tests for ${selectedFindings.length}/${investigation.findings.length} findings (deduplicated by capability)`);

  // Staggered parallel: launch one request per second, run concurrently
  const testResultPromises = selectedFindings.map(({ index: i, finding }, j) =>
    sleep(j * 2000).then(async () => {
      console.log(`[test-gen] generating test ${j + 1}/${selectedFindings.length}: ${finding.capability} @ ${finding.fileLine}`);
      const testCode = await generateTestDirect(finding, packageName, packageSource);
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
