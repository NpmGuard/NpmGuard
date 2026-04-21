import { randomUUID } from "node:crypto";
import type {
  Budget,
  Event,
  ObserveFlags,
  RunArtifact,
  RunError,
  Trigger,
} from "@npmguard/shared";
import { dockerExec } from "../sandbox/docker.js";
import { INSTRUMENTATION_JS } from "../sandbox/instrumentation.js";
import {
  type ContainerSpec,
  defaultContainerSpec,
  specToDockerArgs,
} from "../sandbox/container-spec.js";
import { parseL4Trace } from "./l4-parser.js";
import { sha256Hex } from "./hashing.js";
import {
  buildTriggerCommand,
  computeEventSummary,
  emptySetupApplied,
  sealRunArtifact,
  truncationEvent,
} from "./run-under-observation-helpers.js";

/**
 * Input to `runUnderObservation`. Only the `packagePath` and `trigger` are
 * strictly required; everything else has sensible defaults.
 *
 * Sprint 2 (walking skeleton): only `trigger.kind === "entrypoint" | "subpath"`
 * is supported, and no manipulation primitives are applied. Sprint 3 fills in
 * env/date/plantFiles/stubUrl/patchFile/preload; Sprint 4 fills in L1/L2/L3.
 */
export interface RunRequest {
  packagePath: string;
  trigger: Trigger;
  observe?: Partial<ObserveFlags>;
  budget?: Partial<Budget>;
  containerSpec?: Partial<ContainerSpec>;
}

const DEFAULT_OBSERVE: ObserveFlags = {
  kernel: false,
  network: false,
  fsDiff: false,
  node: true,
  inspector: false,
};

const DEFAULT_BUDGET: Budget = {
  wallMs: 60_000,
  maxSyscalls: null,
  maxBytesCapture: 1_000_000,
};

export class RunUnderObservationError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = "RunUnderObservationError";
  }
}

/**
 * Run a package in a hardened Docker container and produce a sealed,
 * content-hashed RunArtifact describing what happened.
 *
 * Throws `RunUnderObservationError` when the container cannot be created at
 * all (Docker daemon down, image missing, etc.). Returns a RunArtifact with a
 * populated `error` field for in-run failures (Node crash, budget exceeded,
 * sensor failed to parse).
 */
export async function runUnderObservation(req: RunRequest): Promise<RunArtifact> {
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 26)}`;
  const observe: ObserveFlags = { ...DEFAULT_OBSERVE, ...req.observe };
  const budget: Budget = { ...DEFAULT_BUDGET, ...req.budget };

  const spec = defaultContainerSpec({
    volumes: [
      { hostPath: req.packagePath, containerPath: "/pkg", readOnly: true },
    ],
    ...req.containerSpec,
  });

  const containerName = `npmguard-run-${runId.slice(4, 16)}`;
  const createdAt = new Date().toISOString();
  const startedAt = Date.now();

  const events: Event[] = [];
  let error: RunError | null = null;
  let exitCode: number | null = null;
  let timedOut = false;
  let stdoutHash: string | null = null;
  let stderrHash: string | null = null;

  // Start container
  const runArgs = specToDockerArgs(spec, containerName);
  const startRes = await dockerExec(runArgs, 30_000);
  if (startRes.exitCode !== 0) {
    throw new RunUnderObservationError(
      "failed to start sandbox container",
      `docker run exit=${startRes.exitCode}: ${startRes.stderr.slice(0, 500)}`,
    );
  }

  try {
    // Write L4 instrumentation if node observation is enabled
    if (observe.node) {
      const writeRes = await dockerExec(
        [
          "exec", containerName, "sh", "-c",
          `cat > /tmp/_instrument.js << 'INSTRUMENT_EOF'\n${INSTRUMENTATION_JS}\nINSTRUMENT_EOF`,
        ],
        10_000,
      );
      if (writeRes.exitCode !== 0) {
        error = {
          kind: "SensorError",
          detail: `failed to write L4 instrumentation: ${writeRes.stderr.slice(0, 500)}`,
        };
      }
    }

    // Build trigger command
    const cmd = buildTriggerCommand(req.trigger, observe.node);
    if (cmd === null) {
      error = {
        kind: "SetupError",
        detail: `trigger.kind='${req.trigger.kind}' not supported in walking skeleton (Sprint 2)`,
      };
    }

    // Execute trigger with budget
    if (error === null && cmd !== null) {
      const execArgs = ["exec", containerName, ...cmd];
      const res = await dockerExec(execArgs, budget.wallMs);
      exitCode = res.exitCode;
      timedOut = res.timedOut;

      if (res.stdout) stdoutHash = sha256Hex(res.stdout);
      if (res.stderr) stderrHash = sha256Hex(res.stderr);

      if (timedOut) {
        error = {
          kind: "TimeoutError",
          detail: `wall-clock budget (${budget.wallMs}ms) exceeded; container killed`,
        };
        events.push(truncationEvent(`wall-clock budget (${budget.wallMs}ms) exceeded`));
      } else if (exitCode !== 0) {
        error = {
          kind: "CrashError",
          detail: `node exited ${exitCode}; stderr: ${res.stderr.slice(0, 500)}`,
        };
      }

      // Parse L4 trace if observe.node and we got some stdout
      if (observe.node) {
        const l4 = parseL4Trace(res.stdout);
        if (l4 === null) {
          if (error === null) {
            error = {
              kind: "SensorError",
              detail: "L4 trace markers absent from stdout (instrumentation may have been evaded or suppressed)",
            };
          }
          // else: crash/timeout already explains missing trace
        } else {
          events.push(...l4);
        }
      }
    }
  } finally {
    await dockerExec(["rm", "-f", containerName], 10_000).catch(() => {});
  }

  const wallMs = Date.now() - startedAt;
  events.sort((a, b) => a.timestamp - b.timestamp);

  const draft: Omit<RunArtifact, "contentHash"> = {
    runId,
    triggerUsed: req.trigger,
    setupApplied: emptySetupApplied(),
    observe,
    budget,
    wallMs,
    exitCode,
    timedOut,
    events,
    stdoutHash,
    stderrHash,
    fsDiffHash: null,
    pcapHash: null,
    inspectorLogHash: null,
    eventSummary: computeEventSummary(events),
    error,
    createdAt,
  };

  return sealRunArtifact(draft);
}
