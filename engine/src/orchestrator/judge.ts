import { z } from "zod";
import { generateObject } from "ai";
import type { Hypothesis } from "@npmguard/shared";
import { config } from "../config.js";
import { getModel } from "../llm.js";
import type { RenderedTimeline } from "../evidence/timeline.js";

// ---------------------------------------------------------------------------
// Judge — the sole decision-maker for a dynamic run.
//
// It reads ONE hypothesis against ONE run's readable execution timeline and
// decides whether the suspected behavior actually happened, citing the timeline
// event ids that prove it. This replaces the hand-written `confirm(artifact)`
// predicates: a readable timeline + a model that can read it removes the whole
// class of predicate false positives (e.g. a `write(1,…)` to stdout that a
// predicate counted as persistence but the model plainly reads as `write
// stdout`).
//
// Runs on the capable investigation model, not the cheap triage model: the
// judge is the detection gate — a CONFIRMED verdict is the only thing that
// blocks an install — so it must not be blind to textbook payloads.
// ---------------------------------------------------------------------------

export const JudgeVerdict = z.object({
  malicious: z
    .boolean()
    .describe("Whether the suspected behavior actually happened in this run, per the timeline."),
  reason: z
    .string()
    .describe("One or two sentences explaining the verdict, grounded in what the timeline shows."),
  citedEvents: z
    .array(z.string())
    .default([])
    .describe("Timeline event ids (e.g. ['e7','e12']) that prove a malicious verdict. Empty if benign."),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

export interface JudgeResult {
  /** malicious AND cites ≥1 id that actually exists in the timeline. */
  confirmed: boolean;
  reason: string;
  citedEvents: string[];
  /** True when the judge could not evaluate the run (model/infra failure) — a
   *  coverage gap the orchestrator DEFERs, distinct from a clean not-malicious. */
  judgeFailed: boolean;
  verdict: JudgeVerdict;
}

const SYSTEM = `You are a security analyst judging ONE hypothesis about an npm package against ONE run's execution timeline.

The timeline is a chronological, layer-tagged trace of what the package actually did when executed under observation: [L1] kernel syscalls, [L2] network, [L3] filesystem changes, [L4] Node-level calls. Each line has a stable id (e1, e2, …).

The package's stated purpose is the benign baseline. Behavior consistent with that purpose is NOT malicious — a documented HTTP client making HTTP requests is expected. Judge whether the SUSPECTED behavior in the hypothesis actually occurred in THIS run.

- If it did: set malicious=true and cite the exact timeline ids that show it (e.g. reading ~/.npmrc then a POST to an undocumented host). Cite only ids that appear in the timeline.
- If it did not — the payload never fired, the run only did benign work, or the timeline shows nothing matching the claim: set malicious=false with an empty citedEvents.

Do not infer intent from code you cannot see; judge only what the timeline shows. A malicious verdict must point at real events.`;

function buildPrompt(hypothesis: Hypothesis, timeline: string, statedPurpose: string): string {
  const focus = hypothesis.focusLines.map((fl) => `${fl.file}:${fl.range}`).join(", ");
  return [
    `## Stated purpose (benign baseline)\n${statedPurpose || "(unknown — treat every capability as potentially surprising)"}`,
    `## Hypothesis ${hypothesis.hypId}\n` +
      `- claim: ${hypothesis.claim.kind}${hypothesis.claim.gating ? ` (gated: ${hypothesis.claim.gating})` : ""}\n` +
      `- severity: ${hypothesis.severity}\n` +
      `- description: ${hypothesis.description}\n` +
      `- suspected code: ${focus || hypothesis.focusFiles.join(", ") || "(unspecified)"}`,
    `## Execution timeline\n${timeline}`,
    `## Task\nDid the suspected behavior actually happen in this run? Decide malicious, give a reason, and cite the timeline ids that prove a malicious verdict.`,
  ].join("\n\n");
}

/**
 * Judge one hypothesis against one run's rendered timeline. Returns the verdict
 * plus a `confirmed` flag that stands only when the model both calls it
 * malicious AND cites at least one id that really exists in the timeline — the
 * whole guard (step 5: the evidence must match the hypothesis). A model or
 * schema failure yields a non-confirming result rather than throwing, so the
 * orchestrator's run-error handling stays authoritative.
 */
export async function judgeEvidence(
  hypothesis: Hypothesis,
  timeline: RenderedTimeline,
  statedPurpose: string,
): Promise<JudgeResult> {
  let verdict: JudgeVerdict;
  try {
    const result = await generateObject({
      model: getModel(config.investigationModel),
      schema: JudgeVerdict,
      system: SYSTEM,
      prompt: buildPrompt(hypothesis, timeline.text, statedPurpose),
    });
    verdict = result.object;
  } catch (err) {
    const reason = `Judge model call failed: ${err instanceof Error ? err.message : String(err)}`;
    return { confirmed: false, reason, citedEvents: [], judgeFailed: true, verdict: { malicious: false, reason, citedEvents: [] } };
  }

  const cited = verdict.citedEvents.filter((id) => timeline.ids.has(id));
  const confirmed = verdict.malicious && cited.length > 0;
  return { confirmed, reason: verdict.reason, citedEvents: cited, judgeFailed: false, verdict };
}
