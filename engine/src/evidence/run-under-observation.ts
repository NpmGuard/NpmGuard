import assert from "node:assert";
import { randomUUID } from "node:crypto";
import type {
  Budget,
  Event,
  ObserveFlags,
  RunArtifact,
  RunError,
  SetupApplied,
  ToolCall,
  Trigger,
} from "@npmguard/shared";
import { compileExperiment } from "../sandbox/tools.js";
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
import { allocateHostPort, attachV8Inspector } from "../sensors/v8-inspector.js";

/**
 * Input to `runUnderObservation`.
 *
 * A run needs a concrete `{ trigger, setup }`. Callers supply that one of two
 * ways, never both:
 *   - directly, via `trigger` (+ optional `setup` manipulations); or
 *   - via `experiment` — a `ToolCall[]` from the shared tool registry, which
 *     `compileExperiment` turns into the same `{ trigger, setup }`.
 * The experiment path is how a HYPOTHESIZE-composed experiment runs; the direct
 * path is the low-level primitive interface. `resolveRunInputs` collapses both
 * to a concrete trigger+setup before anything else runs.
 *
 * `setup` primitives (setEnv, setDate, plantFiles, stubUrl, patchFile, preload)
 * are composed into the container launch and their postStart hooks run after
 * boot.
 */
export interface RunRequest {
  packagePath: string;
  trigger?: Trigger;
  setup?: readonly Manipulation[];
  experiment?: readonly ToolCall[];
  observe?: Partial<ObserveFlags>;
  budget?: Partial<Budget>;
  containerSpec?: Partial<ContainerSpec>;
}

/**
 * Collapse the two input forms to a concrete `{ trigger, setup }`. Enforces the
 * boundary invariant: exactly one form is given (an experiment XOR an explicit
 * trigger). A request that supplies both, or neither, is incoherent — an error,
 * not something to guess around.
 */
function resolveRunInputs(req: RunRequest): { trigger: Trigger; setup: readonly Manipulation[] } {
  if (req.experiment !== undefined) {
    assert(
      req.trigger === undefined && req.setup === undefined,
      "runUnderObservation: pass an `experiment` OR `trigger`/`setup`, not both",
    );
    const compiled = compileExperiment(req.experiment);
    return { trigger: compiled.trigger, setup: compiled.setup };
  }
  assert(req.trigger !== undefined, "runUnderObservation: a run needs a `trigger` or an `experiment`");
  return { trigger: req.trigger, setup: req.setup ?? [] };
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
  const { trigger, setup: primitives } = resolveRunInputs(req);
  const observe: ObserveFlags = { ...DEFAULT_OBSERVE, ...req.observe };
  const budget: Budget = { ...DEFAULT_BUDGET, ...req.budget };

  // Inspector needs the host to reach the container's inspector port, which
  // requires bridge networking (Docker's -p flag is a no-op on --network=none).
  const needsBridge = observe.network || observe.inspector;
  // Host port allocation for inspector — done before spec build so the
  // publishPorts list includes the mapping.
  const inspectorHostPort = observe.inspector ? await allocateHostPort("127.0.0.1") : null;

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
    networkMode: needsBridge ? "bridge" : "none",
    capAdd: [
      ...(observe.kernel ? ["SYS_PTRACE"] : []),
      // tcpdump (launched as root in the exec, run with `-Z root`) needs
      // NET_RAW (capture socket) + SETUID/SETGID (the no-op setuid(0) that
      // `-Z root` still performs internally). Keeping tcpdump as root avoids
      // CHOWN (no pcap chown) and KILL (root-to-root signal) caps.
      ...(observe.network ? ["NET_RAW", "SETUID", "SETGID"] : []),
    ],
    publishPorts: inspectorHostPort !== null
      ? [{ hostPort: inspectorHostPort, containerPort: 9229 }]
      : [],
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
  let inspectorLogHash: string | null = null;

  // Start the container.
  const runArgs = specToDockerArgs(spec, containerName);
  const startRes = await dockerExec(runArgs, 30_000);
  if (startRes.exitCode !== 0) {
    throw new RunUnderObservationError(
      "failed to start sandbox container",
      `docker run exit=${startRes.exitCode}: ${startRes.stderr.slice(0, 500)}`,
    );
  }

  const ctx: SetupContext = { runId, containerName };

  try {
    // 0. L2 pcap capture must start BEFORE any other `docker exec` against
    //    the container AND after the bridge has a moment to settle.
    //    Empirically, without these two constraints, `docker exec -d tcpdump`
    //    opens the pcap file but silently fails to capture real traffic —
    //    only ARP/ICMPv6 ever land in the dump. We've traced this to a race
    //    between tcpdump's packet-ring init and the bridge-netns coming
    //    online; a short settle delay + starting tcpdump first clears it.
    //    The tshark DNS/HTTP/TLS filter at stop time drops the small amount
    //    of container-boot traffic that leaks into the capture.
    if (observe.network) {
      // Short settle so the bridge netns has a beat to wire up before
      // tcpdump attaches. Empirically < 300ms → ring init can race with
      // route setup; ≥ 1500ms → bridge enters some "quieted" state where
      // tcpdump misses the traffic entirely. 300ms is the sweet spot on
      // this host; consistency is load-dependent (see full-smoke note in
      // pcap.test.ts).
      await new Promise((r) => setTimeout(r, 300));
      try {
        await startPcapCapture(containerName);
      } catch (err) {
        error = {
          kind: "SensorError",
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // 1. Copy the package into the writable workdir.
    if (error === null) {
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

    // 5. Build and execute the trigger command (optionally wrapped under strace for L1).
    if (error === null) {
      const cmd = buildTriggerCommand(trigger, {
        l4: observe.node,
        inspector: observe.inspector,
      });
      if (cmd === null) {
        error = {
          kind: "SetupError",
          detail: `trigger.kind='${trigger.kind}' has no run command`,
        };
      } else {
        const wrapped = observe.kernel ? wrapWithStrace(cmd) : cmd;

        // When inspector is active, fire the trigger asynchronously and
        // attach CDP in parallel. The trigger is paused at startup by
        // --inspect-brk; attachV8Inspector's Runtime.runIfWaitingForDebugger
        // releases it. budget.wallMs is the safety net that kills a paused
        // Node if the host CDP attach fails.
        const tTriggerStart = Date.now();
        const triggerPromise = dockerExec(["exec", containerName, ...wrapped], budget.wallMs);

        if (observe.inspector && inspectorHostPort !== null) {
          try {
            const inspectorHandle = await attachV8Inspector({
              host: "127.0.0.1",
              port: inspectorHostPort,
            });

            // Node with `--inspect` blocks exit on "Waiting for debugger to
            // disconnect..." once CDP is attached. We wait for the V8 context
            // to be destroyed (which happens on process.exit or event-loop
            // drain) OR a budget-bounded timeout, then close CDP so Node can
            // finish exiting. This keeps inspector runs fast instead of
            // hanging until budget.wallMs.
            const remainingBudget = Math.max(
              500,
              Math.min(budget.wallMs - (Date.now() - tTriggerStart), 10_000),
            );
            await inspectorHandle.waitForExit(remainingBudget);
            events.push(...inspectorHandle.events);
            const raw = inspectorHandle.rawLog();
            if (raw) inspectorLogHash = sha256Hex(raw);
            await inspectorHandle.close();
          } catch (err) {
            error = {
              kind: "SensorError",
              detail: `v8-inspector attach failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            };
          }
        }

        const res = await triggerPromise;
        if (observe.network) {
          const nd = await dockerExec(["exec","--user","0",containerName,"cat","/proc/net/dev"], 5_000);
          process.stderr.write(`[net-dev-debug]\n${nd.stdout}\n`);
        }
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
    triggerUsed: trigger,
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
    inspectorLogHash,
    eventSummary: computeEventSummary(events),
    error,
    createdAt,
  };

  return sealRunArtifact(draft);
}
