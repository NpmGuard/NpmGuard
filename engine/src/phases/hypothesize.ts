import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { generateObject } from "ai";
import {
  ClaimKind,
  GatingModifier,
  HypothesisSeverity,
  type Hypothesis,
  type ToolCall,
} from "@npmguard/shared";
import { config } from "../config.js";
import { getModel } from "../llm.js";
import { numberLines } from "../util.js";
import { renderToolCatalog, compileExperiment, ExperimentCompileError } from "../sandbox/tools.js";
import type { EntryPoints } from "../models.js";
import type { EmitFn } from "../events.js";
import type { PackageIntent } from "./intent-extraction.js";
import type { Flag } from "./flag.js";

// ---------------------------------------------------------------------------
// HYPOTHESIZE — turn each flag into a runnable hypothesis.
//
// For a flag the cheap FLAG pass raised, the smart model names the suspected
// behavior (description + best-match label + severity) and composes an
// experiment: an ordered ToolCall[] from the shared tool registry
// (sandbox/tools.ts) that plants the bait the payload would take, defeats any
// gate the flag spotted (time/geo/CI/anti-debug), and triggers the code once.
//
// INVARIANT: every flag becomes a hypothesis carrying a registry-valid
// experiment. A flag the model cannot arm is an incoherent state — a suspicion
// with nothing to run — so it raises HypothesizeError and the audit is an ERROR.
// There is no hypothesis without an experiment, and no benign dismissal: a
// suspicion is resolved by running it, never by reading it.
// ---------------------------------------------------------------------------

/** Per-flag code budget handed to the model. An obfuscated one-liner counts as a
 *  single very long line; the cap keeps a huge bundle from blowing the context
 *  while still showing the model the flagged region. */
const MAX_FOCUS_CHARS = 40_000;

/** Bait canary the model plants so a real exfil has a concrete secret to read
 *  and the timeline names a consistent value. */
export const SUGGESTED_CANARY = "NPMGUARD_CANARY_TOKEN_f8e2d91a";

/** A flag the model could not arm into a runnable experiment. The audit cannot
 *  complete over an untestable suspicion, so this surfaces as an audit ERROR. */
export class HypothesizeError extends Error {
  constructor(readonly flag: Flag, readonly detail: string) {
    super(`could not arm flag ${flag.file} (${flag.why}): ${detail}`);
    this.name = "HypothesizeError";
  }
}

export interface HypothesizeContext {
  packagePath: string;
  intent: PackageIntent;
  entryPoints: EntryPoints;
  emit?: EmitFn;
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

const HypothesisResponse = z.object({
  description: z
    .string()
    .describe(
      "One clear sentence naming the suspected behavior, referencing concrete code (e.g. 'reads ~/.npmrc and POSTs it to a string-built URL'). Used verbatim for dedup downstream.",
    ),
  claim: z.object({
    kind: ClaimKind.describe("Best-match label for the suspected behavior (a display label only)."),
    gating: GatingModifier.nullable().default(null).describe(
      "Set only if the code runs differently under a specific condition you must defeat (time/geo/CI/inspector).",
    ),
  }),
  severity: HypothesisSeverity.describe(
    "low (unlikely), medium (plausibly harmful), high (clearly harmful if triggered), critical (unambiguous theft/RCE/destruction).",
  ),
  reasoning: z
    .string()
    .describe("One or two sentences: how the experiment makes the payload fire, including any gate you defeat."),
  experiment: z
    .array(ToolCallDraft)
    .min(1)
    .describe("Ordered tool calls: setup calls first (plant bait, defeat gates), then EXACTLY ONE `trigger` call."),
});
export type HypothesisResponse = z.infer<typeof HypothesisResponse>;

// ---------------------------------------------------------------------------
// Prompt (pure)
// ---------------------------------------------------------------------------

export const HYPOTHESIZE_SYSTEM = `You are a security analyst turning a flagged region of an npm package into a testable hypothesis.

A fast triage pass flagged this region as worth a closer look. You are given the flag, the code it points at, what the package is supposed to do, and a catalog of tools for setting up and triggering a sandboxed run. Produce two things:

1. A hypothesis about the suspected behavior: a one-sentence description, a best-match claim label, and a severity.
2. An EXPERIMENT — the ordered tool calls that would MAKE THAT BEHAVIOR ACTUALLY FIRE, so a downstream judge can watch it happen under full instrumentation.

Design the experiment to trigger the payload, not to avoid it:
- Plant the bait the payload would go after — fake credentials in the environment (setEnv: NPM_TOKEN, AWS_ACCESS_KEY_ID) and on disk (plantFiles: /home/node/.npmrc, /home/node/.ssh/id_rsa, /home/node/.aws/credentials). Absolute container paths only.
- DEFEAT any gate the region shows so the guarded branch runs: a time gate → setDate past the trigger date; a CI gate → setEnv CI=true; an anti-debug/inspector or other hard check → patchFile to neutralize it or force the branch.
- Make staged fetches succeed if the payload needs a second stage — stubUrl to return a canned response.
- End with EXACTLY ONE trigger call naming the entry point most likely to reach the code (an install lifecycle file for install-time payloads, the runtime entry otherwise). Prefer a file in the package's entry points.

Rules:
- Use ONLY tools from the catalog, with arguments matching their documented parameters. An unknown tool or bad arguments makes the whole experiment invalid.
- The experiment MUST contain exactly one trigger call.
- You are NOT the final judge of malice — only of how to run the code so the behavior would show if it is there. Never refuse to design an experiment because the code "looks fine"; if a payload is gated or hidden, your job is to defeat the gate and trigger it anyway. The label and severity are your best guess; the run decides.`;

export function buildHypothesizePrompt(args: {
  flag: Flag;
  focusCode: string;
  intent: PackageIntent;
  entryPoints: EntryPoints;
}): string {
  const { flag, focusCode, intent, entryPoints } = args;
  const sections: string[] = [];

  sections.push(
    `## Package intent (benign baseline)\n` +
      `- statedPurpose: ${intent.statedPurpose}\n` +
      `- expectedCapabilities: ${intent.expectedCapabilities.join(", ") || "(none)"}`,
  );

  sections.push(
    `## Flag\n` +
      `- file: ${flag.file}\n` +
      `- lines: ${flag.lines.join(", ")}\n` +
      `- why it was flagged: ${flag.why}`,
  );

  sections.push(
    `## Entry points (candidate trigger targets)\n` +
      `- install (lifecycle): ${entryPoints.install.join(", ") || "(none)"}\n` +
      `- runtime: ${entryPoints.runtime.join(", ") || "(none)"}\n` +
      `- bin: ${entryPoints.bin.join(", ") || "(none)"}`,
  );

  sections.push(`## Flagged code\n${focusCode || "(source unavailable)"}`);

  sections.push(
    `## Available tools\n${renderToolCatalog()}\n\n` +
      `Suggested bait canary value: ${SUGGESTED_CANARY}`,
  );

  sections.push(
    `## Task\nName the suspected behavior (description, claim label, severity) and compose the ordered tool calls (setup, then exactly one trigger) that would make it fire in the sandbox.`,
  );

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Focus code extraction (pure)
// ---------------------------------------------------------------------------

/**
 * Read the code a flag points at. The file is line-numbered (so the reasoning
 * can reference the flagged ranges) and capped so a giant bundle cannot blow the
 * context window. Returns "" if the file is unreadable.
 */
export function readFocusCode(packagePath: string, flag: Flag): string {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(packagePath, flag.file), "utf-8");
  } catch {
    return "";
  }
  const capped =
    contents.length > MAX_FOCUS_CHARS
      ? contents.slice(0, MAX_FOCUS_CHARS) + "\n… (truncated)"
      : contents;
  return `### ${flag.file} (flagged lines ${flag.lines.join(", ")})\n\`\`\`\n${numberLines(capped)}\n\`\`\``;
}

// ---------------------------------------------------------------------------
// Experiment validation (pure) — the registry is the one contract
// ---------------------------------------------------------------------------

export type ValidateResult =
  | { ok: true; experiment: ToolCall[] }
  | { ok: false; error: string };

/**
 * Validate a model-proposed experiment against the shared tool registry. A
 * ToolCall[] that compiles is coherent; anything else (unknown tool, bad args,
 * zero or many triggers) is rejected with the registry's own error. Never
 * silently drops a bad call.
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
// Per-flag hypothesis (throws when it cannot arm)
// ---------------------------------------------------------------------------

/**
 * Turn one flag into an armed hypothesis, or raise HypothesizeError. The model
 * names the behavior and composes the experiment in one call; a call that fails
 * or an experiment the registry rejects is an incoherent, untestable state — it
 * raises rather than inventing a hypothesis or an empty experiment.
 */
async function hypothesizeFlag(
  flag: Flag,
  ctx: HypothesizeContext,
  hypId: string,
  now: string,
): Promise<Hypothesis> {
  const focusCode = readFocusCode(ctx.packagePath, flag);
  const prompt = buildHypothesizePrompt({
    flag,
    focusCode,
    intent: ctx.intent,
    entryPoints: ctx.entryPoints,
  });

  let response: HypothesisResponse;
  try {
    const result = await generateObject({
      model: getModel(config.investigationModel),
      schema: HypothesisResponse,
      system: HYPOTHESIZE_SYSTEM,
      prompt,
    });
    response = result.object;
  } catch (err) {
    throw new HypothesizeError(flag, `model call failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const validated = validateExperiment(response.experiment as ToolCall[]);
  if (!validated.ok) {
    throw new HypothesizeError(flag, `invalid experiment: ${validated.error}`);
  }

  return {
    hypId,
    description: response.description,
    claim: { kind: response.claim.kind, gating: response.claim.gating ?? null },
    focusFiles: [flag.file],
    focusLines: flag.lines.map((range) => ({ file: flag.file, range })),
    experiment: validated.experiment,
    severity: response.severity,
    parentHypId: null,
    childHypIds: [],
    state: "OPEN",
    createdBy: "hypothesize",
    evidenceRefs: [],
    createdAt: now,
    resolvedAt: null,
    resolution: null,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Arm every flag into a hypothesis. Bounded concurrency mirrors FLAG — the smart
 * model is the cost center. Any flag that cannot be armed raises HypothesizeError
 * and aborts the pass (the audit is an ERROR): the pipeline cannot issue a
 * verdict while a raised suspicion is untested. Dedup happens downstream
 * (build-graph, on description).
 */
export async function runHypothesize(
  flags: Flag[],
  ctx: HypothesizeContext,
): Promise<Hypothesis[]> {
  const concurrency = Math.max(1, Number(process.env.NPMGUARD_TRIAGE_CONCURRENCY ?? 8));
  console.log(`[hypothesize] arming ${flags.length} flag(s) into hypotheses`);

  const now = new Date().toISOString();
  const hypotheses: Hypothesis[] = new Array(flags.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= flags.length) return;
      const flag = flags[i]!;
      const hypId = `hyp-${(i + 1).toString().padStart(4, "0")}`;
      ctx.emit?.("file_analyzing", { file: flag.file });
      const hyp = await hypothesizeFlag(flag, ctx, hypId, now);
      hypotheses[i] = hyp;
      console.log(`[hypothesize] ${hypId} (${hyp.claim.kind}) → ${hyp.experiment.length} tool call(s)`);
      ctx.emit?.("hypothesis_emitted", {
        hypId,
        claim: hyp.claim.kind,
        severity: hyp.severity,
        file: flag.file,
      });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, flags.length) }, () => worker()));

  console.log(`[hypothesize] armed ${hypotheses.length} hypothesis node(s)`);
  return hypotheses;
}
