import { z } from "zod";
import { eventEnvelopeSchema, type EventEnvelope } from "../contract/index.ts";

type EventOf<M extends Record<string, z.ZodType>> = {
  [K in keyof M & string]: Omit<EventEnvelope, "data" | "type"> & {
    type: K;
    data: z.output<M[K]>;
  };
}[keyof M & string];

/**
 * Build a module's event union from payload schemas keyed by event type.
 * Unknown `type` values fail loudly at parse time — never silently ignored.
 */
export function defineEvents<M extends Record<string, z.ZodType>>(
  shapes: M,
): z.ZodType<EventOf<M>> {
  const variants = Object.entries(shapes).map(([type, data]) =>
    eventEnvelopeSchema.extend({ type: z.literal(type), data }),
  );
  const union = z.discriminatedUnion(
    "type",
    variants as [(typeof variants)[number], ...typeof variants],
  );
  return union as unknown as z.ZodType<EventOf<M>>;
}
