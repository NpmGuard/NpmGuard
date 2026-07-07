import { z } from "zod";
import { CapabilityEnum, VerdictEnum, ProofKind } from "@npmguard/shared";

// ---------------------------------------------------------------------------
// Cross-cutting types — shared between every bench script and any consumer
// (frontend dashboard, CI report, citation tooling).
// ---------------------------------------------------------------------------

/** The 9 attack classes from METHODOLOGY.md §3. Used as the unit of recall
 *  reporting. Each class groups multiple mutator variants. */
export const AttackClass = z.enum([
  "CREDENTIAL_EXFIL",
  "LIFECYCLE_HOOK_ABUSE",
  "CODE_EXECUTION",
  "NETWORK_EXFIL",
  "WALLET_DRAINER",
  "BUILD_PLUGIN_EXFIL",
  "DATA_DESTRUCTION",
  "DNS_TUNNEL",
  "ANTI_ANALYSIS",
]);
export type AttackClass = z.infer<typeof AttackClass>;

/** Real-world frequency weights from §3, sourced from the Datadog dataset
 *  Q1 2026 snapshot. Used by the analyzer to compute weighted aggregate
 *  recall in addition to the unweighted figure. */
export const ATTACK_CLASS_WEIGHTS: Record<AttackClass, number> = {
  CREDENTIAL_EXFIL: 0.31,
  LIFECYCLE_HOOK_ABUSE: 0.17,
  CODE_EXECUTION: 0.14,
  NETWORK_EXFIL: 0.11,
  WALLET_DRAINER: 0.08,
  ANTI_ANALYSIS: 0.06,
  BUILD_PLUGIN_EXFIL: 0.05,
  DATA_DESTRUCTION: 0.03,
  DNS_TUNNEL: 0.02,
};

/** Difficulty tiers from §5. A mutator that lives at `evasive` is expected
 *  to be hard for any auditor to catch — that's the point of including it. */
export const Difficulty = z.enum(["trivial", "obfuscated", "evasive"]);
export type Difficulty = z.infer<typeof Difficulty>;

// ---------------------------------------------------------------------------
// Seed corpus
// ---------------------------------------------------------------------------

/** A behavioural profile of the unmutated seed. Used by the analyzer to
 *  ask questions like "did recall on env-exfil mutations differ between
 *  packages that already use the network legitimately?". */
export const SeedProfile = z.object({
  network: z.boolean(),
  fs: z.boolean(),
  crypto: z.boolean(),
  spawn: z.boolean(),
  /** Has a postinstall / preinstall / install / prepare script in package.json. */
  lifecycleScripts: z.boolean(),
});
export type SeedProfile = z.infer<typeof SeedProfile>;

/** Hosting form — affects whether runtime instrumentation can hook in. */
export const SeedForm = z.enum(["cjs", "esm", "dual", "native-binding"]);
export type SeedForm = z.infer<typeof SeedForm>;

export const Seed = z.object({
  /** npm package name, exactly as published. */
  name: z.string(),
  /** Exact version pinned for reproducibility. */
  version: z.string(),
  /** SRI string `sha512-<base64>` — populated by the lock script. Empty
   *  initially; the fetcher refuses to proceed if any seed has empty
   *  integrity, forcing an explicit lock pass. */
  integrity: z.string(),
  form: SeedForm,
  profile: SeedProfile,
  /** Free-form tags for slicing the corpus during analysis. */
  tags: z.array(z.string()).default([]),
  description: z.string(),
});
export type Seed = z.infer<typeof Seed>;

export const SeedCatalog = z.array(Seed);
export type SeedCatalog = z.infer<typeof SeedCatalog>;

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

/** The expected verdict and supporting metadata produced by a mutator. The
 *  analyzer compares this against the auditor's actual report. */
export const ExpectedOutcome = z.object({
  verdict: VerdictEnum,
  /** Capabilities that MUST appear in the auditor's report. The auditor may
   *  emit additional capabilities — that doesn't constitute a failure. */
  capabilities: z.array(CapabilityEnum),
  /** Strongest expected proof kind. `TEST_CONFIRMED` indicates we expect
   *  the mutator to produce behaviour reproducible in the sandbox. For
   *  payloads that only manifest under conditions the sandbox doesn't
   *  reproduce (e.g. anti-sandbox guards), `AI_STATIC` is the realistic
   *  ceiling. */
  kind: z.enum(["TEST_CONFIRMED", "AI_DYNAMIC", "AI_STATIC"]),
});
export type ExpectedOutcome = z.infer<typeof ExpectedOutcome>;

/** A single mutator variant — a concrete recipe for transforming one seed
 *  into a malicious copy. A `MutatorClass` groups multiple variants of the
 *  same attack idea (different implementation styles). */
export interface MutatorVariant {
  /** Stable string ID, used in manifests and result files. Lowercase
   *  kebab-case, prefixed by class shorthand. */
  id: string;
  attackClass: AttackClass;
  difficulty: Difficulty;
  /** Brief justification for what makes this variant malicious — written
   *  into the per-mutation README so a reader of a result file understands
   *  the test without reading source. */
  rationale: string;
  /** Predicate gating which seeds this variant can be applied to. Returns
   *  null if applicable, or a string explaining why it's not. */
  appliesTo(seed: Seed): string | null;
  /** Deterministic transformation: copies seedDir to outDir, mutates files
   *  in-place inside outDir. Returns the expected outcome. */
  apply(seedDir: string, outDir: string, seed: Seed): Promise<ExpectedOutcome>;
}

/** A control mutation that should remain SAFE — used to compute the
 *  precision (false-positive rate) of the auditor. */
export interface ControlVariant {
  id: string;
  rationale: string;
  appliesTo(seed: Seed): string | null;
  apply(seedDir: string, outDir: string, seed: Seed): Promise<void>;
}

// ---------------------------------------------------------------------------
// Manifest — the ground-truth file produced by apply-mutations.ts and
// consumed by the audit runner. Re-running the auditor on the same manifest
// must produce statistically equivalent results.
// ---------------------------------------------------------------------------

/** The provenance of a manifest entry. v1 of the benchmark ships
 *  `datadog-compromised` and `datadog-malicious-intent`; v2 adds
 *  `mutated`, `control`, `baseline` per METHODOLOGY.md §13. */
export const EntryCategory = z.union([
  z.literal("datadog-compromised"),
  z.literal("datadog-malicious-intent"),
  AttackClass, // mutated entry tagged by attack class
  z.literal("control"),
  z.literal("baseline"),
]);
export type EntryCategory = z.infer<typeof EntryCategory>;

export const ManifestEntry = z.object({
  /** test-pkg-bench-<source>-<...> — the name passed to NpmGuard's
   *  resolvePackage(), which finds the directory under sandbox/test-fixtures. */
  fixtureName: z.string(),
  /** The original npm package name + version this entry derives from.
   *  For Datadog entries, this is the malicious package as published.
   *  For mutated entries, this is the benign seed before mutation. */
  pkg: z.object({ name: z.string(), version: z.string() }),
  /** Identifier of the source: a Datadog discovery filename, a mutator
   *  variant id, or "baseline". Used to attribute results back to source. */
  sourceId: z.string(),
  category: EntryCategory,
  /** Only set for mutated entries. Null for Datadog and baseline. */
  difficulty: Difficulty.nullable(),
  expected: ExpectedOutcome,
  rationale: z.string(),
  /** Optional Datadog-specific metadata: discovery date, ZIP filename. */
  datadog: z
    .object({
      discoveryDate: z.string(), // YYYY-MM-DD
      zipFilename: z.string(),
    })
    .optional(),
});
export type ManifestEntry = z.infer<typeof ManifestEntry>;

export const Manifest = z.object({
  /** Semver tag of the dataset that produced this manifest. Bumped when
   *  seeds, mutators or controls change. */
  datasetVersion: z.string(),
  /** ISO timestamp of generation. */
  generatedAt: z.string(),
  /** Seeds that were excluded from this run + reasons. Visible coverage. */
  excludedSeeds: z.array(z.object({ name: z.string(), reason: z.string() })),
  /** Mutator/seed combinations that were excluded because the mutated
   *  package failed `verify-loads`. */
  excludedMutations: z.array(
    z.object({ fixtureName: z.string(), reason: z.string() }),
  ),
  entries: z.array(ManifestEntry),
});
export type Manifest = z.infer<typeof Manifest>;

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** The outcome of a single audit invocation. We store enough to recompute
 *  any aggregate without re-querying the engine. */
export const SingleAuditResult = z.object({
  /** Wall-clock duration, milliseconds. */
  durationMs: z.number(),
  verdict: VerdictEnum.nullable(),
  capabilities: z.array(CapabilityEnum).default([]),
  /** Just the proof kinds + capabilities we actually need for analysis —
   *  the full Proof[] is archived separately under reports/. */
  proofKinds: z.array(ProofKind).default([]),
  /** Capabilities that produced a TEST_CONFIRMED proof. Used to compute
   *  per-class verifiability. */
  verifiedCapabilities: z.array(CapabilityEnum).default([]),
  /** Total LLM tokens — sum across all phases. Filled if the engine
   *  exposes this; null otherwise. */
  llmTokens: z.number().nullable().default(null),
  /** Audit ID for archival linking. */
  auditId: z.string().nullable().default(null),
  /** Set when the audit failed entirely (engine error, infra error). */
  error: z.string().nullable().default(null),
});
export type SingleAuditResult = z.infer<typeof SingleAuditResult>;

export const MutationRunResult = z.object({
  fixtureName: z.string(),
  /** Manifest entry used for this fixture. Persisted so consumers can
   *  classify SAFE controls without re-reading the manifest that produced
   *  the run. */
  entry: ManifestEntry.optional(),
  /** N audits — typically 3 for variance characterization. */
  runs: z.array(SingleAuditResult),
});
export type MutationRunResult = z.infer<typeof MutationRunResult>;

export const BenchmarkRun = z.object({
  /** Same datasetVersion as the manifest used. */
  datasetVersion: z.string(),
  /** Engine git commit SHA at time of run. */
  engineSha: z.string(),
  /** LLM model identifier (e.g. "google/gemini-2.5-flash"). */
  modelId: z.string(),
  /** Sandbox docker image digest (sha256:...) used for verify phase. */
  sandboxImageDigest: z.string().nullable().default(null),
  /** N — number of audit runs per mutation. */
  runsPerMutation: z.number().int().min(1),
  startedAt: z.string(),
  completedAt: z.string(),
  results: z.array(MutationRunResult),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRun>;

// ---------------------------------------------------------------------------
// Aggregates — what the analyzer produces from a BenchmarkRun + Manifest
// ---------------------------------------------------------------------------

/** Wilson 95% confidence interval for a binomial proportion. See
 *  METHODOLOGY.md §8. */
export const WilsonCI = z.object({
  estimate: z.number(),
  lower: z.number(),
  upper: z.number(),
  n: z.number().int(),
  successes: z.number().int(),
});
export type WilsonCI = z.infer<typeof WilsonCI>;

export const ClassAggregate = z.object({
  attackClass: AttackClass,
  recall: WilsonCI,
  verifiability: WilsonCI,
  /** Median latency in seconds across all audits in this class. */
  medianLatencySec: z.number(),
  /** p95 latency in seconds. */
  p95LatencySec: z.number(),
});
export type ClassAggregate = z.infer<typeof ClassAggregate>;

export const Summary = z.object({
  datasetVersion: z.string(),
  engineSha: z.string(),
  modelId: z.string(),
  startedAt: z.string(),
  completedAt: z.string(),
  totalAudits: z.number().int(),
  totalCostUsd: z.number().nullable(),
  perClass: z.array(ClassAggregate),
  /** Recall computed across all attack classes, treating each entry equally. */
  unweightedRecall: WilsonCI,
  /** Recall weighted by ATTACK_CLASS_WEIGHTS (real-world frequency). */
  weightedRecall: z.object({
    estimate: z.number(),
    /** Sum of weights actually present in this run (may differ from 1.0
     *  if some classes are absent from the dataset version). */
    weightCovered: z.number(),
  }),
  /** Precision = 1 − FP rate on negative controls. */
  precision: WilsonCI,
});
export type Summary = z.infer<typeof Summary>;
