import { z } from "zod";
import { HypothesisSchema, HypothesisCountsSchema } from "./graph.js";
import { FileRecordSchema, FileSummarySchema, SeveritySchema, VerdictSchema } from "./models.js";

/** Backend-owned shapes that cross an HTTP, SSE, or persistence boundary. */

export const PhaseLogSchema = z.object({
  phase: z.string(),
  durationMs: z.number(),
  input: z.record(z.unknown()).default({}),
  output: z.record(z.unknown()).default({}),
});
export type PhaseLog = z.infer<typeof PhaseLogSchema>;

export const DealBreakerSchema = z.object({
  check: z.string(),
  detail: z.string(),
});
export type DealBreaker = z.infer<typeof DealBreakerSchema>;

export const AuditReportSchema = z.object({
  schemaVersion: z.literal(2).default(2),
  verdict: VerdictSchema,
  rationale: z.string().default(""),
  counts: HypothesisCountsSchema,
  confirmedHypIds: z.array(z.string()).default([]),
  hypotheses: z.array(HypothesisSchema).default([]),
  fileSummaries: z.array(FileSummarySchema).default([]),
  dealbreaker: DealBreakerSchema.nullable().default(null),
  trace: z.array(PhaseLogSchema).default([]),
});
export type AuditReport = z.infer<typeof AuditReportSchema>;

export const ResolvedPackageSchema = z.object({
  path: z.string(),
  needsCleanup: z.boolean().default(false),
  tmpdir: z.string().nullable().default(null),
});
export type ResolvedPackage = z.infer<typeof ResolvedPackageSchema>;

export const InventoryFlagSchema = z.object({
  severity: SeveritySchema,
  check: z.string(),
  detail: z.string(),
  file: z.string().nullable().default(null),
});
export type InventoryFlag = z.infer<typeof InventoryFlagSchema>;

export const EntryPointsSchema = z.object({
  install: z.array(z.string()),
  runtime: z.array(z.string()),
  bin: z.array(z.string()),
});
export type EntryPoints = z.infer<typeof EntryPointsSchema>;

export const PackageMetadataSchema = z.object({
  name: z.string().nullable().default(null),
  version: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  license: z.string().nullable().default(null),
  homepage: z.string().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  repository: z.unknown().default(null),
});
export type PackageMetadata = z.infer<typeof PackageMetadataSchema>;

export const InventoryReportSchema = z.object({
  metadata: PackageMetadataSchema,
  scripts: z.record(z.string()),
  entryPoints: EntryPointsSchema,
  dependencies: z.record(z.record(z.string())),
  files: z.array(FileRecordSchema),
  flags: z.array(InventoryFlagSchema),
  dealbreaker: DealBreakerSchema.nullable().default(null),
});
export type InventoryReport = z.infer<typeof InventoryReportSchema>;
