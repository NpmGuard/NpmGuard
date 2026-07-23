/**
 * Runtime constants shared across the wire. Exported to Python by
 * `pnpm contract` — never hand-mirrored.
 */

/** One physical HTTP call to one model. Money and failures live here. */
export const ATTEMPT_STATUSES = [
  "ok",
  "timeout",
  "http_error",
  "invalid_output",
  "cancelled",
] as const;

/** One app-level invocation (single call or agentic loop). `running`
 * makes an in-flight run crash-visible; `invalid` = every model in the
 * chain answered but none survived the parser (vs `end_of_rope`:
 * transport-level exhaustion). */
export const RUN_STATUSES = [
  "running",
  "ok",
  "end_of_rope",
  "invalid",
  "budget",
  "loop_cap",
] as const;

export const LLM_CONSTANTS = {
  ATTEMPT_STATUSES,
  RUN_STATUSES,
} as const;
