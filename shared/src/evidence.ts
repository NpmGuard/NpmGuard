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
export const StreamKindSchema = StreamKind;
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
export const EventKindSchema = EventKind;
export type EventKind = z.infer<typeof EventKind>;

export const CorrelationConfidence = z.enum(["high", "low", "none"]);
export const CorrelationConfidenceSchema = CorrelationConfidence;
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
export const EvidenceEventSchema = Event;
export type Event = z.infer<typeof Event>;

// ---------------------------------------------------------------------------
// Evidence references — typed pointers to RunArtifact / (future) DifferentialArtifact
// ---------------------------------------------------------------------------

// "run"    — a dynamic RunArtifact (reproduced behavior). Every terminal
//            hypothesis is backed by one: a CONFIRMED cites the run where the
//            payload fired, a REFUTED the run where it was triggered and did not.
//            Nothing clears or blocks an install except by running it.
// "static" — reserved; no current producer.
// "diff"   — reserved for the differential engine.
export const EvidenceRefKind = z.enum(["run", "static", "diff"]);
export const EvidenceRefKindSchema = EvidenceRefKind;
export type EvidenceRefKind = z.infer<typeof EvidenceRefKind>;

export const EvidenceRef = z.object({
  kind: EvidenceRefKind,
  id: z.string(),
  hash: z.string(),
});
export const EvidenceRefSchema = EvidenceRef;
export type EvidenceRef = z.infer<typeof EvidenceRef>;

// ---------------------------------------------------------------------------
// Trigger — how the package was invoked for this run
// ---------------------------------------------------------------------------

export const TriggerKind = z.enum(["entrypoint", "lifecycle", "bin", "subpath"]);
export const TriggerKindSchema = TriggerKind;
export type TriggerKind = z.infer<typeof TriggerKind>;

export const LifecycleHook = z.enum(["preinstall", "install", "postinstall", "prepare"]);
export const LifecycleHookSchema = LifecycleHook;
export type LifecycleHook = z.infer<typeof LifecycleHook>;

export const Trigger = z.object({
  kind: TriggerKind,
  target: z.string(), // entrypoint file, hook name, bin name, or subpath
  argv: z.array(z.string()).default([]),
  stdin: z.string().nullable().default(null),
});
export const TriggerSchema = Trigger;
export type Trigger = z.infer<typeof Trigger>;

// ---------------------------------------------------------------------------
// ToolCall — one step of an experiment the LLM composes from the shared tool
// registry (engine/npmguard/experiments.py). `args` is intentionally opaque here:
// the registry validates it against the named tool's per-tool Zod paramSchema,
// so the strong typing lives at the single point that both renders the tool
// list to the prompt and executes the calls. An `args` shape that a tool's
// schema rejects is an incoherent experiment (an ERROR), never silently run.
// ---------------------------------------------------------------------------

export const ToolCall = z.object({
  tool: z.string(),
  args: z.record(z.unknown()).default({}),
});
export const ToolCallSchema = ToolCall;
export type ToolCall = z.infer<typeof ToolCall>;

// ---------------------------------------------------------------------------
// Setup — what manipulation was applied before the run
// ---------------------------------------------------------------------------

export const PlantedFileRef = z.object({
  path: z.string(),
  contentHash: z.string(),
});
export const PlantedFileRefSchema = PlantedFileRef;
export type PlantedFileRef = z.infer<typeof PlantedFileRef>;

// A stub ref is a claim about the RUN, not about the plan. `responseHash` is the
// hash of the response the stub proxy actually WROTE — read back from the proxy's
// own served ledger after the run — and is `null` exactly when the stub served
// nothing. So `responseHash !== null` *is* the statement "this canned response was
// served", and an artifact has no way to make that statement falsely.
// Nullable-and-nothing-more is deliberate: any ADDED field would change the
// canonical form of every sealed artifact ever recorded, hence its contentHash, and
// a served-request count is not needed to state the fact that matters.
export const StubUrlRef = z.object({
  pattern: z.string(),
  responseHash: z.string().nullable(),
});
export const StubUrlRefSchema = StubUrlRef;
export type StubUrlRef = z.infer<typeof StubUrlRef>;

export const FilePatchRef = z.object({
  path: z.string(),
  patchHash: z.string(),
});
export const FilePatchRefSchema = FilePatchRef;
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
export const SetupAppliedSchema = SetupApplied;
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
export const ObserveFlagsSchema = ObserveFlags;
export type ObserveFlags = z.infer<typeof ObserveFlags>;

// FALSE EVIDENCE, PINNED FOR DELETION (test_evidence.py C18, xfail(strict)).
// `wallMs` is real: it is the `docker exec` timeout, and a breach seals a
// TimeoutError plus a synthetic `truncated` event.
//
// `maxSyscalls` and `maxBytesCapture` are read by NOTHING (grep, whole engine), and
// the caps that do exist are unrelated to them — `docker_exec` truncates stdout at
// 10 MiB, `deps._stream_tar` at 256 MiB. So every artifact sealing
// `maxBytesCapture: 1000000` asserts a capture bound the run never applied: the same
// class of defect as a `responseHash` for a response no stub served, and the reason
// to delete them rather than start enforcing them (an honest capture bound is a loud
// failure, not a silent cap — see engine/TESTING.md's `docker_exec` finding).
//
// Not deleted here because REMOVING a sealed field changes the canonical form, hence
// the contentHash, of every artifact ever sealed — the mirror of the reason
// StubUrlRef could only be widened, not extended. Concretely: the orchestrator
// cross-checks `artifact.contentHash` against an independent recomputation
// (orchestrator.py step D), so all 31 committed runartifacts fail that check the
// moment this field set changes, and three slice replays go red. The migration is
// free and mechanical, not a paid re-record — re-seal each
// tests/fixtures/llm/*/sandbox/*.runartifact.json under the new schema and update its
// `sha256` in the bundle manifest — but it is a fixture edit, which is the owner's
// call.
export const Budget = z.object({
  wallMs: z.number().positive(),
  maxSyscalls: z.number().positive().nullable().default(null),
  maxBytesCapture: z.number().positive().nullable().default(null),
});
export const BudgetSchema = Budget;
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
export const RunErrorKindSchema = RunErrorKind;
export type RunErrorKind = z.infer<typeof RunErrorKind>;

export const RunError = z.object({
  kind: RunErrorKind,
  detail: z.string(),
});
export const RunErrorSchema = RunError;
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
export const EventSummarySchema = EventSummary;
export type EventSummary = z.infer<typeof EventSummary>;

// ---------------------------------------------------------------------------
// Frontend-safe projections of a run — what may cross the SSE boundary
// ---------------------------------------------------------------------------
//
// A `RunArtifact` is the sealed unit of evidence and it is NOT shippable: its
// events carry raw strace buffers, captured request bodies, compiled script
// source and planted environment values. The shapes below are the bounded,
// redacted view a viewer is allowed to see.
//
// THE REDACTION RULE, stated once: a display value may name WHERE something
// went and WHAT was touched — host, port, path, module specifier, environment
// KEY — and may never carry the bytes. A payload is described by its size, its
// outcome, and which engine-minted canaries it carried, never by its content.
// "Package-generated content off the wire" is not a hardening measure; it is
// what keeps a shared audit link safe to paste when the package under test read
// a real developer's `~/.npmrc`.

// Why an observation was kept when the display bound is spent.
//   high    — the behaviour a judge would cite: network, credential-file reads,
//             environment access, process spawn, eval, crypto, destructive fs.
//   context — a neighbour of a high-signal event, kept so a citation reads in
//             sequence rather than alone.
//   error   — a run error or a truncation. Never dropped, at any bound.
export const ObservationSignal = z.enum(["high", "context", "error"]);
export const ObservationSignalSchema = ObservationSignal;
export type ObservationSignal = z.infer<typeof ObservationSignal>;

// One row of the timeline the judge read, redacted for display.
//
// `eventId` is the identity the JUDGE cites (`hypothesis_resolved.citedEventIds`),
// assigned by `render_timeline` — so the two join exactly and the frontend never
// has to guess which observation a citation means. It is a per-run identity
// ("e14"), not a global one.
//
// `occurrences` is the timeline's own collapse count. Without it, 44 DNS packets
// carrying 44 chunks of a credential dump render as one line and the display
// understates the run.
export const DisplayObservation = z.object({
  eventId: z.string(),
  atMs: z.number().nonnegative(),
  stream: StreamKind,
  kind: EventKind,
  summary: z.string(),
  signal: ObservationSignal,
  occurrences: z.number().int().positive(),
});
export const DisplayObservationSchema = DisplayObservation;
export type DisplayObservation = z.infer<typeof DisplayObservation>;

// A stub as the display states it. `served` is `StubUrlRef.responseHash !== null`
// — the fact that matters ("the endpoint we told you was stubbed was actually
// contacted"), carried as the boolean it always was.
export const DisplayStub = z.object({
  pattern: z.string(),
  served: z.boolean(),
});
export const DisplayStubSchema = DisplayStub;
export type DisplayStub = z.infer<typeof DisplayStub>;

// `SetupApplied` minus every value. Environment KEYS are named because "we
// planted GITHUB_TOKEN and it left the process" is the whole point; the values
// are bait this engine planted, and bait is still a token-shaped string nobody
// needs to read off a public page.
//
// There is no per-key "is this synthetic" flag because there is no per-key
// question: a value in `SetupApplied.env` was written BY the experiment, so all
// of them are synthetic and a viewer needs to be told that once, not per row.
// The UI renders them `[synthetic secret]` — which is a label, where a blanked
// field would read as "a real credential is being hidden".
export const SanitizedSetup = z.object({
  envKeys: z.array(z.string()),
  date: z.string().nullable(),
  plantedFiles: z.array(PlantedFileRef),
  stubUrls: z.array(DisplayStub),
  hostname: z.string().nullable(),
  locale: z.string().nullable(),
  patchedFiles: z.array(z.string()),
  preloaded: z.boolean(),
});
export const SanitizedSetupSchema = SanitizedSetup;
export type SanitizedSetup = z.infer<typeof SanitizedSetup>;

// The raw-capture digests, carried so an inspector can state that a capture
// exists and name it. A hash is not content.
export const RunCaptures = z.object({
  stdoutHash: z.string().nullable(),
  stderrHash: z.string().nullable(),
  fsDiffHash: z.string().nullable(),
  pcapHash: z.string().nullable(),
  straceLogHash: z.string().nullable(),
});
export const RunCapturesSchema = RunCaptures;
export type RunCaptures = z.infer<typeof RunCaptures>;

// What `sandbox_completed` carries. Bounded by construction: `observations` is a
// deterministic selection and `omittedObservationCount` states exactly what the
// selection dropped, so a truncated display can never read as a complete one.
//
// The judge has NOT run when this is emitted. So the observation set here is a
// PREVIEW, and `hypothesis_resolved.citedObservations` carries every cited row
// independently of this bound — the frontend merges the two by `eventId`.
export const RunDisplay = z.object({
  runId: z.string(),
  wallMs: z.number().nonnegative(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  eventCount: z.number().int().nonnegative(),
  eventSummary: EventSummary,
  error: RunError.nullable(),
  setupApplied: SanitizedSetup,
  observations: z.array(DisplayObservation),
  omittedObservationCount: z.number().int().nonnegative(),
  captures: RunCaptures,
  contentHash: z.string(),
});
export const RunDisplaySchema = RunDisplay;
export type RunDisplay = z.infer<typeof RunDisplay>;

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
  // FALSE EVIDENCE, PINNED FOR DELETION (test_evidence.py C18, xfail(strict)).
  // `null` in every artifact ever sealed, and structurally unfillable: the inspector's
  // events are written into the same delimited stdout blob as the monkey log by
  // instrumentation-flush.js, so the bytes it would hash are already covered by
  // `stdoutHash`. A field that can only ever be null states "this sensor produced no
  // raw output" about a sensor that runs on every full-oracle run and does produce
  // output. Same deletion blocker as Budget above (the contentHash of all 31 recorded
  // artifacts), same free migration.
  inspectorLogHash: z.string().nullable().default(null),
  eventSummary: EventSummary,
  error: RunError.nullable().default(null),
  contentHash: z.string(),
  createdAt: z.string(), // ISO timestamp
});
export const RunArtifactSchema = RunArtifact;
export type RunArtifact = z.infer<typeof RunArtifact>;
