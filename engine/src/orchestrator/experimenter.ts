import type {
  ClaimKind,
  Hypothesis,
  RunArtifact,
  EvidenceRef,
  ObserveFlags,
  ToolCall,
} from "@npmguard/shared";
import { runUnderObservation, type RunRequest } from "../evidence/run-under-observation.js";
import { renderTimeline } from "../evidence/timeline.js";
import { judgeEvidence } from "./judge.js";

// ---------------------------------------------------------------------------
// Experimenter — turn a claim into an EXPERIMENT and run it.
//
// An experiment is a `ToolCall[]` against the shared tool registry
// (sandbox/tools.ts): the setup that plants bait a payload would take, plus the
// one trigger that runs the suspected code. The run is rendered into a readable
// timeline and the judge decides whether the suspected behavior happened —
// nothing here decides malice.
// ---------------------------------------------------------------------------

/** A fake credential planted before a run so a real exfil payload has bait to steal. */
const PLANTED_TOKEN = "NPMGUARD_CANARY_TOKEN_f8e2d91a";

/** Bait npm auth token, the file a credential-stealer reads first. */
const NPMRC_BAIT = {
  path: "/home/node/.npmrc",
  content: `//registry.npmjs.org/:_authToken=${PLANTED_TOKEN}\n`,
};

/** How to run a claim: the experiment tool calls, the sensors to observe, and the wall-clock budget. */
export interface ClaimExperiment {
  experiment: ToolCall[];
  observe: ObserveFlags;
  budget: RunRequest["budget"];
}

const triggerCall = (target: string): ToolCall => ({ tool: "trigger", args: { kind: "entrypoint", target } });
const setEnvCall = (env: Record<string, string>): ToolCall => ({ tool: "setEnv", args: { env } });
const plantFilesCall = (files: Array<{ path: string; content: string }>): ToolCall => ({ tool: "plantFiles", args: { files } });

/**
 * Whether a claim kind has a runnable experiment. Claims without one route to
 * the code-reader instead of the experimenter; kept in lockstep with the
 * null-returning cases of `experimentForClaim`.
 */
export function claimHasDynamicStrategy(claim: ClaimKind): boolean {
  switch (claim) {
    case "dom_inject":
    case "clipboard_hijack":
    case "propagation":
      return false;
    default:
      return true;
  }
}

/**
 * Pick the trigger target for this hypothesis. Prefer a focusFile that is an
 * install-time entry point — the payload may live in an install script rather
 * than the runtime require() path. Otherwise run the runtime entry.
 */
export function pickTriggerTarget(
  hypothesis: Hypothesis,
  runtimeEntry: string,
  installEntries: readonly string[],
): { target: string; kind: "entrypoint" } {
  for (const focus of hypothesis.focusFiles) {
    if (installEntries.includes(focus)) {
      return { target: focus, kind: "entrypoint" };
    }
  }
  return { target: runtimeEntry, kind: "entrypoint" };
}

/**
 * Build the experiment for a claim: the tool calls that plant bait and trigger
 * the code, the sensors to observe, and the budget. Returns null for claims
 * with no runnable experiment (browser/registry threats the sandbox cannot
 * exercise).
 */
export function experimentForClaim(
  claim: ClaimKind,
  hypothesis: Hypothesis,
  entryTarget: string,
  installEntries: readonly string[] = [],
): ClaimExperiment | null {
  const { target } = pickTriggerTarget(hypothesis, entryTarget, installEntries);
  const run = triggerCall(target);

  switch (claim) {
    case "env_exfil":
    case "cred_theft":
      return {
        experiment: [
          setEnvCall({
            NPM_TOKEN: PLANTED_TOKEN,
            AWS_ACCESS_KEY_ID: "AKIA" + PLANTED_TOKEN.slice(0, 16),
            HOME: "/home/node",
          }),
          plantFilesCall([NPMRC_BAIT]),
          run,
        ],
        observe: { kernel: true, network: true, node: true, fsDiff: false, inspector: false },
        budget: { wallMs: 15_000 },
      };

    case "binary_drop":
      return {
        experiment: [run],
        observe: { kernel: true, network: true, node: true, fsDiff: true, inspector: false },
        budget: { wallMs: 20_000 },
      };

    case "dos_loop":
      return {
        experiment: [run],
        observe: { kernel: true, node: true, fsDiff: false, network: false, inspector: false },
        budget: { wallMs: 5_000 },
      };

    case "obfuscation":
      return {
        experiment: [run],
        observe: { kernel: false, network: false, node: true, fsDiff: false, inspector: true },
        budget: { wallMs: 15_000 },
      };

    case "persistence":
      return {
        experiment: [run],
        observe: { kernel: true, node: true, fsDiff: true, network: false, inspector: false },
        budget: { wallMs: 15_000 },
      };

    case "dns_exfil":
      return {
        experiment: [setEnvCall({ NPM_TOKEN: PLANTED_TOKEN, HOME: "/home/node" }), run],
        observe: { kernel: true, network: true, node: true, fsDiff: false, inspector: false },
        budget: { wallMs: 15_000 },
      };

    case "telemetry":
    case "build_plugin_exfil":
      return {
        experiment: [
          setEnvCall({ NPM_TOKEN: PLANTED_TOKEN, CI: "true", HOME: "/home/node" }),
          plantFilesCall([NPMRC_BAIT]),
          run,
        ],
        observe: { kernel: true, network: true, node: true, fsDiff: false, inspector: false },
        budget: { wallMs: 20_000 },
      };

    case "destructive":
      return {
        experiment: [
          plantFilesCall([
            { path: "/pkg/sandbox-test/file1.txt", content: "NPMGUARD_CANARY_DELETE_TARGET\n" },
            { path: "/pkg/sandbox-test/file2.txt", content: "NPMGUARD_CANARY_DELETE_TARGET\n" },
          ]),
          run,
        ],
        observe: { kernel: true, network: false, node: true, fsDiff: true, inspector: false },
        budget: { wallMs: 20_000 },
      };

    case "dom_inject":
    case "clipboard_hijack":
    case "propagation":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

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
 * Run an experiment for a single hypothesis: build its tool-call experiment, run
 * the package under observation, render the run into a readable timeline, and
 * let the judge decide whether the suspected behavior actually happened. Returns
 * null when the claim has no runnable experiment.
 */
export async function runExperiment(
  hypothesis: Hypothesis,
  packagePath: string,
  entryTarget: string,
  installEntries: readonly string[],
  statedPurpose: string,
): Promise<ExperimentResult | null> {
  const plan = experimentForClaim(hypothesis.claim.kind, hypothesis, entryTarget, installEntries);
  if (!plan) {
    console.log(
      `[experimenter] no experiment for claim ${hypothesis.claim.kind} (${hypothesis.hypId})`,
    );
    return null;
  }

  const { target } = pickTriggerTarget(hypothesis, entryTarget, installEntries);
  console.log(
    `[experimenter] running experiment for ${hypothesis.hypId} (${hypothesis.claim.kind}) → ` +
      `trigger=entrypoint:${target}, ${plan.experiment.length} tool call(s)`,
  );

  const artifact = await runUnderObservation({
    packagePath,
    experiment: plan.experiment,
    observe: plan.observe,
    budget: plan.budget,
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
