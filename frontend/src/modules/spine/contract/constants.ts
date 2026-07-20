/**
 * Runtime constants shared across the wire. Exported to Python by
 * `pnpm contract` (see scripts/gen-contract.mts) — never hand-mirrored.
 */
export const ERROR_CODE_PATTERN = "^KIT-\\d{4}$";

/** ISO-8601 with an explicit timezone (Z or offset). Naive timestamps are rejected. */
export const TIMESTAMP_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$";

export const CONSTANTS = {
  ERROR_CODE_PATTERN,
  TIMESTAMP_PATTERN,
} as const;
