import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums — cross-process audit vocabulary
// ---------------------------------------------------------------------------

// The verdict of a COMPLETED audit. DANGEROUS ⟺ a CONFIRMED hypothesis (cited
// dynamic proof) and blocks an install; SAFE ⟺ every suspicion ran and showed no
// malice (presumption of innocence). An audit that cannot complete is not a
// verdict — it is a retryable AuditIncompleteError, so "we couldn't check" can
// never leak out as a result.
export const VerdictEnum = z.enum(["SAFE", "DANGEROUS"]);
export const VerdictSchema = VerdictEnum;
export type VerdictEnum = z.infer<typeof VerdictEnum>;

// DELETED, and this is the whole list so the next reader does not have to
// re-derive it: `Finding`, `Proof`, `TriageResult` (zero producers and zero
// readers repo-wide), `Confidence`, `ProofKind`, `Capability`, `FocusArea`
// (referenced ONLY from inside that island — verified on the contract's own
// `$ref` graph, where the seven formed a connected component with no external
// edge), and `AttackPathway` (referenced by nothing at all, before or after).
//
// Falsified by an execution probe, not by a grep: the generated Pydantic classes
// were popped off `npmguard.contract.models` and replaced with a module
// `__getattr__` that raises — which fires for `from ... import X` as well as
// `models.X` — and the whole engine suite was run. Zero hits. `cli/` does not
// depend on `@npmguard/shared` at all, and `frontend/` had already deleted its
// own `Capability` copy for the same reason.
//
// `ProofKind` was the last route by which the retired `TEST_CONFIRMED` string
// reached `contract/models.py`; it now appears nowhere executable in the repo.
//
// `Capability`'s live twin is `phases.py`'s own `Capability = Literal[...]`,
// which has readers. One vocabulary declared twice with one copy dead is the
// defect; the better end state is `phases.py` importing the contract's copy, and
// that edit is not available from here.
export const Severity = z.enum(["info", "warn", "critical"]);
export const SeveritySchema = Severity;
export type Severity = z.infer<typeof Severity>;

// ---------------------------------------------------------------------------
// Cross-process data models — sent over SSE or HTTP to non-engine consumers
// ---------------------------------------------------------------------------

// INVARIANT: a WIRE schema expresses nullability as .nullable(), never
// .optional(). events.ts dumps payloads with exclude_none=False, so every
// Optional engine field reaches the wire as an explicit `null` — and
// z.string().optional() accepts `undefined`, not `null`, so .optional() here
// makes parse() throw on real traffic. (This comment used to sit on `FocusArea`,
// which was deleted with the `TriageResult` island; several files cite it by
// name, so it now names `FileVerdict.suspiciousLines` instead — the same rule
// with a field that still has a producer.)

// Built by the engine (pipeline.py) for the file_verdict SSE frame — NOT an LLM
// output schema. See the WIRE nullability invariant above: suspiciousLines is
// `null` for every clean file, so .optional() would throw.
export const FileVerdict = z.object({
  file: z.string(),
  capabilities: z.array(z.string()).default([]),
  suspiciousPatterns: z.array(z.string()).default([]),
  suspiciousLines: z.string().nullable().default(null),
  summary: z.string(),
  riskContribution: z.number().int().min(0).max(10),
});
export const FileVerdictSchema = FileVerdict;
export type FileVerdict = z.infer<typeof FileVerdict>;

// One-line per-file summary emitted by triage MAP. Carried on the report so
// the frontend code-viewer can label files without re-deriving from hypotheses.
export const FileSummary = z.object({
  file: z.string(),
  summary: z.string().default(""),
  capabilities: z.array(z.string()).default([]),
});
export const FileSummarySchema = FileSummary;
export type FileSummary = z.infer<typeof FileSummary>;

// DELETED: `Finding` and `Proof`. Residue of the v1 pipeline's `investigate` /
// `test-gen` / `verify` phases, which no longer exist — the graph's `Hypothesis`
// is the one type, and dynamic proof is a content-addressed `RunArtifact`
// citation (`evidence.ts`), not a free-form `evidence` string with a self-reported
// `confidence`. Deleted rather than kept "in case": a declared wire value with no
// producer forces every exhaustive consumer table to carry an arm no engine can
// ever fill, which is the same rule `errors.py` applies to error codes.

export const FileRecord = z.object({
  path: z.string(),
  fileType: z.string(),
  sizeBytes: z.number(),
  permissions: z.string(),
  isBinary: z.boolean(),
  binaryType: z.string().nullable().default(null),
});
export const FileRecordSchema = FileRecord;
export type FileRecord = z.infer<typeof FileRecord>;

// ---------------------------------------------------------------------------
// Instrumentation — runtime observations captured during sandbox execution.
// Aggregated and exposed at AuditReport level so UI consumers can render
// "what the package actually did" alongside static findings.
// ---------------------------------------------------------------------------

export const NetworkCall = z.object({
  method: z.string(),
  url: z.string(),
  bodyPreview: z.string().default(""),
});
export const NetworkCallSchema = NetworkCall;
export type NetworkCall = z.infer<typeof NetworkCall>;

export const FsOperation = z.object({
  op: z.string(),
  path: z.string(),
  preview: z.string().default(""),
});
export const FsOperationSchema = FsOperation;
export type FsOperation = z.infer<typeof FsOperation>;

export const ProcessSpawn = z.object({
  cmd: z.string(),
  args: z.array(z.string()).default([]),
});
export const ProcessSpawnSchema = ProcessSpawn;
export type ProcessSpawn = z.infer<typeof ProcessSpawn>;

export const EvalCall = z.object({
  code: z.string(),
});
export const EvalCallSchema = EvalCall;
export type EvalCall = z.infer<typeof EvalCall>;

export const CryptoOp = z.object({
  method: z.string(),
  algo: z.string(),
});
export const CryptoOpSchema = CryptoOp;
export type CryptoOp = z.infer<typeof CryptoOp>;

export const TimerRecord = z.object({
  type: z.string(),
  ms: z.number(),
  source: z.string().default(""),
});
export const TimerRecordSchema = TimerRecord;
export type TimerRecord = z.infer<typeof TimerRecord>;

export const InstrumentationLog = z.object({
  modulesLoaded: z.array(z.string()).default([]),
  networkCalls: z.array(NetworkCall).default([]),
  fsOperations: z.array(FsOperation).default([]),
  envAccess: z.array(z.string()).default([]),
  processSpawns: z.array(ProcessSpawn).default([]),
  evalCalls: z.array(EvalCall).default([]),
  cryptoOps: z.array(CryptoOp).default([]),
  timers: z.array(TimerRecord).default([]),
});
export const InstrumentationLogSchema = InstrumentationLog;
export type InstrumentationLog = z.infer<typeof InstrumentationLog>;
