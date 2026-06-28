import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { generateObject } from "ai";
import { config, SOURCE_FILE_TYPES } from "../config.js";
import { getModel } from "../llm.js";
import type { InventoryReport } from "../models.js";
import {
  ClaimKind,
  GatingModifier,
  HypothesisSeverity,
  type Hypothesis,
} from "@npmguard/shared";
import type { EmitFn } from "../events.js";
import type { PackageIntent } from "./intent-extraction.js";

const MAX_FILE_SIZE = 500_000; // 500KB — files larger than this skip LLM

// ---------------------------------------------------------------------------
// MAP output schema — what a per-file analysis emits
// ---------------------------------------------------------------------------

/**
 * A hypothesis draft emitted by per-file MAP. Subset of full Hypothesis:
 * the MAP cannot assign hypIds, timestamps, or graph-wide fields. The
 * triage wrapper converts drafts into fully-formed Hypothesis nodes.
 */
const HypothesisDraft = z.object({
  description: z
    .string()
    .describe(
      "One-line description of the suspected behavior, e.g. 'reads ~/.npmrc and POSTs it to an obfuscated URL'. Used verbatim for dedup downstream.",
    ),
  claim: z.object({
    kind: ClaimKind,
    gating: GatingModifier.nullable().default(null),
  }),
  severity: HypothesisSeverity,
  rangesInFile: z
    .array(z.string())
    .describe(
      "Line ranges in the CURRENT file backing this hypothesis (e.g. '12-45' or '12-30,55-80'). At least one range.",
    )
    .min(1),
});
type HypothesisDraft = z.infer<typeof HypothesisDraft>;

const FileAnalysisResponse = z.object({
  summary: z
    .string()
    .describe("One sentence describing what this file does."),
  capabilities: z
    .array(z.string())
    .default([])
    .describe(
      "Capability labels this file uses (subset of CapabilityEnum; extra labels acceptable). Used downstream as aggregate baseline.",
    ),
  hypotheses: z
    .array(HypothesisDraft)
    .default([])
    .describe(
      "Zero or more hypotheses. Emit one PER DISTINCT suspected behavior. Do NOT emit a hypothesis for expected capabilities listed in the intent — only for things that don't fit the stated purpose, or for independently-suspicious patterns (obfuscation, dynamic code eval, hidden URLs, etc.) regardless of whether the capability is expected.",
    ),
});
type FileAnalysisResponse = z.infer<typeof FileAnalysisResponse>;

// ---------------------------------------------------------------------------
// Public return shape
// ---------------------------------------------------------------------------

export interface FileSummary {
  file: string;
  summary: string;
  capabilities: string[];
}

export interface TriageOutput {
  hypotheses: Hypothesis[];
  fileSummaries: FileSummary[];
}

type TriageFileCandidate = InventoryReport["files"][number];

// ---------------------------------------------------------------------------
// Prompt builders (pure)
// ---------------------------------------------------------------------------

export const MAP_SYSTEM = `You are a security analyst examining a single file from an npm package.
You also know what the package CLAIMS to do — use that as the baseline for what behavior is "expected".

Your job: emit hypotheses about behaviors that either (a) exceed the stated purpose, or (b) look intrinsically suspicious.

For EACH hypothesis emitted:
- description: one clear sentence about the suspected behavior. Reference concrete code details — don't be generic.
- claim.kind: pick the best match from the ClaimKind enum. If nothing fits well, pick the nearest and explain in the description.
- claim.gating: only set if the code obviously runs differently under a specific condition (CI env var, geo lookup, date check, inspector detection).
- severity: low (cosmetic/unlikely), medium (plausibly harmful), high (clearly harmful if triggered), critical (unambiguous credential theft, remote exec, destructive op).
- rangesInFile: line ranges in THIS FILE only, e.g. ["42-67"] or ["12-30", "55-80"]. At least one range.

Emit a hypothesis when the file:
- Uses a capability NOT in the intent's expectedCapabilities (capability mismatch).
- Contains obfuscation, encoded/encrypted strings, dynamic require, eval chains, string-built URLs or shell commands, anti-debugging, minified-yet-logic-bearing code — regardless of whether the capability is "expected".
- Accesses credentials, tokens, or filesystem paths outside the package directory.
- Spawns processes, writes binaries, or modifies system state during install.

Do NOT emit a hypothesis for straightforward, expected behavior. If a package is documented as an HTTP client, do not flag HTTP calls as mismatches — only flag HTTP to unexpected destinations or with suspicious shapes.

Return zero hypotheses if the file is boring utility code.
Emit an accurate capabilities list regardless — it becomes the baseline for the whole-package capability set.`;

export function buildMapPrompt(args: {
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
    sections.push(`## Structural flags for this file\n${fileFlags.join("\n")}`);
  }

  sections.push(
    `## Task\nAnalyze the file. Populate summary, capabilities (list), and hypotheses (zero or more). Line numbers are shown as \`N: line\` — reference them in rangesInFile.`,
  );

  return sections.join("\n\n");
}

function numberLines(contents: string): string {
  return contents
    .split("\n")
    .map((line, i) => `${i + 1}: ${line}`)
    .join("\n");
}

function entryPointScore(file: string, inventory: InventoryReport): number {
  const entryPoints = [
    ...inventory.entryPoints.install,
    ...inventory.entryPoints.runtime,
    ...inventory.entryPoints.bin,
  ];
  if (entryPoints.includes(file)) return 100;
  if (file === "package.json") return 90;
  if (/^(index|main)\.(js|ts|mjs|cjs)$/.test(file)) return 80;
  if (/^(dist|lib|src)\//.test(file)) return 20;
  return 0;
}

export function selectTriageFiles(args: {
  files: TriageFileCandidate[];
  inventory: InventoryReport;
  flagsByFile: Map<string, string[]>;
  maxFiles: number;
}): TriageFileCandidate[] {
  const { files, inventory, flagsByFile, maxFiles } = args;
  if (files.length <= maxFiles) return files;

  return [...files]
    .map((file, index) => {
      const flagged = flagsByFile.has(file.path) ? 1 : 0;
      const score =
        flagged * 1000 +
        entryPointScore(file.path, inventory) +
        Math.max(0, 20 - Math.floor(file.sizeBytes / 10_000));
      return { file, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, maxFiles)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.file);
}

// ---------------------------------------------------------------------------
// Draft → Hypothesis (pure)
// ---------------------------------------------------------------------------

export function draftToHypothesis(args: {
  draft: HypothesisDraft;
  file: string;
  hypId: string;
  now: string;
}): Hypothesis {
  const { draft, file, hypId, now } = args;
  return {
    hypId,
    description: draft.description,
    claim: {
      kind: draft.claim.kind,
      gating: draft.claim.gating ?? null,
    },
    focusFiles: [file],
    focusLines: draft.rangesInFile.map((range) => ({ file, range })),
    severity: draft.severity,
    parentHypId: null,
    childHypIds: [],
    state: "OPEN",
    createdBy: "triage",
    evidenceRefs: [],
    createdAt: now,
    resolvedAt: null,
    resolution: null,
  };
}

function scriptLooksLikeNetworkExfil(script: string): boolean {
  return /\b(curl|wget|Invoke-WebRequest|iwr|fetch|nc|netcat)\b/i.test(script) &&
    /(https?:\/\/|webhook\.site|oast\.|burpcollaborator|interact\.sh|requestbin|\.xyz\b)/i.test(script);
}

function scriptCapturesHostData(script: string): boolean {
  return /\$\((?:hostname|whoami|pwd|id|uname|date)\b/i.test(script) ||
    /\$(?:PWD|HOME|USER|USERNAME|HOSTNAME|COMPUTERNAME|npm_config_[A-Z0-9_]+)/i.test(script) ||
    /%(?:USERNAME|COMPUTERNAME|CD|TIME)%/i.test(script) ||
    /\b(process\.env|env\b|printenv\b|\.npmrc|NPM_TOKEN|AWS_|GITHUB_TOKEN)\b/i.test(script);
}

function packageJsonLineForScript(packagePath: string, hook: string): string {
  try {
    const contents = fs.readFileSync(path.join(packagePath, "package.json"), "utf-8");
    const lines = contents.split("\n");
    const idx = lines.findIndex((line) => line.includes(`"${hook}"`) || line.includes(`'${hook}'`));
    return idx >= 0 ? String(idx + 1) : "1";
  } catch {
    return "1";
  }
}

export function synthesizeInventoryHypotheses(args: {
  packagePath: string;
  inventory: InventoryReport;
  now: string;
  startCounter: number;
}): Hypothesis[] {
  const { packagePath, inventory, now } = args;
  let counter = args.startCounter;
  const hypotheses: Hypothesis[] = [];

  for (const flag of inventory.flags) {
    if (flag.check === "non-node-script") {
      const match = /^Lifecycle script '([^']+)' is not a node command: (.+)$/.exec(flag.detail);
      if (!match) continue;
      const [, hook, script] = match;
      if (!hook || !script || !scriptLooksLikeNetworkExfil(script)) continue;

      counter += 1;
      const capturesHostData = scriptCapturesHostData(script);
      const claim = capturesHostData ? "env_exfil" : "telemetry";
      const range = packageJsonLineForScript(packagePath, hook);
      hypotheses.push({
        hypId: `trg-${counter.toString().padStart(4, "0")}`,
        description:
          `Lifecycle script '${hook}' runs a shell network command during install: ${script}`,
        claim: { kind: claim, gating: null },
        focusFiles: ["package.json"],
        focusLines: [{ file: "package.json", range }],
        severity: capturesHostData ? "critical" : "high",
        parentHypId: null,
        childHypIds: [],
        state: "OPEN",
        createdBy: "inventory",
        evidenceRefs: [],
        createdAt: now,
        resolvedAt: null,
        resolution: null,
      });
    } else if (flag.check === "dependency-url" && /\buses URL specifier: http:\/\//i.test(flag.detail)) {
      counter += 1;
      hypotheses.push({
        hypId: `trg-${counter.toString().padStart(4, "0")}`,
        description:
          `Package manifest declares an HTTP dependency URL outside the npm registry: ${flag.detail}`,
        claim: { kind: "binary_drop", gating: null },
        focusFiles: ["package.json"],
        focusLines: [{ file: "package.json", range: "1" }],
        severity: "high",
        parentHypId: null,
        childHypIds: [],
        state: "OPEN",
        createdBy: "inventory",
        evidenceRefs: [],
        createdAt: now,
        resolvedAt: null,
        resolution: null,
      });
    }
  }

  return hypotheses;
}

// ---------------------------------------------------------------------------
// MAP: per-file analysis
// ---------------------------------------------------------------------------

async function analyzeFile(args: {
  packagePath: string;
  file: string;
  fileFlags: string[];
  intent: PackageIntent;
  emit?: EmitFn;
}): Promise<{ response: FileAnalysisResponse; skipped: boolean; reason?: string }> {
  const { packagePath, file, fileFlags, intent, emit } = args;
  const absPath = path.join(packagePath, file);

  let contents: string;
  try {
    contents = fs.readFileSync(absPath, "utf-8");
  } catch {
    return {
      skipped: true,
      reason: "file-unreadable",
      response: { summary: "Could not read file", capabilities: [], hypotheses: [] },
    };
  }

  if (contents.length > MAX_FILE_SIZE) {
    const sizeKB = Math.round(contents.length / 1024);
    // >5MB single-file source in a published package is anomalous and
    // strongly correlates with bundled malware (bun_environment.js,
    // Shai-Hulud worm payloads, etc.). Bump severity above the borderline.
    const severity = sizeKB > 5000 ? "high" : "medium";
    return {
      skipped: true,
      reason: "file-too-large",
      response: {
        summary: `File is ${sizeKB}KB — too large for triage analysis`,
        capabilities: [],
        hypotheses: [
          {
            description: `File ${file} is ${sizeKB}KB — too large for LLM triage; manual or dynamic inspection required.`,
            claim: { kind: "obfuscation", gating: null },
            severity,
            rangesInFile: ["1-1"],
          },
        ],
      },
    };
  }

  if (contents.trim().length === 0) {
    return {
      skipped: true,
      reason: "empty",
      response: { summary: "Empty file", capabilities: [], hypotheses: [] },
    };
  }

  emit?.("file_analyzing", { file });

  const model = getModel(config.triageModel);
  const result = await generateObject({
    model,
    schema: FileAnalysisResponse,
    system: MAP_SYSTEM,
    prompt: buildMapPrompt({ fileName: file, contents, fileFlags, intent }),
    timeout: config.llmTimeoutSeconds * 1000,
    maxRetries: 1,
  });

  return { response: result.object, skipped: false };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runTriage(
  packagePath: string,
  inventory: InventoryReport,
  intent: PackageIntent,
  emit?: EmitFn,
): Promise<TriageOutput> {
  // Skip files that are pure overhead for triage:
  //   - .d.ts: TypeScript declarations carry no runtime code
  //   - test/spec files: not the package's published surface
  // We DO keep dist/, esm*/, fesm*/ since camouflaged packages embed
  // malware in build output (e.g. ngx-trend's bundle.js).
  const isTriageNoise = (relPath: string): boolean =>
    /\.d\.ts$/.test(relPath) ||
    /(^|\/)(__tests__|__mocks__)\//.test(relPath) ||
    /\.(test|spec)\.(js|ts|mjs|cjs|tsx|mts)$/.test(relPath);

  const allCandidates = inventory.files.filter(
    (f) => SOURCE_FILE_TYPES.has(f.fileType) && !f.isBinary,
  );
  const sourceFileCandidates = allCandidates.filter((f) => !isTriageNoise(f.path));
  const skippedNoise = allCandidates.length - sourceFileCandidates.length;

  const flagsByFile = new Map<string, string[]>();
  for (const flag of inventory.flags) {
    if (flag.file) {
      const existing = flagsByFile.get(flag.file) ?? [];
      existing.push(`[${flag.severity}] ${flag.check}: ${flag.detail}`);
      flagsByFile.set(flag.file, existing);
    }
  }

  const sourceFiles = selectTriageFiles({
    files: sourceFileCandidates,
    inventory,
    flagsByFile,
    maxFiles: config.triageMaxFiles,
  });
  const skippedByCap = sourceFileCandidates.length - sourceFiles.length;

  console.log(
    `[triage] analyzing ${sourceFiles.length}/${sourceFileCandidates.length} source files for ${inventory.metadata.name ?? "unknown"}` +
      `${skippedNoise > 0 ? ` (skipped ${skippedNoise} .d.ts/test files)` : ""}` +
      `${skippedByCap > 0 ? ` (capped ${skippedByCap} low-priority files)` : ""}` +
      ` (intent: "${intent.statedPurpose.slice(0, 60)}…")`,
  );

  // Bounded concurrency. Unbounded Promise.all hammered MiniMax's Token
  // Plan rate limit on packages with 100+ files (every triage call would
  // 429 + retry × 3 → fail, surfacing as "polling timed out" in bench v3).
  // 8 in flight fits the Token Plan; override via NPMGUARD_TRIAGE_CONCURRENCY
  // for pay-as-you-go tiers.
  const total = sourceFiles.length;
  const concurrency = Math.max(
    1,
    Number(process.env.NPMGUARD_TRIAGE_CONCURRENCY ?? 8),
  );
  let completed = 0;
  const perFile: Array<{ file: string; response: FileAnalysisResponse }> = new Array(sourceFiles.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= sourceFiles.length) return;
      const f = sourceFiles[i]!;
      try {
        const { response, skipped, reason } = await analyzeFile({
          packagePath,
          file: f.path,
          fileFlags: flagsByFile.get(f.path) ?? [],
          intent,
          emit,
        });
        if (!skipped) {
          console.log(
            `[triage:map] ${f.path} → caps=[${response.capabilities.join(", ") || "none"}] hyps=${response.hypotheses.length}`,
          );
        } else {
          console.log(`[triage:map] ${f.path} → skipped (${reason})`);
        }
        perFile[i] = { file: f.path, response };
      } catch (err) {
        console.error(
          `[triage:map] failed for ${f.path}: ${err instanceof Error ? err.message : err}`,
        );
        perFile[i] = {
          file: f.path,
          response: {
            summary: `Analysis failed: ${err instanceof Error ? err.message : "unknown error"}`,
            capabilities: [],
            hypotheses: [
              {
                description: `Triage MAP failed on ${f.path}; file may contain material worth inspecting manually.`,
                claim: { kind: "obfuscation" as const, gating: null },
                severity: "medium" as const,
                rangesInFile: ["1-1"],
              },
            ],
          } satisfies FileAnalysisResponse,
        };
      }
      completed++;
      emit?.("triage_progress", { current: completed, total, file: f.path });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sourceFiles.length) }, () => worker()));

  const now = new Date().toISOString();
  const hypotheses: Hypothesis[] = [];
  const fileSummaries: FileSummary[] = [];
  let counter = 0;

  for (const { file, response } of perFile) {
    fileSummaries.push({
      file,
      summary: response.summary,
      capabilities: response.capabilities,
    });
    for (const draft of response.hypotheses) {
      counter += 1;
      const hypId = `trg-${counter.toString().padStart(4, "0")}`;
      const hyp = draftToHypothesis({ draft, file, hypId, now });
      hypotheses.push(hyp);
      emit?.("hypothesis_emitted", {
        hypId: hyp.hypId,
        claim: hyp.claim.kind,
        severity: hyp.severity,
        file,
      });
    }
  }

  const inventoryHypotheses = synthesizeInventoryHypotheses({
    packagePath,
    inventory,
    now,
    startCounter: counter,
  });
  if (inventoryHypotheses.length > 0) {
    hypotheses.push(...inventoryHypotheses);
    fileSummaries.push({
      file: "package.json",
      summary: "Package manifest contains suspicious lifecycle script behavior.",
      capabilities: ["LIFECYCLE_HOOK", "NETWORK", "ENV_VARS", "BINARY_DOWNLOAD"],
    });
    for (const hyp of inventoryHypotheses) {
      emit?.("hypothesis_emitted", {
        hypId: hyp.hypId,
        claim: hyp.claim.kind,
        severity: hyp.severity,
        file: "package.json",
      });
    }
  }

  console.log(
    `[triage] emitted ${hypotheses.length} hypotheses across ${fileSummaries.length} files`,
  );

  return { hypotheses, fileSummaries };
}
