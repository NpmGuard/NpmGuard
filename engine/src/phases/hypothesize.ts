import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { generateObject } from "ai";
import type { Hypothesis, ToolCall } from "@npmguard/shared";
import { config } from "../config.js";
import { getModel } from "../llm.js";
import { numberLines } from "../util.js";
import {
  renderToolCatalog,
  compileExperiment,
  ExperimentCompileError,
} from "../sandbox/tools.js";
import type { EntryPoints } from "../models.js";
import type { EmitFn } from "../events.js";
import type { PackageIntent } from "./intent-extraction.js";

// ---------------------------------------------------------------------------
// HYPOTHESIZE — turn a flagged suspicion into a runnable EXPERIMENT.
//
// The smart pass. For each hypothesis, it composes an `experiment: ToolCall[]`
// from the shared tool registry (sandbox/tools.ts) whose job is to MAKE THE
// SUSPECTED PAYLOAD FIRE: plant the bait a payload would steal, defeat any gate
// the flag spotted (time / geo / CI / anti-debug), and trigger the right entry
// point — exactly once. The experiment then runs under the full oracle and the
// judge decides from the timeline.
//
// Founding rule: a suspicion is cleared only by RUNNING it. So there is no
// benign-dismiss branch here — HYPOTHESIZE either produces a testable
// experiment or it produces nothing (an empty experiment), and an empty
// experiment is a coverage gap the pipeline must resolve some other way, never
// a silent "looks fine". It never emits a "this is safe" verdict.
// ---------------------------------------------------------------------------

/** Per-focus-file code budget handed to the model. Obfuscated one-liners count
 *  as a single very long line; the cap keeps a 10MB bundle from blowing the
 *  context while still showing the model the flagged region. */
const MAX_FOCUS_CHARS = 40_000;

/** Suggested canary the model should plant as bait, so timelines are consistent
 *  and a real exfil has a concrete secret to read. Not load-bearing for the
 *  judge (which reasons from reads + outbound sends), just a sane default. */
export const SUGGESTED_CANARY = "NPMGUARD_CANARY_TOKEN_f8e2d91a";

export interface HypothesizeContext {
  packagePath: string;
  intent: PackageIntent;
  entryPoints: EntryPoints;
  emit?: EmitFn;
}

/** The experiment HYPOTHESIZE composed for one hypothesis (empty if it could
 *  not form a testable one). */
export interface HypothesisExperiment {
  hypId: string;
  experiment: ToolCall[];
}

export interface HypothesizeOutput {
  experiments: HypothesisExperiment[];
  /** Hypotheses HYPOTHESIZE could not turn into a runnable experiment — an
   *  honest gap (model failure or a threat the sandbox can't exercise), never
   *  masked as "benign". */
  failures: Array<{ hypId: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Model output schema
// ---------------------------------------------------------------------------

const ToolCallDraft = z.object({
  tool: z.string().describe("Name of a tool from the catalog (exact match)."),
  args: z
    .record(z.unknown())
    .default({})
    .describe("Arguments for the tool, matching its documented parameters."),
});

const ExperimentResponse = z.object({
  reasoning: z
    .string()
    .describe(
      "One or two sentences: how this experiment makes the suspected payload fire, including any gate you defeat and why the trigger reaches the code.",
    ),
  experiment: z
    .array(ToolCallDraft)
    .min(1)
    .describe(
      "Ordered tool calls: setup calls first (plant bait, defeat gates), then EXACTLY ONE `trigger` call that runs the suspected code.",
    ),
});
export type ExperimentResponse = z.infer<typeof ExperimentResponse>;

// ---------------------------------------------------------------------------
// Prompt (pure)
// ---------------------------------------------------------------------------

export const HYPOTHESIZE_SYSTEM = `You are a security analyst designing an EXPERIMENT to test one hypothesis about an npm package.

You are given a suspected behavior (the hypothesis), the code it points at, what the package is supposed to do, and a catalog of tools you can use to set up and trigger a sandboxed run. Your job is to compose the tool calls that would MAKE THE SUSPECTED PAYLOAD ACTUALLY FIRE, so a downstream judge can watch it happen under full instrumentation.

Design the experiment to trigger the payload, not to avoid it:
- Plant the bait the payload would go after — fake credentials in the environment (setEnv: NPM_TOKEN, AWS_ACCESS_KEY_ID) and on disk (plantFiles: /home/node/.npmrc, /home/node/.ssh/id_rsa, /home/node/.aws/credentials). Absolute container paths only.
- DEFEAT any gate the hypothesis mentions so the guarded branch runs: a time gate → setDate past the trigger date; a CI gate → setEnv CI=true; an anti-debug/inspector or other hard check → patchFile to neutralize it or force the branch.
- Make staged fetches succeed if the payload needs a second stage — stubUrl to return a canned response.
- End with EXACTLY ONE trigger call naming the entry point most likely to reach the code (an install lifecycle file for install-time payloads, the runtime entry otherwise). Prefer a file listed in the hypothesis's focus or the package's entry points.

Rules:
- Use ONLY tools from the catalog, with arguments matching their documented parameters. An unknown tool or bad arguments makes the whole experiment invalid.
- The experiment MUST contain exactly one trigger call.
- You are NOT deciding whether the package is malicious — only how to run it so the behavior would show if it is there. Never refuse to design an experiment because the code "looks fine"; if a payload is gated or hidden, your job is to defeat the gate and trigger it anyway.`;

export function buildHypothesizePrompt(args: {
  hypothesis: Hypothesis;
  focusCode: string;
  intent: PackageIntent;
  entryPoints: EntryPoints;
}): string {
  const { hypothesis: h, focusCode, intent, entryPoints } = args;
  const focus =
    h.focusLines.map((fl) => `${fl.file}:${fl.range}`).join(", ") ||
    h.focusFiles.join(", ") ||
    "(unspecified)";

  const sections: string[] = [];

  sections.push(
    `## Package intent (benign baseline)\n` +
      `- statedPurpose: ${intent.statedPurpose}\n` +
      `- expectedCapabilities: ${intent.expectedCapabilities.join(", ") || "(none)"}`,
  );

  sections.push(
    `## Hypothesis ${h.hypId}\n` +
      `- claim: ${h.claim.kind}${h.claim.gating ? ` (gated: ${h.claim.gating} — you must defeat this gate)` : ""}\n` +
      `- severity: ${h.severity}\n` +
      `- description: ${h.description}\n` +
      `- suspected code: ${focus}`,
  );

  sections.push(
    `## Entry points (candidate trigger targets)\n` +
      `- install (lifecycle): ${entryPoints.install.join(", ") || "(none)"}\n` +
      `- runtime: ${entryPoints.runtime.join(", ") || "(none)"}\n` +
      `- bin: ${entryPoints.bin.join(", ") || "(none)"}`,
  );

  sections.push(`## Suspected code\n${focusCode || "(source unavailable)"}`);

  sections.push(
    `## Available tools\n${renderToolCatalog()}\n\n` +
      `Suggested bait canary value: ${SUGGESTED_CANARY}`,
  );

  sections.push(
    `## Task\nCompose the ordered tool calls (setup, then exactly one trigger) that would make the suspected behavior fire in the sandbox. Explain your reasoning briefly.`,
  );

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Focus code extraction (pure)
// ---------------------------------------------------------------------------

/**
 * Read the code the hypothesis points at. Prefers the focus files; falls back
 * to files named only in focusLines. Each file is line-numbered (so the model's
 * reasoning can reference the flagged ranges) and capped so a giant bundle
 * cannot blow the context window.
 */
export function readFocusCode(packagePath: string, h: Hypothesis): string {
  const rangesByFile = new Map<string, string[]>();
  for (const fl of h.focusLines) {
    const list = rangesByFile.get(fl.file) ?? [];
    list.push(fl.range);
    rangesByFile.set(fl.file, list);
  }

  const files =
    h.focusFiles.length > 0 ? h.focusFiles : Array.from(rangesByFile.keys());

  const parts: string[] = [];
  for (const file of files) {
    let contents: string;
    try {
      contents = fs.readFileSync(path.join(packagePath, file), "utf-8");
    } catch {
      continue;
    }
    const capped =
      contents.length > MAX_FOCUS_CHARS
        ? contents.slice(0, MAX_FOCUS_CHARS) + "\n… (truncated)"
        : contents;
    const ranges = rangesByFile.get(file);
    const header = ranges && ranges.length > 0 ? `${file} (flagged lines ${ranges.join(", ")})` : file;
    parts.push(`### ${header}\n\`\`\`\n${numberLines(capped)}\n\`\`\``);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Experiment validation (pure) — the registry is the one contract
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true; experiment: ToolCall[] }
  | { ok: false; error: string };

/**
 * Validate a model-proposed experiment against the shared tool registry. A
 * ToolCall[] that compiles is a coherent experiment; anything else (unknown
 * tool, bad args, zero or many triggers) is rejected with the registry's own
 * error message so a retry can be specific. Never silently drops a bad call.
 */
export function validateExperiment(calls: ToolCall[]): ValidateResult {
  try {
    compileExperiment(calls);
    return { ok: true, experiment: calls };
  } catch (err) {
    if (err instanceof ExperimentCompileError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-hypothesis experiment generation
// ---------------------------------------------------------------------------

/**
 * Compose and validate the experiment for one hypothesis. One retry: if the
 * first attempt does not compile against the registry, we hand the model its
 * own error and ask again. Returns null (a coverage gap) only after both the
 * model and the retry fail — never a fabricated or empty-but-"fine" experiment.
 */
async function experimentForHypothesis(
  h: Hypothesis,
  ctx: HypothesizeContext,
): Promise<{ experiment: ToolCall[] } | { error: string }> {
  const focusCode = readFocusCode(ctx.packagePath, h);
  const basePrompt = buildHypothesizePrompt({
    hypothesis: h,
    focusCode,
    intent: ctx.intent,
    entryPoints: ctx.entryPoints,
  });

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? basePrompt
        : `${basePrompt}\n\n## Your previous attempt was invalid\n${lastError}\nFix it: use only catalog tools with correct arguments and exactly one trigger.`;

    let response: ExperimentResponse;
    try {
      const result = await generateObject({
        model: getModel(config.investigationModel),
        schema: ExperimentResponse,
        system: HYPOTHESIZE_SYSTEM,
        prompt,
      });
      response = result.object;
    } catch (err) {
      lastError = `model call failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    const validated = validateExperiment(response.experiment as ToolCall[]);
    if (validated.ok) {
      return { experiment: validated.experiment };
    }
    lastError = validated.error;
    console.warn(`[hypothesize] ${h.hypId} attempt ${attempt + 1} invalid: ${lastError}`);
  }

  return { error: lastError };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compose a runnable experiment for each hypothesis. Bounded concurrency mirrors
 * triage — the smart model is the cost center, so cap in-flight calls. The
 * returned experiments are applied to the graph nodes by the pipeline; failures
 * are surfaced as an explicit coverage gap, never as a clean result.
 */
export async function runHypothesize(
  nodes: Hypothesis[],
  ctx: HypothesizeContext,
): Promise<HypothesizeOutput> {
  const concurrency = Math.max(1, Number(process.env.NPMGUARD_TRIAGE_CONCURRENCY ?? 8));
  console.log(`[hypothesize] composing experiments for ${nodes.length} hypothesis node(s)`);

  const experiments: HypothesisExperiment[] = new Array(nodes.length);
  const failures: Array<{ hypId: string; error: string }> = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= nodes.length) return;
      const h = nodes[i]!;
      ctx.emit?.("hypothesize_progress", { hypId: h.hypId, current: i + 1, total: nodes.length });
      const outcome = await experimentForHypothesis(h, ctx);
      if ("experiment" in outcome) {
        console.log(
          `[hypothesize] ${h.hypId} (${h.claim.kind}) → ${outcome.experiment.length} tool call(s)`,
        );
        experiments[i] = { hypId: h.hypId, experiment: outcome.experiment };
      } else {
        console.warn(`[hypothesize] ${h.hypId} → NO experiment (coverage gap): ${outcome.error}`);
        experiments[i] = { hypId: h.hypId, experiment: [] };
        failures.push({ hypId: h.hypId, error: outcome.error });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, nodes.length) }, () => worker()),
  );

  console.log(
    `[hypothesize] ${experiments.filter((e) => e.experiment.length > 0).length}/${nodes.length} hypotheses got a runnable experiment` +
      (failures.length ? ` — ${failures.length} coverage gap(s)` : ""),
  );

  return { experiments, failures };
}
