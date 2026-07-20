import { z } from "zod";
import { TIMESTAMP_PATTERN } from "../../spine/contract/constants.ts";
import { ATTEMPT_STATUSES, RUN_STATUSES } from "./constants.ts";

/** Token accounting for one attempt. `cost_usd` is null until resolved —
 * some providers only reveal the true price after the fact. */
export const usageSchema = z.strictObject({
  in_tokens: z.int().nonnegative().nullable(),
  out_tokens: z.int().nonnegative().nullable(),
  cached_tokens: z.int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
});

export type Usage = z.infer<typeof usageSchema>;

/** One physical call: the unit billing and debugging are about. Attempts
 * within one (run_id, step) can differ in model (chain advance) AND in
 * messages (a repair retry carries the validation error). */
export const attemptRecordSchema = z.strictObject({
  id: z.string().min(1),
  run_id: z.string().min(1),
  step: z.int().nonnegative(),
  attempt: z.int().nonnegative(),
  model: z.string().nullable(),
  prompt_version: z.int().positive().nullable(),
  prompt_hash: z.string().nullable(),
  messages: z.array(z.record(z.string(), z.unknown())),
  tools: z.array(z.record(z.string(), z.unknown())).nullable(),
  output: z.unknown().nullable(),
  status: z.enum(ATTEMPT_STATUSES),
  error: z.string().nullable(),
  usage: usageSchema,
  provider_call_id: z.string().nullable(),
  latency_ms: z.int().nonnegative(),
  ts: z.string().regex(new RegExp(TIMESTAMP_PATTERN)),
});

export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

/** The run envelope: the "workflow" — which role, for whom, how it ended,
 * what it cost in total. */
export const runRecordSchema = z.strictObject({
  id: z.string().min(1),
  context_kind: z.string().min(1).max(32),
  context_id: z.string().max(64),
  role: z.string().min(1).max(64),
  status: z.enum(RUN_STATUSES),
  steps: z.int().nonnegative(),
  total_cost_usd: z.number().nonnegative().nullable(),
  created_at: z.string().regex(new RegExp(TIMESTAMP_PATTERN)),
  finished_at: z.string().regex(new RegExp(TIMESTAMP_PATTERN)).nullable(),
});

export type RunRecord = z.infer<typeof runRecordSchema>;
