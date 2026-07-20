import { z } from "zod";
import { ERROR_CODE_PATTERN } from "./constants.ts";

/**
 * The one error shape on the wire. `code` is stable forever and is what
 * clients branch on; `retryable` answers the only question every caller has.
 */
export const kitErrorSchema = z.strictObject({
  code: z.string().regex(new RegExp(ERROR_CODE_PATTERN)),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type KitError = z.infer<typeof kitErrorSchema>;

/** HTTP error body: `{ "error": { ... } }`. */
export const errorResponseSchema = z.strictObject({
  error: kitErrorSchema,
});

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
