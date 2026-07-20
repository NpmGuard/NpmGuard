import { errorResponseSchema, type KitError } from "../contract/index.ts";

/**
 * Narrow an unknown response body to a KitError, or null if it isn't one.
 * Branch on `code` and `retryable` — never on message text.
 */
export function parseKitError(body: unknown): KitError | null {
  const parsed = errorResponseSchema.safeParse(body);
  return parsed.success ? parsed.data.error : null;
}

export function isRetryable(error: KitError): boolean {
  return error.retryable;
}
