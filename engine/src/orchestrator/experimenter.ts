import type {
  ClaimKind,
  Hypothesis,
  RunArtifact,
  EvidenceRef,
  Trigger,
} from "@npmguard/shared";
import type { Manipulation } from "../manipulation/types.js";
import { setEnv } from "../manipulation/env.js";
import { plantFiles } from "../manipulation/plant-files.js";
import { runUnderObservation, type RunRequest } from "../evidence/run-under-observation.js";
import { renderTimeline } from "../evidence/timeline.js";
import { judgeEvidence } from "./judge.js";

// ---------------------------------------------------------------------------
// Strategy — one per ClaimKind, describing HOW to run the package: which
// trigger, what to plant, which sensors to enable, how long to wait. It no
// longer decides anything. The run is rendered into a readable timeline and
// the judge reads it (see judge.ts). One general mechanism — a readable
// timeline the model can localize against — replaces the old per-claim
// `confirm()` predicates (and the whole class of false positives they carried,
// e.g. persistence firing on a stdout `write()`).
// ---------------------------------------------------------------------------

export interface ExperimentStrategy {
  trigger: Trigger;
  setup: readonly Manipulation[];
  observe: RunRequest["observe"];
  budget: RunRequest["budget"];
}

/** A fake credential planted before the run so a real exfil payload has bait to steal. */
const PLANTED_TOKEN = "NPMGUARD_CANARY_TOKEN_f8e2d91a";

/**
 * Whether a claim kind has an automated dynamic experiment. The orchestrator
 * routes dynamic claims to the experimenter (run under observation → judge) and
 * static claims to the code-reader. Kept in lockstep with the `null`-returning
 * cases of `strategyForClaim`.
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

// ---------------------------------------------------------------------------
// Strategy builders (pure)
// ---------------------------------------------------------------------------

/**
 * Pick the best trigger target for this hypothesis. If any focusFile is a
 * known install-time entry point, prefer it — the malicious code may live in
 * an install script rather than the runtime require() path. Either way the
 * chosen target is executed as an entrypoint.
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
 * Build an experiment strategy for the given claim kind. Uses the hypothesis's
 * focusFiles to select the right trigger target (main entry point or lifecycle
 * hook). Returns null for claim kinds with no automated experiment yet.
 */
export function strategyForClaim(
  claim: ClaimKind,
  hypothesis: Hypothesis,
  entryTarget: string,
  installEntries: readonly string[] = [],
): ExperimentStrategy | null {
  const { target, kind } = pickTriggerTarget(hypothesis, entryTarget, installEntries);
  const trigger: Trigger = { kind, target, argv: [], stdin: null };
  switch (claim) {
    case "env_exfil":
    case "cred_theft":
      return {
        trigger,
        setup: [
          setEnv({
            NPM_TOKEN: PLANTED_TOKEN,
            AWS_ACCESS_KEY_ID: "AKIA" + PLANTED_TOKEN.slice(0, 16),
            HOME: "/home/node",
          }),
          plantFiles([
            {
              path: "/home/node/.npmrc",
              content: `//registry.npmjs.org/:_authToken=${PLANTED_TOKEN}\n`,
            },
          ]),
        ],
        observe: { kernel: true, network: true, node: true, fsDiff: false, inspector: false },
        budget: { wallMs: 15_000 },
      };

    case "binary_drop":
      return {
        trigger,
        setup: [],
        observe: { kernel: true, network: true, node: true, fsDiff: true, inspector: false },
        budget: { wallMs: 20_000 },
      };

    case "dos_loop":
      return {
        trigger,
        setup: [],
        observe: { kernel: true, node: true, fsDiff: false, network: false, inspector: false },
        budget: { wallMs: 5_000 },
      };

    case "obfuscation":
      return {
        trigger,
        setup: [],
        observe: { kernel: false, network: false, node: true, fsDiff: false, inspector: true },
        budget: { wallMs: 15_000 },
      };

    case "persistence":
      return {
        trigger,
        setup: [],
        observe: { kernel: true, node: true, fsDiff: true, network: false, inspector: false },
        budget: { wallMs: 15_000 },
      };

    case "dns_exfil":
      return {
        trigger,
        setup: [setEnv({ NPM_TOKEN: PLANTED_TOKEN, HOME: "/home/node" })],
        observe: { kernel: true, network: true, node: true, fsDiff: false, inspector: false },
        budget: { wallMs: 15_000 },
      };

    case "telemetry":
    case "build_plugin_exfil":
      return {
        trigger,
        setup: [
          setEnv({ NPM_TOKEN: PLANTED_TOKEN, CI: "true", HOME: "/home/node" }),
          plantFiles([
            {
              path: "/home/node/.npmrc",
              content: `//registry.npmjs.org/:_authToken=${PLANTED_TOKEN}\n`,
            },
          ]),
        ],
        observe: { kernel: true, network: true, node: true, fsDiff: false, inspector: false },
        budget: { wallMs: 20_000 },
      };

    case "destructive":
      return {
        trigger,
        setup: [
          plantFiles([
            { path: "/pkg/sandbox-test/file1.txt", content: "NPMGUARD_CANARY_DELETE_TARGET\n" },
            { path: "/pkg/sandbox-test/file2.txt", content: "NPMGUARD_CANARY_DELETE_TARGET\n" },
          ]),
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
 * Run an experiment for a single hypothesis: pick a strategy, run the package
 * under observation, render the run into a readable timeline, and let the judge
 * decide whether the suspected behavior actually happened. Returns null if no
 * dynamic strategy exists for this claim.
 */
export async function runExperiment(
  hypothesis: Hypothesis,
  packagePath: string,
  entryTarget: string,
  installEntries: readonly string[],
  statedPurpose: string,
): Promise<ExperimentResult | null> {
  const strategy = strategyForClaim(hypothesis.claim.kind, hypothesis, entryTarget, installEntries);
  if (!strategy) {
    console.log(
      `[experimenter] no strategy for claim ${hypothesis.claim.kind} (${hypothesis.hypId})`,
    );
    return null;
  }

  console.log(
    `[experimenter] running experiment for ${hypothesis.hypId} (${hypothesis.claim.kind}) → trigger=${strategy.trigger.kind}:${strategy.trigger.target}`,
  );

  const artifact = await runUnderObservation({
    packagePath,
    trigger: strategy.trigger,
    setup: strategy.setup,
    observe: strategy.observe,
    budget: strategy.budget,
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
