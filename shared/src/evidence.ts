import { z } from "zod";

// ---------------------------------------------------------------------------
// Observation streams — which sensor produced an event
// ---------------------------------------------------------------------------

export const StreamKind = z.enum([
  "L1:seccomp",     // kernel syscalls (strace in v1, seccomp-audit later)
  "L2:pcap",        // netns network capture (tcpdump)
  "L3:fsDiff",      // overlayfs diff (docker diff)
  "L4:monkey",      // Node monkey-patch instrumentation
  "L4:v8inspector", // Chrome DevTools Protocol events
  "engine",         // synthetic engine-origin events (truncation, bypass, error)
]);
export type StreamKind = z.infer<typeof StreamKind>;

export const EventKind = z.enum([
  // L1 kernel syscalls
  "openat", "read", "write", "connect", "sendto", "execve", "clone", "unlink", "rename", "link",
  // L2 netns network
  "dns_query", "http_request", "tls_sni", "tcp_syn",
  // L3 fs diff
  "file_created", "file_modified", "file_deleted",
  // L4 monkey-patch (mirrors sandbox/instrumentation.ts kinds)
  "require", "env_access", "fs_op", "network", "process", "eval", "crypto", "timer",
  // L4 inspector
  "script_parsed", "debugger_paused",
  // engine synthetic
  "truncated", "setup_bypass", "error",
]);
export type EventKind = z.infer<typeof EventKind>;

export const CorrelationConfidence = z.enum(["high", "low", "none"]);
export type CorrelationConfidence = z.infer<typeof CorrelationConfidence>;

export const Event = z.object({
  stream: StreamKind,
  timestamp: z.number().nonnegative(), // nanoseconds from run start
  pid: z.number().int(),
  kind: EventKind,
  raw: z.unknown(),                     // sensor-specific payload
  normalized: z.record(z.unknown()).optional(), // queryable projection
  derived: z.object({
    jsFrame: z.string().optional(),
    module: z.string().optional(),
    callStack: z.array(z.string()).default([]),
    confidence: CorrelationConfidence.default("none"),
  }).optional(),
});
export type Event = z.infer<typeof Event>;

// ---------------------------------------------------------------------------
// Evidence references — typed pointers to RunArtifact / (future) DifferentialArtifact
// ---------------------------------------------------------------------------

// "run"    — a dynamic RunArtifact (reproduced behavior). The ONLY evidence
//            kind that may back a CONFIRMED hypothesis, per the chain-of-custody
//            axiom: nothing blocks an install unless it was observed firing.
// "static" — a code-reader reading. May back a REFUTED hypothesis ("read the
//            code, it does not implement the claim") but NEVER a CONFIRMED one.
// "diff"   — reserved for the differential engine (v2 tuning phase).
export const EvidenceRefKind = z.enum(["run", "static", "diff"]);
export type EvidenceRefKind = z.infer<typeof EvidenceRefKind>;

export const EvidenceRef = z.object({
  kind: EvidenceRefKind,
  id: z.string(),
  hash: z.string(),
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

// ---------------------------------------------------------------------------
// Trigger — how the package was invoked for this run
// ---------------------------------------------------------------------------

export const TriggerKind = z.enum(["entrypoint", "lifecycle", "bin", "subpath"]);
export type TriggerKind = z.infer<typeof TriggerKind>;

export const LifecycleHook = z.enum(["preinstall", "install", "postinstall", "prepare"]);
export type LifecycleHook = z.infer<typeof LifecycleHook>;

export const Trigger = z.object({
  kind: TriggerKind,
  target: z.string(), // entrypoint file, hook name, bin name, or subpath
  argv: z.array(z.string()).default([]),
  stdin: z.string().nullable().default(null),
});
export type Trigger = z.infer<typeof Trigger>;

// ---------------------------------------------------------------------------
// Setup — what manipulation was applied before the run
// ---------------------------------------------------------------------------

export const PlantedFileRef = z.object({
  path: z.string(),
  contentHash: z.string(),
});
export type PlantedFileRef = z.infer<typeof PlantedFileRef>;

export const StubUrlRef = z.object({
  pattern: z.string(),
  responseHash: z.string(),
});
export type StubUrlRef = z.infer<typeof StubUrlRef>;

export const FilePatchRef = z.object({
  path: z.string(),
  patchHash: z.string(),
});
export type FilePatchRef = z.infer<typeof FilePatchRef>;

export const SetupApplied = z.object({
  env: z.record(z.string()).default({}),
  date: z.string().nullable().default(null), // ISO if setDate was used
  plantFiles: z.array(PlantedFileRef).default([]),
  stubUrls: z.array(StubUrlRef).default([]),
  hostname: z.string().nullable().default(null),
  locale: z.string().nullable().default(null),
  patches: z.array(FilePatchRef).default([]),
  preloadHash: z.string().nullable().default(null),
});
export type SetupApplied = z.infer<typeof SetupApplied>;

// ---------------------------------------------------------------------------
// Observation toggles + run budget
// ---------------------------------------------------------------------------

export const ObserveFlags = z.object({
  kernel: z.boolean(),
  network: z.boolean(),
  fsDiff: z.boolean(),
  node: z.boolean(),
  inspector: z.boolean().default(false), // V8 Inspector added in Sprint 5
});
export type ObserveFlags = z.infer<typeof ObserveFlags>;

export const Budget = z.object({
  wallMs: z.number().positive(),
  maxSyscalls: z.number().positive().nullable().default(null),
  maxBytesCapture: z.number().positive().nullable().default(null),
});
export type Budget = z.infer<typeof Budget>;

// ---------------------------------------------------------------------------
// Run error taxonomy
// ---------------------------------------------------------------------------

export const RunErrorKind = z.enum([
  "CrashError",    // Node process exited non-zero; stack in stderr
  "TimeoutError",  // wall-clock budget exceeded; container killed
  "SensorError",   // a sensor failed to start or parse
  "SetupError",    // a manipulation primitive failed to apply
]);
export type RunErrorKind = z.infer<typeof RunErrorKind>;

export const RunError = z.object({
  kind: RunErrorKind,
  detail: z.string(),
});
export type RunError = z.infer<typeof RunError>;

// ---------------------------------------------------------------------------
// RunArtifact — the unit of evidence
// ---------------------------------------------------------------------------

export const EventSummary = z.object({
  uniqueHosts: z.array(z.string()).default([]),
  uniqueSyscalls: z.array(z.string()).default([]),
  filesWritten: z.array(z.string()).default([]),
  dnsQueries: z.array(z.string()).default([]),
});
export type EventSummary = z.infer<typeof EventSummary>;

export const RunArtifact = z.object({
  runId: z.string(),
  triggerUsed: Trigger,
  setupApplied: SetupApplied,
  observe: ObserveFlags,
  budget: Budget,
  wallMs: z.number().nonnegative(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  events: z.array(Event),
  stdoutHash: z.string().nullable().default(null),
  stderrHash: z.string().nullable().default(null),
  fsDiffHash: z.string().nullable().default(null),
  pcapHash: z.string().nullable().default(null),
  straceLogHash: z.string().nullable().default(null),
  inspectorLogHash: z.string().nullable().default(null),
  eventSummary: EventSummary,
  error: RunError.nullable().default(null),
  contentHash: z.string(),
  createdAt: z.string(), // ISO timestamp
});
export type RunArtifact = z.infer<typeof RunArtifact>;
