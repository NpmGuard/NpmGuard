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
// Experimenter — run a hypothesis's EXPERIMENT and let the judge read it.
//
// The experiment is a `ToolCall[]` the HYPOTHESIZE pass composed against the
// shared tool registry (sandbox/tools.ts): the setup that plants bait a payload
// would take + defeats any spotted gate, plus the one trigger that runs the
// suspected code. This file no longer knows anything about claim kinds or which
// bait to plant — it just runs what the hypothesis carries, under the full
// oracle, renders a readable timeline, and asks the judge whether the suspected
// behavior happened. Nothing here decides malice.
// ---------------------------------------------------------------------------

/** The full oracle: every sensor on, every run. The timeline and judge always
 *  read the same complete set of layers, so nothing downstream asks which ran. */
const FULL_ORACLE: ObserveFlags = { kernel: true, network: true, node: true, fsDiff: true, inspector: true };

/** One wall-clock budget for every experiment. A hypothesis no longer tunes its
 *  own budget (that lived in the deleted per-claim strategy table); the
 *  orchestrator's per-hypothesis timeout is the outer bound. */
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
 * suspected behavior actually happened. The hypothesis must carry a non-empty
 * `experiment` — the orchestrator only routes runnable hypotheses here; an empty
 * experiment would fail to compile (no trigger) and surface as a run error.
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
