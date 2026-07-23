import { z } from "zod";
import { TIMESTAMP_PATTERN } from "./constants.ts";

/**
 * Every streamed event travels in this envelope.
 * `seq` is the ordering authority (monotonic per channel); `ts` is
 * producer time, informational only.
 */
export const eventEnvelopeSchema = z.strictObject({
  // max matches the stream_events.type column — SQLite ignores VARCHAR
  // bounds, Postgres enforces them; the contract must reject first.
  type: z.string().min(1).max(200),
  seq: z.int().nonnegative(),
  ts: z.string().regex(new RegExp(TIMESTAMP_PATTERN)),
  data: z.unknown().optional(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
