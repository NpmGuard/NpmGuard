/**
 * The boundary where the wire contract is CHECKED rather than assumed.
 *
 * `getJson<T>()` is a cast: it promises `T` and delivers whatever the engine
 * sent. That cast is the reason the app's wire types were once hand-written
 * "from evidence" in a `lib/engine-types.ts` — someone read the real responses
 * because the declared types had never been confronted with one. Hand-writing
 * forever is not the fix; making the contract *verifiable against reality* is.
 * So every response — panel and audit alike — is `safeParse`d against the same
 * zod schema the engine's Pydantic models are generated from, and drift raises
 * {@link ContractViolationError} here instead of arriving in a component as
 * `undefined`.
 *
 * Two properties this buys that a type alone cannot:
 *
 *  1. A dropped engine field fails LOUD. `PanelRepo` without `defaultBranch`
 *     used to render an empty branch chip; now the region degrades and names
 *     the route that broke.
 *  2. The failure is not retried. Drift is deterministic — the same response
 *     violates the same schema — so `query-client.ts` classifies this error as
 *     terminal (see `retryable`).
 *
 * Schemas are taken structurally rather than as `z.ZodType`, because `zod` is a
 * dependency of `@npmguard/shared` and NOT of the frontend: importing it here
 * would take an undeclared dependency to gain nothing.
 */

import { deleteJson, getJson, postJson } from "./api-base.ts";

type ParseResult<T> = { success: true; data: T } | { success: false; error: unknown };

/** The one thing this module needs from a contract schema. */
export interface WireSchema<T> {
  safeParse(value: unknown): ParseResult<T>;
}

/** A response that does not match its contract. Deliberately NOT an
 * `ApiError`: the request succeeded, so `status` would be 200 and every
 * status-based branch would treat it as a healthy read. */
export class ContractViolationError extends Error {
  /** The route, in terms a support conversation can start from. */
  readonly what: string;
  /** The payload that failed, kept for the console — never for the UI. */
  readonly received: unknown;

  constructor(what: string, issues: string, received: unknown) {
    super(`${what} returned a response that does not match the contract: ${issues}`);
    this.name = "ContractViolationError";
    this.what = what;
    this.received = received;
  }
}

/** Render at most three zod issues as `path: message` — enough to identify the
 * drifted field in a degraded-state detail line, short enough to display. */
function describeIssues(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const shown = issues.slice(0, 3).map((issue) => {
      const { path, message } = issue as { path?: unknown[]; message?: string };
      const where = Array.isArray(path) && path.length > 0 ? path.join(".") : "(root)";
      return `${where}: ${message ?? "invalid"}`;
    });
    return issues.length > 3 ? `${shown.join("; ")} (+${issues.length - 3} more)` : shown.join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export function parseWire<T>(schema: WireSchema<T>, raw: unknown, what: string): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new ContractViolationError(what, describeIssues(result.error), raw);
  return result.data;
}

export async function getWire<T>(url: string, schema: WireSchema<T>, what: string): Promise<T> {
  return parseWire(schema, await getJson<unknown>(url, `${what} failed`), what);
}

export async function postWire<T>(
  url: string,
  schema: WireSchema<T>,
  what: string,
  payload?: unknown,
  fallbackError?: string,
): Promise<T> {
  return parseWire(schema, await postJson<unknown>(url, payload, fallbackError ?? `${what} failed`), what);
}

export async function deleteWire<T>(
  url: string,
  schema: WireSchema<T>,
  what: string,
  fallbackError?: string,
): Promise<T> {
  return parseWire(schema, await deleteJson<unknown>(url, fallbackError ?? `${what} failed`), what);
}
