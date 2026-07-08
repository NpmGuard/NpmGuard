import type {
  ClaimKind,
  Hypothesis,
  RunArtifact,
  EvidenceRef,
  Trigger,
  Event,
} from "@npmguard/shared";
import type { Manipulation } from "../manipulation/types.js";
import { setEnv } from "../manipulation/env.js";
import { plantFiles } from "../manipulation/plant-files.js";
import { runUnderObservation, type RunRequest } from "../evidence/run-under-observation.js";

// ---------------------------------------------------------------------------
// Strategy — one per ClaimKind, describes what to run + how to confirm
// ---------------------------------------------------------------------------

export interface ExperimentStrategy {
  trigger: Trigger;
  setup: readonly Manipulation[];
  observe: RunRequest["observe"];
  budget: RunRequest["budget"];
  confirm: (artifact: RunArtifact) => ConfirmationCheck;
}

export interface ConfirmationCheck {
  confirmed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------------
// Confirmation helpers (pure — operate on RunArtifact + events)
// ---------------------------------------------------------------------------

const PLANTED_TOKEN = "NPMGUARD_CANARY_TOKEN_f8e2d91a";

function eventsContainTokenExfil(events: readonly Event[]): boolean {
  for (const e of events) {
    if (e.stream === "L2:pcap" || e.stream === "L4:monkey") {
      const raw = typeof e.raw === "string" ? e.raw : JSON.stringify(e.raw ?? "");
      if (raw.includes(PLANTED_TOKEN)) return true;
    }
    if (e.normalized) {
      const norm = JSON.stringify(e.normalized);
      if (norm.includes(PLANTED_TOKEN)) return true;
    }
  }
  return false;
}

function eventsContainNetwork(events: readonly Event[]): boolean {
  return events.some(
    (e) =>
      e.kind === "connect" ||
      e.kind === "http_request" ||
      e.kind === "dns_query" ||
      e.kind === "tcp_syn" ||
      e.kind === "tls_sni" ||
      (e.kind === "network" && e.stream === "L4:monkey"),
  );
}

function eventsContainExecve(events: readonly Event[]): boolean {
  return events.some((e) => e.kind === "execve");
}

/** fs methods that create or modify files. The L4 instrumentation
 *  (sandbox/instrumentation.ts) also traces readers (readFile*, accessSync,
 *  statSync) under the same `fs_op` kind — every package reads its own entry
 *  file during require(), so reads must never count as persistence evidence. */
const FS_WRITE_METHODS = new Set([
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "mkdir",
  "mkdirSync",
]);

function fsOpMethod(e: Event): string | null {
  const norm = e.normalized?.method;
  if (typeof norm === "string") return norm;
  const raw = e.raw as { method?: unknown } | null | undefined;
  return typeof raw?.method === "string" ? raw.method : null;
}

/** True only for evidence of a real file write: L3 fsDiff (actual filesystem
 *  diffing) or an L4 fs_op with a writer method. L1 `write()` syscalls are
 *  deliberately excluded — they fire on ANY fd, including stdout/pipes (chiefly
 *  our own __NPMGUARD_TRACE__ output), so they confirm on every package. */
function eventsContainFsWrite(events: readonly Event[]): boolean {
  return events.some((e) => {
    if (e.kind === "file_created" || e.kind === "file_modified") return true;
    if (e.kind === "fs_op" && e.stream === "L4:monkey") {
      const method = fsOpMethod(e);
      return method !== null && FS_WRITE_METHODS.has(method);
    }
    return false;
  });
}

function eventsContainFsDelete(events: readonly Event[]): boolean {
  return events.some(
    (e) =>
      e.kind === "file_deleted" ||
      e.kind === "unlink" ||
      e.kind === "rename",
  );
}

function eventsContainEval(events: readonly Event[]): boolean {
  return events.some(
    (e) => e.kind === "eval" || e.kind === "script_parsed",
  );
}

export function eventsContainDnsWithPayload(events: readonly Event[]): boolean {
  return events.some((e) => {
    if (e.kind !== "dns_query") return false;
    const raw = typeof e.raw === "string" ? e.raw : JSON.stringify(e.raw ?? "");
    // DNS exfil typically encodes data as long subdomains
    const hasLongLabel = /\b[a-z0-9]{20,}\./i.test(raw);
    return hasLongLabel;
  });
}

/**
 * Whether a claim kind has an automated dynamic experiment. The orchestrator
 * routes dynamic claims to the experimenter (reproduce → CONFIRMED with a
 * RunArtifact) and static claims to the code-reader. Kept in lockstep with the
 * `null`-returning cases of `strategyForClaim`.
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
  switch (claim) {
    case "env_exfil":
    case "cred_theft":
      return {
        trigger: { kind, target, argv: [], stdin: null },
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
        confirm(artifact) {
          if (eventsContainTokenExfil(artifact.events)) {
            return { confirmed: true, reason: "Canary token appeared in network traffic." };
          }
          if (eventsContainNetwork(artifact.events)) {
            return { confirmed: true, reason: "Network activity detected after planting credentials." };
          }
          return { confirmed: false, reason: "No credential exfiltration detected." };
        },
      };

    case "binary_drop":
      return {
        trigger: { kind, target, argv: [], stdin: null },
        setup: [],
        observe: { kernel: true, network: true, node: true, fsDiff: true, inspector: false },
        budget: { wallMs: 20_000 },
        confirm(artifact) {
          if (eventsContainExecve(artifact.events) && eventsContainNetwork(artifact.events)) {
            return { confirmed: true, reason: "Spawned external process after network fetch." };
          }
          if (eventsContainExecve(artifact.events)) {
            return { confirmed: true, reason: "Spawned external process." };
          }
          return { confirmed: false, reason: "No binary drop behavior observed." };
        },
      };

    case "dos_loop":
      return {
        trigger: { kind, target, argv: [], stdin: null },
        setup: [],
        observe: { kernel: true, node: true, fsDiff: false, network: false, inspector: false },
        budget: { wallMs: 5_000 },
        confirm(artifact) {
          if (artifact.timedOut) {
            return { confirmed: true, reason: "Process timed out — infinite loop or resource exhaustion." };
          }
          return { confirmed: false, reason: "Process completed within budget." };
        },
      };

    case "obfuscation":
      return {
        trigger: { kind, target, argv: [], stdin: null },
        setup: [],
        observe: { kernel: false, network: false, node: true, fsDiff: false, inspector: true },
        budget: { wallMs: 15_000 },
        confirm(artifact) {
          if (eventsContainEval(artifact.events)) {
            return { confirmed: true, reason: "Dynamic code evaluation detected at runtime." };
          }
          return { confirmed: false, reason: "No dynamic code evaluation observed." };
        },
      };

    case "persistence":
      return {
        trigger: { kind, target, argv: [], stdin: null },
        setup: [],
        observe: { kernel: true, node: true, fsDiff: true, network: false, inspector: false },
        budget: { wallMs: 15_000 },
        confirm(artifact) {
          if (eventsContainFsWrite(artifact.events)) {
            return { confirmed: true, reason: "Filesystem writes detected — possible persistence mechanism." };
          }
          return { confirmed: false, reason: "No filesystem persistence observed." };
        },
      };

    case "dns_exfil":
      return {
        trigger: { kind, target, argv: [], stdin: null },
        setup: [
          setEnv({
            NPM_TOKEN: PLANTED_TOKEN,
            HOME: "/home/node",
          }),
        ],
        observe: { kernel: true, network: true, node: true, fsDiff: false, inspector: false },
        budget: { wallMs: 15_000 },
        confirm(artifact) {
          if (eventsContainDnsWithPayload(artifact.events)) {
            return { confirmed: true, reason: "DNS query with encoded payload subdomain detected." };
          }
          return { confirmed: false, reason: "No DNS exfiltration pattern observed." };
        },
      };

    case "telemetry":
    case "build_plugin_exfil":
      return {
        trigger: { kind, target, argv: [], stdin: null },
        setup: [
          setEnv({
            NPM_TOKEN: PLANTED_TOKEN,
            CI: "true",
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
        budget: { wallMs: 20_000 },
        confirm(artifact) {
          if (eventsContainTokenExfil(artifact.events)) {
            return { confirmed: true, reason: "Canary credential appeared in outbound telemetry/build traffic." };
          }
          if (eventsContainNetwork(artifact.events)) {
            return { confirmed: true, reason: "Outbound network activity detected from telemetry/build-plugin path." };
          }
          return { confirmed: false, reason: "No outbound telemetry or build-plugin exfiltration observed." };
        },
      };

    case "destructive":
      return {
        trigger: { kind, target, argv: [], stdin: null },
        setup: [
          plantFiles([
            { path: "/pkg/sandbox-test/file1.txt", content: "NPMGUARD_CANARY_DELETE_TARGET\n" },
            { path: "/pkg/sandbox-test/file2.txt", content: "NPMGUARD_CANARY_DELETE_TARGET\n" },
          ]),
        ],
        observe: { kernel: true, network: false, node: true, fsDiff: true, inspector: false },
        budget: { wallMs: 20_000 },
        confirm(artifact) {
          if (eventsContainFsDelete(artifact.events)) {
            return { confirmed: true, reason: "Deletion or rename activity detected against planted files." };
          }
          return { confirmed: false, reason: "No destructive filesystem activity observed." };
        },
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
  artifact: RunArtifact;
  evidenceRef: EvidenceRef;
}

/**
 * Run an experiment for a single hypothesis. Selects a strategy based on the
 * claim type, runs the package under observation, and checks the results.
 * Returns null if no strategy exists for this claim type.
 */
export async function runExperiment(
  hypothesis: Hypothesis,
  packagePath: string,
  entryTarget: string,
  installEntries: readonly string[] = [],
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

  const check = strategy.confirm(artifact);
  const evidenceRef: EvidenceRef = {
    kind: "run",
    id: artifact.runId,
    hash: artifact.contentHash,
  };

  console.log(
    `[experimenter] ${hypothesis.hypId}: ${check.confirmed ? "CONFIRMED" : "not confirmed"} — ${check.reason}`,
  );

  return {
    confirmed: check.confirmed,
    reason: check.reason,
    artifact,
    evidenceRef,
  };
}
