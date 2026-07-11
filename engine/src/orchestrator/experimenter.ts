import type {
  Hypothesis,
  RunArtifact,
  EvidenceRef,
  ObserveFlags,
} from "@npmguard/shared";
import { runUnderObservation } from "../evidence/run-under-observation.js";
import { renderTimeline } from "../evidence/timeline.js";
import { judgeEvidence } from "./judge.js";

// ---------------------------------------------------------------------------
// Experimenter — run a hypothesis's experiment and let the judge read it.
//
// The experiment is a ToolCall[] HYPOTHESIZE composed from the shared tool
// registry (sandbox/tools.ts): setup that plants the bait a payload would take
// and defeats any spotted gate, plus the one trigger that runs the suspected
// code. This runs it under the full oracle, renders a readable timeline, and asks
// the judge whether the suspected behavior happened. Nothing here decides malice.
// ---------------------------------------------------------------------------

/** The full oracle: every sensor on, every run. The timeline and judge always
 *  read the same complete set of layers, so nothing downstream asks which ran. */
const FULL_ORACLE: ObserveFlags = { kernel: true, network: true, node: true, fsDiff: true, inspector: true };

/** Every experiment gets the same wall-clock budget; the orchestrator's
 *  per-hypothesis timeout is the outer bound. */
const EXPERIMENT_BUDGET = { wallMs: 20_000 };

export interface ExperimentResult {
  confirmed: boolean;
  reason: string;
  /** Timeline ids the judge cited as proof (empty unless confirmed). */
  citedEvents: string[];
  /** True when the judge itself could not run — the orchestrator DEFERs it. */
  judgeFailed: boolean;
  artifact: RunArtifact;
  evidenceRef: EvidenceRef;
  /** The rendered timeline the judge read — persisted as the run's whitebox. */
  timeline: string;
}

/**
 * Run one hypothesis's experiment: execute its tool calls under the full oracle,
 * render the run into a readable timeline, and let the judge decide whether the
 * suspected behavior actually happened.
 *
 * INVARIANT: the hypothesis carries a non-empty, registry-valid experiment —
 * HYPOTHESIZE guarantees it, and compileExperiment (inside runUnderObservation)
 * is the enforcing check.
 */
export async function runExperiment(
  hypothesis: Hypothesis,
  packagePath: string,
  statedPurpose: string,
): Promise<ExperimentResult> {
  const triggerCall = hypothesis.experiment.find((c) => c.tool === "trigger");
  console.log(
    `[experimenter] running experiment for ${hypothesis.hypId} (${hypothesis.claim.kind}) → ` +
      `${hypothesis.experiment.length} tool call(s), trigger=${JSON.stringify(triggerCall?.args?.target ?? "?")}`,
  );

  const artifact = await runUnderObservation({
    packagePath,
    experiment: hypothesis.experiment,
    observe: FULL_ORACLE,
    budget: EXPERIMENT_BUDGET,
  });

  const timeline = renderTimeline(artifact);
  const judgment = await judgeEvidence(hypothesis, timeline, statedPurpose);

  const evidenceRef: EvidenceRef = {
    kind: "run",
    id: artifact.runId,
    hash: artifact.contentHash,
  };

  console.log(
    `[experimenter] ${hypothesis.hypId}: ${judgment.confirmed ? "CONFIRMED" : "not confirmed"} — ${judgment.reason}`,
  );

  return {
    confirmed: judgment.confirmed,
    reason: judgment.reason,
    citedEvents: judgment.citedEvents,
    judgeFailed: judgment.judgeFailed,
    artifact,
    evidenceRef,
    timeline: timeline.text,
  };
}
