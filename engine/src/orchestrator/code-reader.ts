import { z } from "zod";
import { generateObject } from "ai";
import type { EvidenceRef, Hypothesis } from "@npmguard/shared";
import { config } from "../config.js";
import { getModel } from "../llm.js";
import { contentHashOf } from "../evidence/hashing.js";
import { readFileImpl } from "../investigation/tools-read.js";
import { numberLines } from "../util.js";

// ---------------------------------------------------------------------------
// Code-reader — the static worker.
//
// Reads the focus files of a hypothesis and decides whether the suspected
// behavior is actually implemented. Two things it deliberately CANNOT do:
//
//   1. CONFIRM. A static read is not reproduced evidence. Only a RunArtifact
//      (the experimenter) may back a CONFIRMED hypothesis, because only a
//      CONFIRMED hypothesis blocks an install. The strongest "positive" a
//      code-reader may return is INCONCLUSIVE with a loud reason — which lands
//      the claim in UNKNOWN, never a quiet pass.
//
//   2. REFUTE weakly. Clearing a suspicion is a false-negative risk (waving
//      through a payload we merely couldn't see). A refutation is only accepted
//      at medium/high confidence; a low-confidence "looks fine" degrades to
//      INCONCLUSIVE.
//
// It is single-shot (no agent tool-loop) by design: minimal, deterministic,
// cheap. Focus files are already known from triage.
// ---------------------------------------------------------------------------

const MAX_FILE_CHARS = 24_000; // per focus file included in the prompt

const CodeReaderResponse = z.object({
  disposition: z
    .enum(["refuted", "inconclusive"])
    .describe(
      "refuted = the code demonstrably does NOT implement the suspected behavior. " +
        "inconclusive = it might, or you cannot tell without executing it. " +
        "There is no 'confirmed' — static reading cannot confirm.",
    ),
  confidence: z
    .enum(["low", "medium", "high"])
    .describe("How sure you are of the disposition. A refutation needs medium or high to stand."),
  reason: z
    .string()
    .describe("One or two sentences citing concrete code details that justify the disposition."),
  citedLines: z
    .array(z.string())
    .default([])
    .describe("Line references backing the reason, e.g. ['lib/index.js:42-58']."),
});
type CodeReaderResponse = z.infer<typeof CodeReaderResponse>;

export type CodeReaderDisposition = "REFUTED" | "INCONCLUSIVE" | "DEFERRED";

export interface CodeReaderResult {
  disposition: CodeReaderDisposition;
  reason: string;
  /** Present only for REFUTED — a static-kind evidence ref for the reading. */
  evidenceRef: EvidenceRef | null;
  /** Raw structured reading, for audit-log persistence. */
  reading: CodeReaderResponse | null;
}

const SYSTEM = `You are a security analyst statically reviewing suspected-malicious code in an npm package.
You are given one hypothesis about a specific behavior and the code it points at.
Decide whether the code actually implements that behavior.

You CANNOT confirm — you are not running the code. Your options are:
- "refuted": the code clearly does NOT do the suspected thing (e.g. the flagged line is benign, the "obfuscation" is a normal minified bundle of a known library, the "network" call is to a documented endpoint matching the package's stated purpose). Only choose this if you are genuinely confident.
- "inconclusive": the code might do it, is ambiguous, is gated behind a condition you can't evaluate statically, or you simply cannot be sure without executing it.

Bias: when unsure, choose "inconclusive". Never refute a real risk to make the graph look clean.`;

function buildPrompt(hypothesis: Hypothesis, files: Array<{ file: string; content: string }>): string {
  const focus = hypothesis.focusLines
    .map((fl) => `${fl.file}:${fl.range}`)
    .join(", ");
  const sections: string[] = [];
  sections.push(
    `## Hypothesis ${hypothesis.hypId}\n` +
      `- claim: ${hypothesis.claim.kind}${hypothesis.claim.gating ? ` (gated: ${hypothesis.claim.gating})` : ""}\n` +
      `- severity: ${hypothesis.severity}\n` +
      `- description: ${hypothesis.description}\n` +
      `- focus: ${focus || hypothesis.focusFiles.join(", ")}`,
  );
  for (const { file, content } of files) {
    sections.push(`## File: ${file}\n\n\`\`\`\n${numberLines(content)}\n\`\`\``);
  }
  sections.push(
    `## Task\nDecide the disposition for hypothesis ${hypothesis.hypId}. Line numbers are shown as \`N: line\`; cite them in citedLines.`,
  );
  return sections.join("\n\n");
}

/**
 * Statically resolve a single hypothesis. Returns a terminal disposition:
 *  - REFUTED (with a static evidence ref) when the code demonstrably does not
 *    implement the claim and the model is confident.
 *  - INCONCLUSIVE when it can't be cleared or the refutation is weak.
 *  - DEFERRED when the focus files can't be read or the model call fails.
 */
export async function runCodeReader(
  hypothesis: Hypothesis,
  packagePath: string,
): Promise<CodeReaderResult> {
  // Gather focus file contents (bounded). If none is readable, we can't analyze.
  const files: Array<{ file: string; content: string }> = [];
  for (const file of hypothesis.focusFiles) {
    const content = readFileImpl(packagePath, file);
    if (content.startsWith("ERROR:")) continue;
    files.push({ file, content: content.slice(0, MAX_FILE_CHARS) });
  }

  if (files.length === 0) {
    return {
      disposition: "DEFERRED",
      reason: `Code-reader could not read any focus file (${hypothesis.focusFiles.join(", ") || "none"}).`,
      evidenceRef: null,
      reading: null,
    };
  }

  let reading: CodeReaderResponse;
  try {
    const result = await generateObject({
      model: getModel(config.triageModel),
      schema: CodeReaderResponse,
      system: SYSTEM,
      prompt: buildPrompt(hypothesis, files),
    });
    reading = result.object;
  } catch (err) {
    return {
      disposition: "DEFERRED",
      reason: `Code-reader model call failed: ${err instanceof Error ? err.message : String(err)}`,
      evidenceRef: null,
      reading: null,
    };
  }

  // A refutation only stands at medium/high confidence — a weak "looks fine"
  // must not clear a suspicion (false-negative aversion).
  if (reading.disposition === "refuted" && reading.confidence !== "low") {
    const evidenceRef: EvidenceRef = {
      kind: "static",
      id: `codereader_${hypothesis.hypId}`,
      hash: contentHashOf({
        hypId: hypothesis.hypId,
        disposition: reading.disposition,
        confidence: reading.confidence,
        reason: reading.reason,
        citedLines: reading.citedLines,
      }),
    };
    return { disposition: "REFUTED", reason: reading.reason, evidenceRef, reading };
  }

  const weakRefute =
    reading.disposition === "refuted" && reading.confidence === "low"
      ? " (low-confidence refutation held back — treated as inconclusive)"
      : "";
  return {
    disposition: "INCONCLUSIVE",
    reason: reading.reason + weakRefute,
    evidenceRef: null,
    reading,
  };
}
