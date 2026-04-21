import { randomUUID } from "node:crypto";
import type {
  Budget,
  Event,
  ObserveFlags,
  RunArtifact,
  RunError,
  SetupApplied,
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
  sealRunArtifact,
  truncationEvent,
} from "./run-under-observation-helpers.js";
import { applyManipulation } from "../manipulation/compose.js";
import { mergeContainerSpec, type Manipulation, type SetupContext } from "../manipulation/types.js";
import {
  DEFAULT_WATCH_PATHS,
  snapshotPre as fsDiffSnapshotPre,
  snapshotPostAndDiff as fsDiffSnapshotPostAndDiff,
} from "../sensors/fs-diff.js";
import { parseStraceLog, wrapWithStrace } from "../sensors/strace.js";
import { startPcapCapture, stopPcapCaptureAndParse } from "../sensors/pcap.js";

/**
 * Input to `runUnderObservation`.
 *
 * Sprint 3 additions: `setup` accepts a list of manipulation primitives
 * (setEnv, setDate, plantFiles, stubUrl, patchFile, preload) whose specs are
 * composed into the container launch and whose postStart hooks run after
 * boot. Sprint 4 will populate L1/L2/L3 streams; Sprint 5 wires V8 Inspector.
 */
export interface RunRequest {
  packagePath: string;
  trigger: Trigger;
  setup?: readonly Manipulation[];
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
 * Container layout:
 *   /pkg-src  — read-only bind mount of the host package path
 *   /pkg      — writable tmpfs, populated at boot via `cp -a /pkg-src/. /pkg/`
 *   /tmp      — writable tmpfs (noexec)
 *   workdir   — /pkg  (so `require("./...")` resolves inside the writable copy)
 *
 * Throws `RunUnderObservationError` only when the container can't be
 * created. In-run failures (crash, timeout, sensor, setup) populate
 * `RunArtifact.error`.
 */
export async function runUnderObservation(req: RunRequest): Promise<RunArtifact> {
  const runId = `run_${randomUUID().replace(/-/g, "").slice(0, 26)}`;
  const observe: ObserveFlags = { ...DEFAULT_OBSERVE, ...req.observe };
  const budget: Budget = { ...DEFAULT_BUDGET, ...req.budget };
  const primitives = req.setup ?? [];

  const baseSpec = defaultContainerSpec({
    volumes: [
      { hostPath: req.packagePath, containerPath: "/pkg-src", readOnly: true },
    ],
    tmpfs: [
      { path: "/tmp", options: "rw,noexec,nosuid,size=64m" },
      { path: "/pkg", options: "rw,size=256m,uid=1000,gid=1000,mode=0755" },
      // /home/node is writable so plantFiles can seed ~/.npmrc / ~/.ssh/id_rsa /
      // ~/.aws/credentials, and so Node itself can write its npm/cache files.
      { path: "/home/node", options: "rw,size=64m,uid=1000,gid=1000,mode=0755" },
    ],
    workdir: "/pkg",
    // L2 pcap needs a real network interface. Bridge is the v1 choice — it
    // means the sandbox can reach external hosts; we'll tighten with an
    // internal-only Docker network or egress firewall before running against
    // real malware (documented in ARCHITECT_REVIEW_ENGINE.md risks).
    networkMode: observe.network ? "bridge" : "none",
    capAdd: [
      ...(observe.kernel ? ["SYS_PTRACE"] : []),
      // tcpdump (launched as root in the exec, run with `-Z root`) needs:
      //   NET_RAW            — open raw packet-capture sockets
      //   SETUID + SETGID    — `-Z root` still calls setuid(0)/setgid(0)
      // These caps apply to the container root; uid 1000 (the target package)
      // does not auto-inherit them.
      ...(observe.network ? ["NET_RAW", "SETUID", "SETGID"] : []),
    ],
    ...req.containerSpec,
  });

  const composed = applyManipulation(primitives);
  const spec = mergeContainerSpec(baseSpec, composed.specPatch);

  const containerName = `npmguard-run-${runId.slice(4, 16)}`;
  const createdAt = new Date().toISOString();
  const startedAt = Date.now();

  const events: Event[] = [...composed.events];
  let error: RunError | null = null;
  let exitCode: number | null = null;
  let timedOut = false;
  let stdoutHash: string | null = null;
  let stderrHash: string | null = null;
  let fsDiffHash: string | null = null;
  let straceLogHash: string | null = null;
  let pcapHash: string | null = null;

  // Start the container.
  const startRes = await dockerExec(specToDockerArgs(spec, containerName), 30_000);
  if (startRes.exitCode !== 0) {
    throw new RunUnderObservationError(
      "failed to start sandbox container",
      `docker run exit=${startRes.exitCode}: ${startRes.stderr.slice(0, 500)}`,
    );
  }

  const ctx: SetupContext = { runId, containerName };

  try {
    // 1. Copy the package into the writable workdir.
    const copyRes = await dockerExec(
      ["exec", containerName, "sh", "-c", "cp -a /pkg-src/. /pkg/"],
      30_000,
    );
    if (copyRes.exitCode !== 0) {
      error = {
        kind: "SetupError",
        detail: `failed to copy /pkg-src to /pkg: ${copyRes.stderr.slice(0, 300)}`,
      };
    }

    // 2. Write L4 instrumentation (if node observation enabled).
    if (error === null && observe.node) {
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

    // 3. Run primitive postStart hooks in declaration order.
    if (error === null) {
      for (const hook of composed.postStarts) {
        try {
          await hook(ctx);
        } catch (err) {
          error = {
            kind: "SetupError",
            detail: err instanceof Error ? err.message : String(err),
          };
          break;
        }
      }
    }

    // 4. L3 fs-diff pre-snapshot (after all setup so plantFiles don't show as changes).
    const runStartSec = Date.now() / 1000;
    if (error === null && observe.fsDiff) {
      try {
        await fsDiffSnapshotPre(containerName, DEFAULT_WATCH_PATHS);
      } catch (err) {
        error = {
          kind: "SensorError",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // 4b. L2 pcap capture start (still before the trigger so we catch the
    // trigger's network activity; after setup so our proxy setup traffic is
    // isolated from the package's own traffic only by timestamp).
    if (error === null && observe.network) {
      try {
        await startPcapCapture(containerName);
      } catch (err) {
        error = {
          kind: "SensorError",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // 5. Build and execute the trigger command (optionally wrapped under strace for L1).
    if (error === null) {
      const cmd = buildTriggerCommand(req.trigger, observe.node);
      if (cmd === null) {
        error = {
          kind: "SetupError",
          detail: `trigger.kind='${req.trigger.kind}' not supported in walking skeleton (Sprint 2)`,
        };
      } else {
        const wrapped = observe.kernel ? wrapWithStrace(cmd) : cmd;
        const res = await dockerExec(["exec", containerName, ...wrapped], budget.wallMs);
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

        if (observe.node) {
          const l4 = parseL4Trace(res.stdout);
          if (l4 === null) {
            if (error === null) {
              error = {
                kind: "SensorError",
                detail: "L4 trace markers absent from stdout (instrumentation evaded or suppressed)",
              };
            }
          } else {
            events.push(...l4);
          }
        }

        if (observe.kernel) {
          const logRes = await dockerExec(
            ["exec", containerName, "cat", "/tmp/strace.log"],
            10_000,
          );
          if (logRes.exitCode === 0 && logRes.stdout) {
            const l1 = parseStraceLog(logRes.stdout, runStartSec);
            events.push(...l1);
            straceLogHash = sha256Hex(logRes.stdout);
          } else if (error === null) {
            error = {
              kind: "SensorError",
              detail: `strace log unreadable: ${logRes.stderr.slice(0, 300)}`,
            };
          }
        }
      }
    }

    // 6. L3 fs-diff post-snapshot + compute diff.
    if (observe.fsDiff && error?.kind !== "SetupError" && error?.kind !== "SensorError") {
      try {
        const diff = await fsDiffSnapshotPostAndDiff(containerName, runStartSec, DEFAULT_WATCH_PATHS);
        events.push(...diff.events);
        if (diff.rawDiff) {
          fsDiffHash = sha256Hex(diff.rawDiff);
        }
      } catch (err) {
        // Demote to a soft error — don't overwrite a harder error (Crash/Timeout).
        if (error === null) {
          error = {
            kind: "SensorError",
            detail: `fs-diff post-snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }

    // 7. L2 pcap stop + extract events.
    if (observe.network && error?.kind !== "SetupError") {
      try {
        const pcap = await stopPcapCaptureAndParse(containerName);
        events.push(...pcap.events);
        if (pcap.rawPcap.length > 0) {
          pcapHash = sha256Hex(pcap.rawPcap);
        }
      } catch (err) {
        if (error === null) {
          error = {
            kind: "SensorError",
            detail: `pcap stop/parse failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }
  } finally {
    await dockerExec(["rm", "-f", containerName], 10_000).catch(() => {});
  }

  const wallMs = Date.now() - startedAt;
  events.sort((a, b) => a.timestamp - b.timestamp);

  const setupApplied: SetupApplied = {
    env: composed.applied.env ?? {},
    date: composed.applied.date ?? null,
    plantFiles: composed.applied.plantFiles ?? [],
    stubUrls: composed.applied.stubUrls ?? [],
    hostname: composed.applied.hostname ?? null,
    locale: composed.applied.locale ?? null,
    patches: composed.applied.patches ?? [],
    preloadHash: composed.applied.preloadHash ?? null,
  };

  const draft: Omit<RunArtifact, "contentHash"> = {
    runId,
    triggerUsed: req.trigger,
    setupApplied,
    observe,
    budget,
    wallMs,
    exitCode,
    timedOut,
    events,
    stdoutHash,
    stderrHash,
    fsDiffHash,
    pcapHash,
    straceLogHash,
    inspectorLogHash: null,
    eventSummary: computeEventSummary(events),
    error,
    createdAt,
  };

  return sealRunArtifact(draft);
}
