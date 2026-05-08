import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
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
// REMOVED: validateTestWithVitest()
//
// This function ran `npx vitest run` on the host with the LLM-generated test
// code, which imports the audited package. For malicious packages (anything
// from the bench: `test-pkg-bench-dd-*`), module-load code executed with root
// privileges on the HOST, outside the Docker sandbox.
//
// Confirmed exploit: on 2026-05-08 13:38 UTC, a malicious_intent fixture
// (`test-pkg-bench-dd-m-*`) wiped /root/.ssh/authorized_keys via this path,
// locking us out of the server.
//
// All test execution must happen inside Docker (verify.ts). No exceptions.
// ---------------------------------------------------------------------------


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

      // CRITICAL: never run vitest on the host. validateTestWithVitest()
      // executed `npx vitest run` on test code that imports the audited
      // package, which means the package's module-load code ran with root
      // privileges on the host. Bench fixtures (`test-pkg-bench-dd-m-*`)
      // are malicious-intent packages from the Datadog corpus — when this
      // path was active, they wiped /root/.ssh/authorized_keys at audit
      // time. The Docker verify phase already runs tests in a sandbox with
      // 3 retries; that's the only safe place to execute LLM-generated tests.
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
