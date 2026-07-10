import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { generateObject } from "ai";
import { config, SOURCE_FILE_TYPES } from "../config.js";
import { getModel } from "../llm.js";
import { AuditIncompleteError } from "../errors.js";
import { numberLines } from "../util.js";
import type { FileSummary, InventoryReport } from "../models.js";
import type { EmitFn } from "../events.js";
import type { PackageIntent } from "./intent-extraction.js";

// ---------------------------------------------------------------------------
// FLAG — the cheap, high-recall first pass.
//
// A fast model reads every source file WHOLE (plus the package's structural
// facts and stated intent) and points at anything worth a closer look. It does
// NOT classify, rate, or decide malice — it just flags regions, and it is meant
// to over-flag. Each flag is thin: { file, lines, why }. The precise, expensive
// HYPOTHESIZE pass then turns each flag into a runnable experiment.
//
// Two lenses (a flag fires on EITHER):
//   (a) beyond-intent      — a capability/action the stated purpose wouldn't need
//   (b) intrinsic-suspicion — obfuscation, eval/dynamic code, hidden/string-built
//                             URLs or shell, anti-debug, AND gates (time/geo/CI/
//                             inspector) — flagged even if the capability is expected.
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 500_000; // 500KB — files larger than this skip the LLM read

/** A region worth a closer look. Thin by design: FLAG never classifies or rates. */
export interface Flag {
  file: string;
  /** Line range(s) in `file`, e.g. ["12-45"] or ["12-30", "55-80"]. */
  lines: string[];
  /** One-line reason this region was flagged. */
  why: string;
}

export interface FlagOutput {
  flags: Flag[];
  fileSummaries: FileSummary[];
}

// ---------------------------------------------------------------------------
// Per-file response schema
// ---------------------------------------------------------------------------

const FlagDraft = z.object({
  lines: z
    .array(z.string())
    .min(1)
    .describe("Line range(s) in THIS file backing the flag, e.g. ['12-45'] or ['12-30','55-80']."),
  why: z
    .string()
    .describe("One line: why this region is worth a closer look. No classification, no severity."),
});
type FlagDraft = z.infer<typeof FlagDraft>;

const FileFlagResponse = z.object({
  summary: z.string().describe("One sentence describing what this file does."),
  capabilities: z
    .array(z.string())
    .default([])
    .describe("Capability labels this file uses. Used downstream as the aggregate baseline."),
  flags: z
    .array(FlagDraft)
    .default([])
    .describe(
      "Zero or more thin flags. Emit one PER DISTINCT region worth a closer look — either beyond the stated intent, or intrinsically suspicious (obfuscation, eval, hidden URLs, gates) regardless of intent. Over-flagging is expected.",
    ),
});
type FileFlagResponse = z.infer<typeof FileFlagResponse>;

// Enforces the "suspicious ⟹ a flag exists" invariant: a summary that describes
// a clear risk with zero flags is incoherent (nothing to look at) → an audit
// ERROR, never a silent "boring". It never fabricates a flag.
const SUMMARY_CRITICAL_PATTERNS = [
  /\bcredential(?:s)?\s+(?:theft|stealer|harvesting|exfiltration)\b/i,
  /\b(?:steals?|harvests?|exfiltrat(?:es|ed|ing|ion))\b.*\b(?:credentials?|secrets?|tokens?|keys?|env(?:ironment)?|npm|aws|ssh|kube|docker|metadata|imds)\b/i,
  /\b(?:ssh\s+keys?|aws\s+credentials?|npm\s+tokens?|github\s+tokens?|cloud\s+metadata|imds)\b/i,
  /\b(?:malware|trojan|supply\s+chain\s+attack)\b/i,
];

function summaryImpliesCriticalRisk(summary: string): boolean {
  return SUMMARY_CRITICAL_PATTERNS.some((pattern) => pattern.test(summary));
}

// ---------------------------------------------------------------------------
// Prompt (pure)
// ---------------------------------------------------------------------------

export const FLAG_SYSTEM = `You are a fast security triage pass over a SINGLE file from an npm package.
You also know what the package CLAIMS to do. Use that as the baseline for what behavior is "expected".

Your ONLY job is to FLAG regions worth a closer look. You do NOT decide whether anything is malicious, you do NOT classify or rate it, and you do NOT need to be sure — a later, precise pass will RUN each flag to decide.

Flag a region when it shows EITHER:
(a) behavior BEYOND the stated purpose — a capability or action a legitimate implementation of this package would not need (e.g. a CSV parser reading ~/.ssh, an icon library opening a socket); OR
(b) intrinsically-suspicious shape, REGARDLESS of whether the capability is "expected" — obfuscation, encoded/encrypted strings, dynamic code (eval, new Function, dynamic require), string-built URLs or shell commands, anti-debugging, AND gates that make code run only under specific conditions: a date/time check, a geo/IP lookup, a CI environment check, or an inspector/debugger check.

Be OVERZEALOUS. Over-flagging is fine and expected — missing a hidden payload is the only real failure. When unsure, flag it.

Each flag is THIN: the line range(s) in this file, and a one-line reason. Do NOT assign a category, a severity, or a fix.

Return zero flags ONLY for genuinely boring code that does exactly and only what the stated purpose implies.
Emit an accurate capabilities list regardless — it becomes the baseline capability set for the whole package.`;

export function buildFlagPrompt(args: {
  fileName: string;
  contents: string;
  fileFlags: string[];
  intent: PackageIntent;
}): string {
  const { fileName, contents, fileFlags, intent } = args;
  const sections: string[] = [];

  sections.push(
    `## Package intent\n- statedPurpose: ${intent.statedPurpose}\n- expectedCapabilities: ${intent.expectedCapabilities.join(", ") || "(none — treat all capabilities as surprising)"}\n- rationale: ${intent.rationale}`,
  );

  sections.push(`## File: ${fileName}\n\n\`\`\`\n${numberLines(contents)}\n\`\`\``);

  if (fileFlags.length > 0) {
    sections.push(`## Structural facts for this file\n${fileFlags.join("\n")}`);
  }

  sections.push(
    `## Task\nRead the file. Populate summary, capabilities (list), and flags (zero or more thin flags). Line numbers are shown as \`N: line\` — reference them in the flag line ranges.`,
  );

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

async function analyzeFile(args: {
  packagePath: string;
  file: string;
  fileFlags: string[];
  intent: PackageIntent;
  emit?: EmitFn;
}): Promise<{ response: FileFlagResponse; skipped: boolean; reason?: string }> {
  const { packagePath, file, fileFlags, intent, emit } = args;
  const absPath = path.join(packagePath, file);

  let contents: string;
  try {
    contents = fs.readFileSync(absPath, "utf-8");
  } catch {
    return {
      skipped: true,
      reason: "file-unreadable",
      response: { summary: "Could not read file", capabilities: [], flags: [] },
    };
  }

  if (contents.length > MAX_FILE_SIZE) {
    const sizeKB = Math.round(contents.length / 1024);
    // A file too large to read is itself worth a closer look — flag it so
    // HYPOTHESIZE arms a run of it rather than letting it slip unexamined.
    return {
      skipped: true,
      reason: "file-too-large",
      response: {
        summary: `File is ${sizeKB}KB — too large for the FLAG read`,
        capabilities: [],
        flags: [
          {
            lines: ["1-1"],
            why: `File ${file} is ${sizeKB}KB — too large to read statically; needs a dynamic run to inspect.`,
          },
        ],
      },
    };
  }

  if (contents.trim().length === 0) {
    return {
      skipped: true,
      reason: "empty",
      response: { summary: "Empty file", capabilities: [], flags: [] },
    };
  }

  emit?.("file_analyzing", { file });

  const model = getModel(config.triageModel);
  let response: FileFlagResponse;
  try {
    const result = await generateObject({
      model,
      schema: FileFlagResponse,
      system: FLAG_SYSTEM,
      prompt: buildFlagPrompt({ fileName: file, contents, fileFlags, intent }),
    });
    response = result.object;
  } catch (err) {
    throw new AuditIncompleteError("flag", `could not analyze ${file}: model call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // INVARIANT: suspicious ⟹ a flag exists. A summary describing a risk with no
  // flag is incoherent — there is nothing to look at — so it is an audit ERROR,
  // never trusted as "boring" and never fabricated into a flag.
  if (response.flags.length === 0 && summaryImpliesCriticalRisk(response.summary)) {
    throw new AuditIncompleteError(
      "flag",
      `${file}: summary describes a risk but emitted no flag — "${response.summary.slice(0, 160)}"`,
    );
  }
  return { response, skipped: false };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runFlag(
  packagePath: string,
  inventory: InventoryReport,
  intent: PackageIntent,
  emit?: EmitFn,
): Promise<FlagOutput> {
  // Skip files that are pure overhead: .d.ts (no runtime code) and test/spec
  // files (not the published surface). Keep dist/esm bundles — camouflaged
  // malware hides in build output.
  const isFlagNoise = (relPath: string): boolean =>
    /\.d\.ts$/.test(relPath) ||
    /(^|\/)(__tests__|__mocks__)\//.test(relPath) ||
    /\.(test|spec)\.(js|ts|mjs|cjs|tsx|mts)$/.test(relPath);

  const allCandidates = inventory.files.filter(
    (f) => SOURCE_FILE_TYPES.has(f.fileType) && !f.isBinary,
  );
  const sourceFiles = allCandidates.filter((f) => !isFlagNoise(f.path));
  const skippedNoise = allCandidates.length - sourceFiles.length;

  console.log(
    `[flag] scanning ${sourceFiles.length} source files for ${inventory.metadata.name ?? "unknown"}${skippedNoise > 0 ? ` (skipped ${skippedNoise} .d.ts/test files)` : ""} (intent: "${intent.statedPurpose.slice(0, 60)}…")`,
  );

  const flagsByFile = new Map<string, string[]>();
  for (const flag of inventory.flags) {
    if (flag.file) {
      const existing = flagsByFile.get(flag.file) ?? [];
      existing.push(`[${flag.severity}] ${flag.check}: ${flag.detail}`);
      flagsByFile.set(flag.file, existing);
    }
  }

  // Bounded concurrency — override via NPMGUARD_TRIAGE_CONCURRENCY.
  const total = sourceFiles.length;
  const concurrency = Math.max(1, Number(process.env.NPMGUARD_TRIAGE_CONCURRENCY ?? 8));
  let completed = 0;
  const perFile: Array<{ file: string; response: FileFlagResponse }> = new Array(sourceFiles.length);
  let nextIndex = 0;

  // A model failure on any file raises AuditIncompleteError and aborts the pass:
  // the audit cannot complete over a file it could not read.
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= sourceFiles.length) return;
      const f = sourceFiles[i]!;
      const { response, skipped, reason } = await analyzeFile({
        packagePath,
        file: f.path,
        fileFlags: flagsByFile.get(f.path) ?? [],
        intent,
        emit,
      });
      if (!skipped) {
        console.log(
          `[flag] ${f.path} → caps=[${response.capabilities.join(", ") || "none"}] flags=${response.flags.length}`,
        );
      } else {
        console.log(`[flag] ${f.path} → skipped (${reason})`);
      }
      perFile[i] = { file: f.path, response };
      completed++;
      emit?.("triage_progress", { current: completed, total, file: f.path });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, sourceFiles.length) }, () => worker()));

  const flags: Flag[] = [];
  const fileSummaries: FileSummary[] = [];
  for (const { file, response } of perFile) {
    fileSummaries.push({ file, summary: response.summary, capabilities: response.capabilities });
    for (const draft of response.flags) {
      flags.push({ file, lines: draft.lines, why: draft.why });
    }
  }

  console.log(`[flag] emitted ${flags.length} flag(s) across ${fileSummaries.length} files`);

  return { flags, fileSummaries };
}
